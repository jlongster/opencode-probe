import { mkdir } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { screens, type CaptureId } from "../catalog/authored/screens"
import type { ScreenCategory } from "../catalog/dsl"
import { executeFlow } from "../catalog/flow"
import { patchSuccessFlow } from "../scenarios/tools/patch-success"

type Capture = {
  readonly id: CaptureId
  readonly title: string
  readonly category: ScreenCategory
  readonly frame: {
    readonly variantId: string
    readonly src: string
    readonly cols: number
    readonly rows: number
  }
}

type Variant = {
  readonly id: string
  readonly label: string
  readonly source: string
  readonly revision: string
  readonly path: string
  readonly theme?: string
}

const viewport = { cols: 118, rows: 34 } as const
const defaultOpenCode = fileURLToPath(new URL("../../../../opencode-v2-latest/", import.meta.url))
const variants = await Effect.runPromise(parseVariants(process.argv.slice(2)))

const captureVariant = (variant: Variant) => OpenCodeDriver.use(
  {
    project: { files: { "fixture.txt": "before\n" } },
    config: {
      autoupdate: false,
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
      agents: {
        reviewer: { description: "Reviews deterministic UI fixtures", mode: "primary" },
        researcher: { description: "Explores fixture source code", mode: "subagent" },
      },
    },
    setup:
      variant.theme === undefined
        ? undefined
        : ({ fs }) =>
            fs.writeFile(
              ".opencode/tui.json",
              `${JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: variant.theme }, undefined, 2)}\n`,
            ),
    client: { viewport },
    opencode: { dev: variant.path },
  },
  (driver) =>
    Effect.gen(function* () {
      const captures: Capture[] = []
      const outputDirectory = fileURLToPath(new URL(`../public/captures/${variant.id}/`, import.meta.url))
      yield* Effect.promise(() => mkdir(outputDirectory, { recursive: true }))

      const capture = Effect.fn("Catalog.capture")(function* (id: CaptureId) {
        const screen = screens[id]
        const frame = yield* driver.ui.capture()
        const src = `captures/${variant.id}/${id}.frame.json`
        yield* Effect.promise(() =>
          Bun.write(
            new URL(`../public/${src}`, import.meta.url),
            `${JSON.stringify({ format: "opencode-terminal-frame-v1", ...frame })}\n`,
          ),
        )
        captures.push({
          id,
          title: screen.title,
          category: screen.category,
          frame: { variantId: variant.id, src, cols: frame.cols, rows: frame.rows },
        })
      })

      const close = Effect.fn("Catalog.closeDialog")(function* () {
        yield* driver.ui.press("\u001b")
        yield* Effect.sleep(150)
      })

      const openSlash = Effect.fn("Catalog.openSlash")(function* (
        slash: string,
        marker: string,
      ) {
        yield* driver.ui.submit(slash)
        yield* driver.ui.waitFor(marker)
      })

      yield* driver.ui.waitFor((state) => state.elements.length > 0)
      yield* Effect.sleep(400)
      yield* capture("home")

      yield* driver.ui.press("p", { ctrl: true })
      yield* driver.ui.waitFor("Commands")
      yield* capture("command-palette")
      yield* close()

      const dialogs = [
        ["/models", "Select model", "model-picker"],
        ["/agents", "Select agent", "agent-picker"],
        ["/connect", "Connect a service", "integration-picker"],
        ["/themes", "Themes", "theme-picker"],
        ["/mcps", "MCP servers", "mcp-list"],
        ["/status", "No MCP servers", "status"],
        ["/debug", "Debug", "debug"],
        ["/help", "Press ctrl+p", "help"],
        ["/pair", "Pair", "pair"],
        ["/sessions", "Sessions", "session-picker"],
        ["/skills", "Skills", "skill-picker"],
      ] as const

      for (const [slash, marker, id] of dialogs) {
        yield* openSlash(slash, marker)
        yield* capture(id)
        yield* close()
      }

      yield* executeFlow(patchSuccessFlow, {
        driver,
        capture: (state) => capture(state.id),
      })

      const sessionDialogs = [
        ["/rename", "Rename session", "session-rename"],
        ["/fork", "Full session", "session-fork"],
        ["/export", "Export as", "session-export"],
      ] as const

      for (const [slash, marker, id] of sessionDialogs) {
        yield* openSlash(slash, marker)
        yield* capture(id)
        yield* close()
      }

      yield* driver.llm.queue(
        Llm.toolCall({
          index: 0,
          id: "call_question_capture",
          name: "question",
          input: {
            questions: [
              {
                question: "Which direction should the fixture take?",
                header: "Fixture",
                options: [
                  {
                    label: "Keep it minimal (Recommended)",
                    description: "Small deterministic fixture",
                  },
                  {
                    label: "Expand coverage",
                    description: "Add more scripted states",
                  },
                ],
              },
            ],
          },
        }),
        Llm.finish("tool-calls"),
      )
      yield* driver.llm.queue(Llm.text("Keeping the fixture minimal."))
      yield* driver.ui.submit("Ask me about the fixture direction.")
      yield* driver.ui.waitFor("Permission required", { timeout: 15_000 })
      yield* driver.ui.enter()
      yield* driver.ui.waitFor("Which direction should the fixture take?", { timeout: 15_000 })
      yield* capture("question-prompt")
      yield* driver.ui.enter()
      yield* driver.ui.waitFor("Keeping the fixture minimal.", { timeout: 15_000 })

      yield* openSlash("/rename", "Rename session")
      yield* driver.ui.type("Catalog capture session")
      yield* driver.ui.enter()
      yield* Effect.sleep(300)

      yield* openSlash("/sessions", "Sessions")
      yield* driver.ui.waitFor("Catalog capture session")
      yield* capture("session-picker-populated")
      yield* close()

      yield* driver.ui.type("/copy")
      yield* driver.ui.waitFor("Copy session transcript")
      yield* driver.ui.enter()
      yield* Effect.sleep(600)
      yield* capture("toast-success")
      yield* Effect.sleep(200)

      yield* openSlash("/diff", "Diff working tree")
      yield* driver.ui.waitFor("No changes to show")
      yield* capture("diff-viewer")

      return captures
    }),
)

const captured = await Effect.runPromise(
  Effect.forEach(variants, captureVariant, { concurrency: Math.min(variants.length, 2) }),
)
const captures = captured[0]?.map((first) => ({
  id: first.id,
  title: first.title,
  category: first.category,
  frames: captured.flatMap((variantCaptures) =>
    variantCaptures.filter((capture) => capture.id === first.id).map((capture) => capture.frame),
  ),
})) ?? []
await Bun.write(
  new URL("../public/drive-captures.json", import.meta.url),
  `${JSON.stringify(
    {
      format: "opencode-terminal-frame-captures-v1",
      generatedBy: "scripts/capture-opencode-drive.ts",
      variants: variants.map(({ id, label, source, revision, theme }) => ({
        id,
        label,
        source,
        revision,
        ...(theme === undefined ? {} : { theme }),
      })),
      captures,
    },
    undefined,
    2,
  )}\n`,
)

function parseVariants(args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const values: Array<string> = []
    const themes = new Map<string, string>()
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--theme") {
        const value = args[++index]
        if (!value) return yield* Effect.fail(new Error("--theme requires variant=theme"))
        const separator = value.indexOf("=")
        if (separator <= 0 || separator === value.length - 1) {
          return yield* Effect.fail(new Error(`Invalid theme ${JSON.stringify(value)}; expected variant=theme`))
        }
        themes.set(value.slice(0, separator), value.slice(separator + 1))
        continue
      }
      if (args[index] !== "--variant") {
        return yield* Effect.fail(new Error(`Unknown capture argument: ${args[index]}`))
      }
      const value = args[++index]
      if (!value) return yield* Effect.fail(new Error("--variant requires name=path"))
      values.push(value)
    }
    if (values.length === 0) values.push(`v2=${defaultOpenCode}`)
    return yield* Effect.forEach(values, (value) =>
      Effect.gen(function* () {
        const separator = value.indexOf("=")
        const id = separator === -1 ? "" : value.slice(0, separator)
        const source = resolve(separator === -1 ? "" : value.slice(separator + 1))
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || separator === value.length - 1) {
          return yield* Effect.fail(new Error(`Invalid variant ${JSON.stringify(value)}; expected slug=path`))
        }
        const revision = yield* Effect.tryPromise({
          try: async () => {
            const process = Bun.spawn(["git", "rev-parse", "--short=12", "HEAD"], {
              cwd: source,
              stdout: "pipe",
              stderr: "ignore",
            })
            const output = await new Response(process.stdout).text()
            return (await process.exited) === 0 ? output.trim() : "working-tree"
          },
          catch: () => "working-tree",
        }).pipe(Effect.catch(() => Effect.succeed("working-tree")))
        return {
          id,
          label: id,
          source: basename(source),
          revision,
          path: source,
          ...(themes.get(id) === undefined ? {} : { theme: themes.get(id) }),
        } satisfies Variant
      }),
    )
  })
}

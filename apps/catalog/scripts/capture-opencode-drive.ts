import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { screens, type CaptureId } from "../catalog/authored/screens"
import type { NonEmpty, ScreenCategory } from "../catalog/dsl"
import { executeFlow, type ExecutableFlow, type FlowState } from "../catalog/flow"
import { patchSuccessFlow } from "../scenarios/tools/patch-success"
import { shellLifecycleFlow } from "../scenarios/tools/shell-lifecycle"
import { subagentLifecycleFlow } from "../scenarios/subagents/subagent-lifecycle"
import { catalogScenarioRuntime } from "../scenarios/runtime"
import type { DriveManifest, Variant as CaptureSet } from "../catalog/schema"
import {
  captureSetId,
  captureSetLabel,
  captureSource,
  mergeCaptureHistory,
  parseCaptureOptions,
} from "./capture-sets"

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
  readonly ref: string
  readonly committedAt: string
  readonly path: string
  readonly theme?: string
}

const defaultOpenCode = fileURLToPath(new URL("../../../../opencode-v2-latest/", import.meta.url))
const options = parseCaptureOptions(process.argv.slice(2), defaultOpenCode)
const prepared = await prepareCaptureSets(options)
const variants = prepared.variants

const captureVariant = (variant: Variant) => Effect.gen(function* () {
  const baseline = yield* captureBaseline(variant)
  const shell = yield* captureFlow(variant, shellLifecycleFlow)
  const subagent = yield* captureFlow(variant, subagentLifecycleFlow)
  return [...baseline, ...shell, ...subagent]
})

const captureBaseline = (variant: Variant) => OpenCodeDriver.use(
  catalogScenarioRuntime({ opencode: variant.path, theme: variant.theme }),
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
      yield* close()

      return captures
    }),
)

function captureFlow<
  FlowId extends string,
  States extends NonEmpty<FlowState<FlowId, CaptureId>>,
  Error,
>(variant: Variant, flow: ExecutableFlow<FlowId, States, Error, never>) {
  return OpenCodeDriver.use(
    catalogScenarioRuntime({ opencode: variant.path, theme: variant.theme }),
    (driver) => Effect.gen(function* () {
      const captures: Array<Capture> = []
      yield* executeFlow(flow, {
        driver,
        capture: (state) => Effect.gen(function* () {
          const screen = screens[state.id]
          const frame = yield* driver.ui.capture()
          const src = `captures/${variant.id}/${state.id}.frame.json`
          yield* Effect.promise(() =>
            Bun.write(
              new URL(`../public/${src}`, import.meta.url),
              `${JSON.stringify({ format: "opencode-terminal-frame-v1", ...frame })}\n`,
            ),
          )
          captures.push({
            id: state.id,
            title: screen.title,
            category: screen.category,
            frame: { variantId: variant.id, src, cols: frame.cols, rows: frame.rows },
          })
        }),
      })
      return captures
    }),
  )
}

try {
  const captured = await Effect.runPromise(
    Effect.forEach(variants, captureVariant, { concurrency: Math.min(variants.length, 2) }),
  )
  const captures = captured[0]?.map((first) => ({
    id: first.id,
    title: first.title,
    category: first.category,
    frames: captured.flatMap((variantCaptures) =>
      variantCaptures.filter((capture) => capture.id === first.id).map((capture) => capture.frame),
    ) as [Capture["frame"], ...Array<Capture["frame"]>],
  })) ?? []
  const manifestFile = new URL("../public/drive-captures.json", import.meta.url)
  const previous = await readPreviousManifest(manifestFile)
  const captureSets = variants.map(({ path: _, ...variant }) => variant satisfies CaptureSet)
  const manifest = mergeCaptureHistory(previous, captureSets, captures)
  await Bun.write(manifestFile, `${JSON.stringify(manifest, undefined, 2)}\n`)
} finally {
  await prepared.cleanup()
}

async function prepareCaptureSets(options: ReturnType<typeof parseCaptureOptions>) {
  const worktrees: Array<string> = []
  const variants: Array<Variant> = []
  const revisions = new Map<string, { ref: string; committedAt: string; path: string }>()

  try {
    for (const ref of options.revisions) {
      const revision = await git(options.opencode, "rev-parse", `${ref}^{commit}`)
      if (revisions.has(revision)) continue
      const committedAt = await git(options.opencode, "show", "-s", "--format=%cI", revision)
      const path = await mkdtemp(join(tmpdir(), "opencode-catalog-"))
      await command(["git", "worktree", "add", "--detach", path, revision], options.opencode)
      worktrees.push(path)
      await command(["bun", "install", "--frozen-lockfile"], path)
      revisions.set(revision, { ref, committedAt, path })
    }

    for (const [revision, preparedRevision] of revisions) {
      for (const theme of options.themes) {
        variants.push({
          id: captureSetId(revision, theme),
          label: captureSetLabel(revision, theme),
          source: captureSource(options.opencode),
          revision,
          ref: preparedRevision.ref,
          committedAt: preparedRevision.committedAt,
          path: preparedRevision.path,
          ...(theme === undefined ? {} : { theme }),
        })
      }
    }
  } catch (error) {
    await cleanup()
    throw error
  }

  return { variants, cleanup }

  async function cleanup() {
    for (const path of worktrees.reverse()) {
      await command(["git", "worktree", "remove", "--force", path], options.opencode).catch(() => rm(path, { recursive: true, force: true }))
    }
  }
}

async function readPreviousManifest(file: URL): Promise<DriveManifest | undefined> {
  const source = Bun.file(file)
  return (await source.exists()) ? source.json() as Promise<DriveManifest> : undefined
}

async function git(cwd: string, ...args: ReadonlyArray<string>): Promise<string> {
  return (await command(["git", ...args], cwd)).trim()
}

async function command(argv: ReadonlyArray<string>, cwd: string): Promise<string> {
  const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "inherit" })
  const output = await new Response(process.stdout).text()
  if (await process.exited !== 0) throw new Error(`${argv.join(" ")} failed`)
  return output
}

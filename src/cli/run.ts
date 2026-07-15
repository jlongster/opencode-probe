import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import { prepareScriptTooling } from "../script/tooling.js"

export const runProgram = Effect.fn("Cli.runProgram")((file: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => prepareProgram(resolve(file)),
      catch: (cause) => cause,
    }),
    ({ file }) =>
      Effect.gen(function* () {
        const module = yield* Effect.tryPromise({
          try: () => import(pathToFileURL(file).href),
          catch: (cause) => cause,
        })
        if (!Effect.isEffect(module.default))
          return yield* Effect.fail(
            new Error("program must default-export a fully provided Effect"),
          )
        return yield* module.default
      }),
    ({ remove }) => Effect.promise(remove),
  ),
)

async function prepareProgram(file: string) {
  const artifacts = await mkdtemp(join(tmpdir(), "opencode-drive-run-"))
  const contract = join(artifacts, "program-contract.ts")
  let links: Awaited<ReturnType<typeof prepareScriptTooling>>["links"] | undefined
  try {
    await Bun.write(
      contract,
      [
        'import type * as Effect from "effect/Effect"',
        `import program from ${JSON.stringify(file)}`,
        "const contract: Effect.Effect<unknown, unknown, never> = program",
        "void contract",
        "",
      ].join("\n"),
    )
    const tooling = await prepareScriptTooling(artifacts, contract, file)
    links = tooling.links
    const child = Bun.spawn([tooling.tsgo, "-p", tooling.tsconfig], {
      cwd: artifacts,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    })
    const status = await child.exited
    if (status !== 0)
      throw new Error(`program type check failed with status ${status}`)
    return {
      file,
      remove: async () => {
        await links?.remove()
        await rm(artifacts, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await links?.remove()
    await rm(artifacts, { recursive: true, force: true })
    throw error
  }
}

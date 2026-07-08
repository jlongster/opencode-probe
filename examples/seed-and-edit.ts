import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  defineScript,
  type ScriptSetupContext,
} from "../src/index.js"

let directory: string

export async function setup(context: ScriptSetupContext) {
  directory = context.directory
  await mkdir(join(directory, "src"), { recursive: true })
  await mkdir(join(directory, "docs"), { recursive: true })
  await Promise.all([
    Bun.write(
      join(directory, "src", "settings.ts"),
      "export const settings = {\n  timeout: 5000,\n  retries: 3,\n}\n",
    ),
    Bun.write(
      join(directory, "src", "server.ts"),
      'import { settings } from "./settings.js"\n\nexport const timeout = settings.timeout\n',
    ),
    Bun.write(
      join(directory, "src", "server.test.ts"),
      'import { expect, test } from "bun:test"\nimport { timeout } from "./server.js"\n\ntest("timeout", () => expect(timeout).toBe(5000))\n',
    ),
    Bun.write(
      join(directory, "docs", "configuration.md"),
      "# Configuration\n\nThe server timeout is configured in `src/settings.ts`.\n",
    ),
    Bun.write(join(directory, "README.md"), "# Seeded project\n"),
  ])
  await command(["git", "init", "--quiet"], directory)
  await command(["git", "add", "."], directory)
  await command(
    [
      "git",
      "-c",
      "user.name=OpenCode Drive",
      "-c",
      "user.email=drive@example.test",
      "commit",
      "--quiet",
      "-m",
      "Seed project",
    ],
    directory,
  )
}

export default defineScript(async ({ ui, backend }) => {
  const edited = deferred()
  let exchange = 0

  await backend.attach(async (request) => {
    if (isTitleRequest(request.body)) {
      await backend.chunk(request.id, [
        { type: "textDelta", text: "Increase server timeout" },
      ])
      await backend.finish(request.id)
      return
    }

    const current = exchange++
    if (current === 0) {
      await backend.chunk(request.id, [
        {
          type: "toolCall",
          index: 0,
          id: "call_patch_settings",
          name: "patch",
          input: {
            patchText:
              "*** Begin Patch\n*** Update File: src/settings.ts\n@@\n-  timeout: 5000,\n+  timeout: 10000,\n*** End Patch",
          },
        },
      ])
      await backend.finish(request.id, "tool-calls")
      return
    }

    if (current === 1) {
      await backend.chunk(request.id, [
        {
          type: "toolCall",
          index: 0,
          id: "call_diff_settings",
          name: "shell",
          input: {
            command: "git diff -- src/settings.ts",
            description: "Show the settings change",
          },
        },
      ])
      await backend.finish(request.id, "tool-calls")
      return
    }

    const diff = lastToolOutput(request.body)
    if (!diff.includes("-  timeout: 5000,") || !diff.includes("+  timeout: 10000,"))
      throw new Error(`unexpected git diff output: ${diff}`)
    console.log(diff)

    await backend.chunk(request.id, [
      { type: "textDelta", text: "Updated the server timeout to 10 seconds." },
    ])
    await backend.finish(request.id)
    edited.resolve()
  })

  await ui.typeText("Change the server timeout from 5000 to 10000 milliseconds.")
  await ui.pressEnter()
  await waitFor(edited.promise)
})

async function command(args: string[], cwd: string) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (status !== 0)
    throw new Error(`${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout.trim()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(promise: Promise<void>) {
  const completed = await Promise.race([
    promise.then(() => true),
    Bun.sleep(30_000).then(() => false),
  ])
  if (!completed) throw new Error("timed out waiting for the edit tool")
}

function isTitleRequest(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body))
    return false
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "content" in message &&
      typeof message.content === "string" &&
      message.content.includes("You are a title generator"),
  )
}

function lastToolOutput(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body))
    return ""
  const messages = body.messages
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "tool" &&
      "content" in message &&
      typeof message.content === "string"
    )
      return message.content
  }
  return ""
}

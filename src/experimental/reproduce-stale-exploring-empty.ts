import { join } from "node:path"
import { defineScript } from "../index.js"

export default defineScript(async ({ artifacts, backend, ui }) => {
  const completed = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  let turn = 0

  await backend.attach(async (request) => {
    if (isTitleRequest(request.body)) {
      await backend.chunk(request.id, [{ type: "textDelta", text: "Stale exploring reproduction" }])
      await backend.finish(request.id)
      return
    }
    const current = turn++
    if (current === 0) {
      await backend.chunk(request.id, [
        {
          type: "toolCall",
          index: 0,
          id: "call_read",
          name: "read",
          input: { filePath: join(artifacts, "files", "src", "garden.js") },
        },
      ])
      await backend.finish(request.id, "tool-calls")
      return
    }
    if (current === 1) {
      await backend.finish(request.id, "tool-calls")
      completed[0]?.resolve()
      return
    }
    const response = current === 2 ? "The file exports a small greeting function." : "Confirmed again with no more tools."
    await backend.chunk(request.id, [{ type: "textDelta", text: response }])
    await backend.finish(request.id)
    completed[current - 1]?.resolve()
  })

  const prompts = [
    "Read src/garden.js, then tell me what it contains.",
    "Now inspect that file one more time.",
    "Finally, verify the same file again.",
  ]
  for (const [index, prompt] of prompts.entries()) {
    if (index === 0) await ui.typeText(prompt)
    else await typeSlowly(ui, prompt)
    await ui.pressEnter()
    await withTimeout(
      completed[index]!.promise,
      30_000,
      `timed out waiting for empty continuation ${index + 1}`,
    )
    await waitForEditor(ui)
    await Bun.sleep(500)
    await ui.screenshot(`stale-exploring-${index + 1}`)
  }
})

async function withTimeout(promise: Promise<void>, timeout: number, message: string) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error(message)), timeout)
  try {
    await Promise.race([promise, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

async function typeSlowly(
  ui: Parameters<Parameters<typeof defineScript>[0]>[0]["ui"],
  text: string,
) {
  for (const char of text) {
    await ui.typeText(char)
    await Bun.sleep(55)
  }
}

async function waitForEditor(
  ui: Parameters<Parameters<typeof defineScript>[0]>[0]["ui"],
) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await ui.state()).focused.editor) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for the session to become idle")
}

function isTitleRequest(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body)) return false
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

import { join } from "node:path"
import { defineScript } from "../index.js"
import type { ScriptUi } from "../index.js"

export default defineScript({
  async run({ artifacts, llm, ui }) {
    const completed = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    let turn = 0

    llm.serve(async function* (request) {
      if (isTitleRequest(request.body)) {
        yield llm.text("Stale exploring reproduction")
        return
      }
      const current = turn++
      if (current === 0) {
        yield llm.toolCall({
          index: 0,
          id: "call_read",
          name: "read",
          input: { filePath: join(artifacts, "files", "src", "garden.js") },
        })
        yield llm.finish("tool-calls")
        return
      }
      if (current === 1) {
        yield llm.finish("tool-calls")
        completed[0]?.resolve()
        return
      }
      yield llm.text(
        current === 2
          ? "The file exports a small greeting function."
          : "Confirmed again with no more tools.",
      )
      completed[current - 1]?.resolve()
    })

    const prompts = [
      "Read src/garden.js, then tell me what it contains.",
      "Now inspect that file one more time.",
      "Finally, verify the same file again.",
    ]
    for (const [index, prompt] of prompts.entries()) {
      if (index === 0) await ui.type(prompt)
      else await typeSlowly(ui, prompt)
      await ui.enter()
      await withTimeout(
        completed[index]!.promise,
        30_000,
        `timed out waiting for empty continuation ${index + 1}`,
      )
      await waitForEditor(ui)
      await Bun.sleep(500)
      await ui.screenshot(`stale-exploring-${index + 1}`)
    }
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
  ui: ScriptUi,
  text: string,
) {
  for (const char of text) {
    await ui.type(char)
    await Bun.sleep(55)
  }
}

async function waitForEditor(
  ui: ScriptUi,
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
  const first = messages.find(isMessage)
  if (first?.role === "user" && messageContent(first)?.startsWith("Generate a title for this conversation:")) return true
  return messages.some((message) => messageContent(message)?.includes("You are a title generator"))
}

function isMessage(value: unknown): value is { readonly role?: unknown; readonly content?: unknown } {
  return typeof value === "object" && value !== null && "content" in value
}

function messageContent(message: unknown): string | undefined {
  if (!isMessage(message)) return undefined
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return undefined
  return message.content
    .map((part) => {
      if (typeof part === "string") return part
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return part.text
      return ""
    })
    .join("")
}

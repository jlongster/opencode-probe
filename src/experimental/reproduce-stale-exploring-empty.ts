import { join } from "node:path"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { defineScript } from "../index.js"
import type { ScriptUi } from "../index.js"

export default defineScript({
  run: ({ artifacts, llm, ui }) =>
    Effect.gen(function* () {
      const completed = yield* Effect.forEach(
        Array.from({ length: 3 }),
        () => Deferred.make<void>(),
      )
      let turn = 0

      yield* llm.serve((request) => {
        if (isTitleRequest(request.body)) {
          return Stream.make(llm.text("Stale exploring reproduction"))
        }
        const current = turn++
        if (current === 0) {
          return Stream.make(
            llm.toolCall({
              index: 0,
              id: "call_read",
              name: "read",
              input: { filePath: join(artifacts, "files", "src", "garden.js") },
            }),
            llm.finish("tool-calls"),
          )
        }
        if (current === 1) {
          return Stream.make(llm.finish("tool-calls")).pipe(
            Stream.onEnd(Deferred.succeed(completed[0]!, undefined)),
          )
        }
        return Stream.make(
          llm.text(
            current === 2
              ? "The file exports a small greeting function."
              : "Confirmed again with no more tools.",
          ),
        ).pipe(
          Stream.onEnd(Deferred.succeed(completed[current - 1]!, undefined)),
        )
      })

      const prompts = [
        "Read src/garden.js, then tell me what it contains.",
        "Now inspect that file one more time.",
        "Finally, verify the same file again.",
      ]
      for (const [index, prompt] of prompts.entries()) {
        if (index === 0) yield* ui.type(prompt)
        else yield* typeSlowly(ui, prompt)
        yield* ui.enter()
        yield* withTimeout(
          Deferred.await(completed[index]!),
          30_000,
          `timed out waiting for empty continuation ${index + 1}`,
        )
        yield* waitForEditor(ui)
        yield* Effect.sleep(500)
        yield* ui.screenshot(`stale-exploring-${index + 1}`)
      }
    }),
})

function withTimeout(
  effect: Effect.Effect<void>,
  timeout: number,
  message: string,
) {
  return Effect.timeoutOrElse(effect, {
    duration: timeout,
    orElse: () => Effect.fail(new Error(message)),
  })
}

const typeSlowly = Effect.fn("typeSlowly")(function* (
  ui: ScriptUi,
  text: string,
) {
  for (const char of text) {
    yield* ui.type(char)
    yield* Effect.sleep(55)
  }
})

const waitForEditor = Effect.fn("waitForEditor")(function* (ui: ScriptUi) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((yield* ui.state()).focused.editor) return
    yield* Effect.sleep(50)
  }
  return yield* Effect.fail(
    new Error("timed out waiting for the session to become idle"),
  )
})

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

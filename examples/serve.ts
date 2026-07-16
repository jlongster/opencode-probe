import { Effect, Stream } from "effect"
import { defineScript, Llm } from "opencode-drive"

export default defineScript({
  setup: ({ fs }) =>
    Effect.gen(function* () {
      yield* fs.writeFile(
        "src/greeting.ts",
        [
          "export function greeting(name: string) {",
          '  return `Welcome, ${name}!`',
          "}",
          "",
        ].join("\n"),
      )
    }),

  run: ({ llm, ui }) =>
    Effect.gen(function* () {
      let turn = 0

      yield* llm.serve((request) => {
        if (isTitleRequest(request.body))
          return Stream.make(Llm.text("Understanding the greeting"))

        if (turn++ === 0)
          return Stream.make(
            Llm.reasoning(
              "I should read the implementation before explaining it.",
            ),
            Llm.toolCall({
              index: 0,
              id: "call_read_greeting",
              name: "read",
              input: { filePath: "src/greeting.ts" },
            }),
            Llm.finish("tool-calls"),
          )

        return Stream.make(
          Llm.text("The function accepts a name, "),
          Llm.pause(150),
          Llm.text("places it into a welcome message, "),
          Llm.pause(150),
          Llm.text("and adds an exclamation mark."),
          Llm.pause(150),
          Llm.finish("stop"),
        )
      })

      yield* ui.submit("Read src/greeting.ts and explain what it does.")
      yield* ui.waitFor("adds an exclamation mark")
    }),
})

function isTitleRequest(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body))
    return false
  const messages = body.messages
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "content" in message &&
        typeof message.content === "string" &&
        message.content.includes("You are a title generator"),
    )
  )
}

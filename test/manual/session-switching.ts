import { defineScript, type ScriptUi } from "../../src/index.js"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

export default defineScript({
  setup: ({ fs }) =>
    Effect.gen(function* () {
      yield* fs.writeFile(
        "src/garden.ts",
        [
          "export const flowers = [\"aster\", \"dahlia\", \"iris\"]",
          "export const count = flowers.length",
          "",
        ].join("\n"),
      )
    }),

  run: ({ llm, ui }) =>
    Effect.gen(function* () {
      let phase = 0
      let title = 0

      yield* llm.serve((request) => {
        if (isTitleRequest(request.body)) {
          return Stream.make(
            llm.text(title++ === 0 ? "Garden inventory" : "Project follow-up"),
          )
        }

        if (phase === 0) {
          phase++
          return Stream.make(
            llm.reasoning("I should read the source before answering."),
            llm.toolCall({
              index: 0,
              id: "call_read_garden",
              name: "read",
              input: { filePath: "src/garden.ts" },
            }),
            llm.finish("tool-calls"),
          )
        }
        if (phase === 1) {
          phase++
          return Stream.make(
            llm.text(
              "Session one complete: the garden contains aster, dahlia, and iris.",
            ),
          )
        }
        if (phase === 2) {
          phase++
          return Stream.make(
            llm.reasoning("I will search for the exported count."),
            llm.toolCall({
              index: 0,
              id: "call_grep_count",
              name: "grep",
              input: { pattern: "count", path: "src", include: "*.ts" },
            }),
            llm.finish("tool-calls"),
          )
        }
        if (phase === 3) {
          phase++
          return Stream.make(
            llm.text(
              "Session two complete: the project exports count from src/garden.ts.",
            ),
          )
        }

        return Stream.make(
          llm.text("Back in session one: there are exactly three flowers."),
        )
      })

      yield* ui.submit("Read src/garden.ts and list every flower.")
      yield* ui.waitFor("Session one complete", { timeout: 20_000 })
      yield* ui.screenshot("sessions-first")

      yield* leader(ui, "n")
      yield* ui.waitFor((state) => state.focused.editor)
      yield* ui.submit("Find where the project exports count.")
      yield* ui.waitFor("Session two complete", { timeout: 20_000 })
      yield* ui.screenshot("sessions-second")

      yield* leader(ui, "l")
      yield* ui.waitFor("Sessions")
      yield* ui.arrow("down")
      yield* ui.enter()
      yield* ui.waitFor("Session one complete")

      yield* ui.submit("How many flowers were there?")
      yield* ui.waitFor("exactly three flowers", { timeout: 20_000 })
      yield* ui.screenshot("sessions-returned")
    }),
})

const leader = Effect.fn("leader")(function* (
  ui: ScriptUi,
  key: string,
) {
  yield* ui.press("x", { ctrl: true })
  yield* ui.press(key)
})

function isTitleRequest(body: unknown) {
  return JSON.stringify(body).includes("title generator")
}

import { defineScript } from "../../src/index.js"
import * as Effect from "effect/Effect"

export default defineScript({
  launch: "manual",
  run: ({ server, llm }) =>
    Effect.gen(function* () {
      yield* llm.title(() => Effect.succeed("Custom title"))
      yield* server.launch()
      yield* llm.send(llm.text("Normal response"))
    }),
})

import { defineScript, wait } from "../../src/index.js"
import * as Effect from "effect/Effect"

export default defineScript({
  run: ({ ui }) =>
    Effect.gen(function* () {
      yield* Effect.matchEffect(
        ui.waitFor("this text never appears", { timeout: 50 }),
        {
          onFailure: () => wait(30_000),
          onSuccess: Effect.succeed,
        },
      )
    }),
})

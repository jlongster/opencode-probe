import { defineScript } from "opencode-drive"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"

export default defineScript({
  run: ({ ui }) =>
    Effect.gen(function* () {
      yield* Effect.exit(ui.kill())
      const closed = Exit.isFailure(yield* Effect.exit(ui.state()))
      if (!closed)
        yield* Effect.fail(
          new Error("primary client remained connected after ui.kill()"),
        )
    }),
})

import { defineScript } from "../../src/index.js"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

export default defineScript({
  run: ({ llm }) =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>()
      yield* llm.serve(() =>
        Stream.make(
          llm.reasoning("thinking", { delay: 0, chunkSize: 2 }),
          llm.pause(1),
          llm.text("served response"),
          llm.finish("length"),
        ).pipe(Stream.onEnd(Deferred.succeed(completed, undefined))),
      )
      yield* Deferred.await(completed)
    }),
})

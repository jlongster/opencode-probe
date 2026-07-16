import { defineScript } from "../../src/index.js"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

export default defineScript({
  run: ({ artifacts, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve(() =>
        Stream.fromEffect(
          Effect.sleep(500).pipe(Effect.as(llm.text("late response"))),
        ),
      )
      const file = `${artifacts}/script-runs.txt`
      const previous = yield* Effect.promise(() =>
        Bun.file(file).text().catch(() => ""),
      )
      yield* Effect.tryPromise(() => Bun.write(file, `${previous}run\n`))
      yield* Effect.never
    }),
})

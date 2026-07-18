import type { Ui } from "../../../src/index.js"
import { Effect, Exit, Random } from "effect"

export interface Context {
  readonly ui: Ui
  readonly artifacts: string
}

export interface Transition<Observation> {
  readonly name: string
  readonly run: (step: number) => Effect.Effect<Observation, unknown>
}

export interface Invariant<Observation> {
  readonly name: string
  readonly check: (observation: Observation) => Effect.Effect<void, unknown>
}

export function run<Observation>(options: {
  readonly context: Context
  readonly seed: number
  readonly steps: number
  readonly transitions: ReadonlyArray<Transition<Observation>>
  readonly invariants: ReadonlyArray<Invariant<Observation>>
}) {
  return Effect.gen(function* () {
    if (options.transitions.length === 0)
      return yield* Effect.fail(new Error("state machine has no transitions"))
    const trace: Array<{ step: number; transition: string }> = []

    for (let step = 0; step < options.steps; step++) {
      const transition = yield* Random.choice(options.transitions)
      trace.push({ step, transition: transition.name })
      let invariant: string | undefined
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const observation = yield* transition.run(step)
          for (const current of options.invariants) {
            invariant = current.name
            yield* current.check(observation)
          }
        }),
      )
      if (Exit.isSuccess(result)) continue

      const path = `${options.context.artifacts}/state-machine-failure.json`
      yield* Effect.gen(function* () {
        const frame = yield* options.context.ui.capture().pipe(Effect.option)
        yield* Effect.tryPromise(() =>
          Bun.write(
            path,
            JSON.stringify(
              {
                seed: options.seed,
                steps: options.steps,
                failedAt: step,
                transition: transition.name,
                invariant,
                trace,
                frame: frame._tag === "Some" ? frame.value : undefined,
              },
              null,
              2,
            ),
          ),
        )
      }).pipe(Effect.ignore)
      console.error(
        JSON.stringify({ seed: options.seed, step, transition: transition.name, invariant, artifact: path }),
      )
      return yield* Effect.failCause(result.cause)
    }

    console.log(JSON.stringify({ seed: options.seed, steps: options.steps }))
  }).pipe(Random.withSeed(options.seed))
}

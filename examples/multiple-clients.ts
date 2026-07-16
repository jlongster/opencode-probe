import { Effect, Stream } from "effect"
import { defineScript, Llm, wait } from "opencode-drive"

export default defineScript({
  launch: "manual",

  run: ({ server, clients, llm }) =>
    Effect.gen(function* () {
      yield* server.launch()

      yield* llm.serve((_request, index) =>
        Stream.make(Llm.text(`Response for request ${index + 1}`)),
      )

      const [alice, bob] = yield* Effect.all(
        [
          clients.launch("alice", { record: true }),
          clients.launch("bob", { record: true }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Effect.all(
        [alice.submit("Reply to Alice"), bob.submit("Reply to Bob")],
        { concurrency: "unbounded" },
      )
      yield* Effect.all(
        [
          alice.screenshot("multiple-clients-alice-submitted"),
          bob.screenshot("multiple-clients-bob-submitted"),
        ],
        { concurrency: "unbounded" },
      )
      yield* Effect.all(
        [
          alice.waitFor("Response for request", { timeout: 30_000 }),
          bob.waitFor("Response for request", { timeout: 30_000 }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Effect.all(
        [
          alice.screenshot("multiple-clients-alice-complete"),
          bob.screenshot("multiple-clients-bob-complete"),
        ],
        { concurrency: "unbounded" },
      )

      yield* server.kill()
      yield* wait(500)
      yield* Effect.all(
        [
          alice.screenshot("multiple-clients-alice-server-stopped"),
          bob.screenshot("multiple-clients-bob-server-stopped"),
        ],
        { concurrency: "unbounded" },
      )

      yield* server.launch()
      yield* wait(1000)
      yield* Effect.all(
        [
          alice.screenshot("multiple-clients-alice-server-relaunched"),
          bob.screenshot("multiple-clients-bob-server-relaunched"),
        ],
        { concurrency: "unbounded" },
      )
    }),
})

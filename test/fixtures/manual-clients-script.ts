import { defineScript } from "../../src/index.js"
import * as Effect from "effect/Effect"

export default defineScript({
  launch: "manual",
  run: ({ ui, server, clients, artifacts }) =>
    Effect.gen(function* () {
      if (ui !== null)
        return yield* Effect.fail(
          new Error("manual scripts must not receive a default UI"),
        )
      const clientBeforeServer = yield* Effect.matchEffect(
        clients.launch("too-early"),
        {
          onFailure: (error) => Effect.succeed(errorMessage(error)),
          onSuccess: () => Effect.succeed("unexpected success"),
        },
      )
      yield* server.launch()
      const duplicateServer = yield* Effect.matchEffect(server.launch(), {
        onFailure: (error) => Effect.succeed(errorMessage(error)),
        onSuccess: () => Effect.succeed("unexpected success"),
      })
      const [alice, bob] = yield* Effect.all(
        [clients.launch("alice"), clients.launch("bob")],
        { concurrency: "unbounded" },
      )
      yield* alice.submit("from alice")
      yield* bob.submit("from bob")
      const [aliceMatches, bobMatches, aliceScreenshot, bobScreenshot] =
        yield* Effect.all([
        alice.matches("client-alice"),
        bob.matches("client-bob"),
        alice.screenshot("alice"),
        bob.screenshot("bob"),
        ], { concurrency: "unbounded" })
      yield* Effect.tryPromise(() =>
        Bun.write(
          `${artifacts}/manual-clients.json`,
          JSON.stringify({
            aliceMatches,
            bobMatches,
            clientBeforeServer,
            duplicateServer,
            aliceScreenshot,
            bobScreenshot,
          }),
        ),
      )
    }),
})

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

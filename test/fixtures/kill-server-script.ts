import { defineScript, wait } from "../../src/index.js"
import * as Effect from "effect/Effect"

export default defineScript({
  launch: "manual",
  run: ({ server, clients, artifacts }) =>
    Effect.gen(function* () {
      yield* server.launch()
      const firstServer = Number(
        yield* Effect.tryPromise(() =>
          Bun.file(`${artifacts}/service.pid`).text(),
        ),
      )
      const [alice] = yield* Effect.all(
        [
          clients.launch("alice", { record: true }),
          clients.launch("bob", { record: true }),
        ],
        { concurrency: "unbounded" },
      )

      yield* server.kill()
      for (let attempt = 0; attempt < 100 && running(firstServer); attempt++)
        yield* wait(10)
      if (running(firstServer))
        return yield* Effect.fail(new Error("the first server is still running"))

      yield* server.launch()
      const secondServer = Number(
        yield* Effect.tryPromise(() =>
          Bun.file(`${artifacts}/service.pid`).text(),
        ),
      )
      if (secondServer === firstServer)
        return yield* Effect.fail(new Error("the server was not relaunched"))

      const aliceRecording = yield* alice.kill()
      const relaunchedAlice = yield* clients.launch("alice")
      yield* relaunchedAlice.kill()
      yield* server.kill()

      yield* Effect.tryPromise(() =>
        Bun.write(
          `${artifacts}/kill-server-result.json`,
          JSON.stringify({ firstServer, secondServer, aliceRecording }),
        ),
      )
    }),
})

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

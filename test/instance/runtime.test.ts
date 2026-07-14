import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { initializeInstance } from "../../src/instance/instance.js"
import * as OpenCodeInstance from "../../src/instance/runtime.js"

const fakeOpenCode = [
  process.execPath,
  resolve("test", "fixtures", "fake-opencode.ts"),
]

it.live("stops a client while its readiness check is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(artifacts, { recursive: true, force: true })),
      )
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "pending-client-test",
        scripted: true,
        command: [...fakeOpenCode, "no-ui"],
      })

      yield* instance.launchServer
      const launch = yield* instance.launchClient("pending").pipe(
        Effect.exit,
        Effect.forkChild,
      )
      yield* Effect.sleep(100)

      const started = Date.now()
      yield* instance.stop
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(Exit.isFailure(yield* Fiber.join(launch))).toBe(true)
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)

import * as Effect from "effect/Effect"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import * as OpenCodeClients from "./client.js"
import { error } from "./error.js"
import * as LlmController from "./llm-controller.js"
import type { Project } from "./project.js"

export interface Target {
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly env?: Readonly<Record<string, string>>
  readonly visible?: boolean
}

export interface Options {
  readonly project: Project
  readonly target?: Target
}

export interface Server {
  readonly llm: LlmController.Controller
  readonly clients: OpenCodeClients.Control
}

export const make = Effect.fn("OpenCodeServer.make")(function* (
  options: Options,
) {
  const connector = yield* SimulationConnector.Service
  const target = options.target ?? {}
  const instance = yield* OpenCodeInstance.make({
    artifacts: options.project.artifacts,
    name: `library-${crypto.randomUUID().slice(0, 12)}`,
    scripted: true,
    command: target.command,
    dev: target.dev,
    env: target.env,
    visible: target.visible,
  }).pipe(
    Effect.mapError((cause) => error("server.prepare", cause)),
  )
  const launched = yield* instance.launchServer.pipe(
    Effect.mapError((cause) => error("server.launch", cause)),
  )
  const backend = yield* connector.backend(launched.endpoint)
  const llm = yield* LlmController.make(backend)
  const clients = yield* OpenCodeClients.makeClients(
    instance,
    target.visible ?? false,
    connector,
  )
  return { llm, clients } satisfies Server
})

export * as OpenCodeServer from "./server.js"

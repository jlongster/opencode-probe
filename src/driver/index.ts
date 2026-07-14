import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { NodeServices } from "@effect/platform-node"
import * as SimulationConnector from "../simulation/connector.js"
import type {
  JsonObject,
  ScriptProject,
  ScriptSetup,
} from "../script/types.js"
import * as OpenCodeClient from "./client.js"
import type { OpenCodeDriverError } from "./error.js"
import type {
  LlmControllerError,
  LlmSettlementError,
} from "./llm-controller.js"
import * as OpenCodeProject from "./project.js"
import * as OpenCodeServer from "./server.js"
import type * as OpenCodeUi from "./ui.js"

export interface Options {
  readonly project?: ScriptProject
  readonly config?: JsonObject
  readonly setup?: ScriptSetup
  readonly client?: OpenCodeClient.Options
  readonly opencode?: OpenCodeServer.Target
  readonly keepArtifacts?: boolean
}

export interface Driver {
  readonly ui: OpenCodeUi.Ui
  readonly llm: Llm
  readonly clients: OpenCodeClient.Clients
  readonly artifacts: string
  readonly recording?: OpenCodeClient.Recording
  /** Validates queued LLM work, stops clients, and exports recordings. */
  readonly settle: () => Effect.Effect<
    Settlement,
    | LlmControllerError
    | LlmSettlementError
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
  >
}

export interface Llm {
  readonly queue: OpenCodeServer.Server["llm"]["queue"]
  readonly send: OpenCodeServer.Server["llm"]["send"]
  readonly serve: OpenCodeServer.Server["llm"]["serve"]
  readonly title: OpenCodeServer.Server["llm"]["title"]
  readonly settle: OpenCodeServer.Server["llm"]["settle"]
}

export interface Settlement {
  readonly recordings: ReadonlyArray<string>
}

const makeWithServices = Effect.fn("OpenCodeDriver.makeWithServices")(
  function* (options: Options = {}) {
    const project = yield* OpenCodeProject.make({
      project: options.project,
      config: options.config,
      setup: options.setup,
      keepArtifacts: options.keepArtifacts,
    })
    const server = yield* OpenCodeServer.make({
      project,
      target: options.opencode,
    })
    const primary = yield* server.clients.make(options.client)
    const settle = yield* Effect.cached(
      Effect.gen(function* () {
        const llm = yield* Effect.exit(server.llm.settle())
        const shutdown = yield* Effect.exit(server.llm.shutdown())
        const clients = yield* Effect.exit(server.clients.settle())
        let failure: Cause.Cause<
          | LlmControllerError
          | LlmSettlementError
          | OpenCodeDriverError
          | OpenCodeUi.OperationError
        > | undefined
        if (Exit.isFailure(llm)) failure = llm.cause
        if (Exit.isFailure(shutdown))
          failure = failure === undefined
            ? shutdown.cause
            : Cause.combine(failure, shutdown.cause)
        if (Exit.isFailure(clients))
          failure = failure === undefined
            ? clients.cause
            : Cause.combine(failure, clients.cause)
        if (failure !== undefined)
          return yield* Effect.failCause(failure)
        return {
          recordings: Exit.isSuccess(clients) ? clients.value : [],
        } satisfies Settlement
      }),
    )
    yield* Effect.addFinalizer(() => server.llm.shutdown())
    const driver: Driver = {
      ui: primary.ui,
      llm: {
        queue: server.llm.queue,
        send: server.llm.send,
        serve: server.llm.serve,
        title: server.llm.title,
        settle: server.llm.settle,
      },
      clients: server.clients,
      artifacts: project.artifacts,
      settle: () => settle,
      ...(primary.recording === undefined
        ? {}
        : { recording: primary.recording }),
    }
    return { driver, failure: server.llm.failure }
  },
)

const makeManaged = (options: Options = {}) =>
  makeWithServices(options).pipe(
    Effect.provide(SimulationConnector.layer),
    Effect.provide(NodeServices.layer),
  )

export const make = (options: Options = {}) =>
  makeManaged(options).pipe(Effect.map(({ driver }) => driver))

export const use = <A, E, R>(
  options: Options,
  f: (driver: Driver) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeManaged(options),
      ({ driver, failure }) => Effect.raceFirst(f(driver), failure),
      ({ driver }, useExit) =>
        Effect.gen(function* () {
          const settlement = yield* Effect.exit(driver.settle())
          if (Exit.isSuccess(settlement)) return undefined
          if (Exit.isFailure(useExit))
            return yield* Effect.failCause(
              Cause.combine(useExit.cause, settlement.cause),
            )
          return yield* Effect.failCause(settlement.cause)
        }),
    ),
  )

export { OpenCodeDriverError } from "./error.js"
export {
  LlmControllerError,
  LlmModeError,
  LlmSettlementError,
} from "./llm-controller.js"
export {
  UiElementAmbiguousError,
  UiTimeoutError,
  UiWaitOptionsError,
} from "./ui.js"
export { SimulationRequestError } from "../simulation/rpc.js"
export { SimulationConnectionError } from "../simulation/connector.js"
export type { Client, Clients, Recording } from "./client.js"
export type { Ui } from "./ui.js"

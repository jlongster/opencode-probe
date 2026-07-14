import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import * as Scope from "effect/Scope"
import type * as OpenCodeInstance from "../instance/runtime.js"
import type * as SimulationConnector from "../simulation/connector.js"
import { finalizeRecording } from "../recording/finalize.js"
import { error, type OpenCodeDriverError } from "./error.js"
import * as OpenCodeUi from "./ui.js"

export interface Options {
  readonly recording?: boolean
  readonly viewport?: import("../script/types.js").UiViewport
}

export interface Client {
  readonly ui: OpenCodeUi.Ui
  readonly recording?: Recording
  readonly close: () => Effect.Effect<void>
}

export interface Recording {
  readonly path: string
  readonly finish: () => Effect.Effect<
    string,
    OpenCodeDriverError | OpenCodeUi.OperationError
  >
}

interface ManagedClient extends Client {
  readonly _recording?: {
    readonly finishTimeline: Effect.Effect<
      string,
      OpenCodeDriverError | OpenCodeUi.OperationError
    >
    readonly exportRecording: Effect.Effect<
      string,
      OpenCodeDriverError | OpenCodeUi.OperationError
    >
  }
}

export const make = Effect.fn("OpenCodeClient.make")(function* (
  instance: OpenCodeInstance.Instance,
  visible: boolean,
  identity: string,
  options: Options,
  connector: SimulationConnector.Interface,
) {
  if (visible && options.recording)
    return yield* Effect.fail(
      error(
        "client.launch",
        "recording requires a headless OpenCode client",
      ),
    )
  const launched = yield* Effect.acquireRelease(
    instance.launchClient(identity, {
      record: options.recording,
      viewport: options.viewport,
    }).pipe(
      Effect.mapError((cause) => error("client.launch", cause)),
    ),
    (client) =>
      client.close.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("OpenCode client cleanup failed", cause),
        ),
      ),
  )
  const connection = yield* connector.ui(launched.endpoint)
  const ui = OpenCodeUi.make(connection)
  yield* ui.waitFor((state) => state.focused.editor, {
    timeout: 30_000,
    interval: 50,
  })

  const recording = launched.recording
  let managedRecording: ManagedClient["_recording"]
  if (recording !== undefined) {
    const finishTimeline = yield* Effect.cached(
      Effect.gen(function* () {
        const timeline = yield* ui.finishRecording()
        if (timeline !== recording.timeline)
          return yield* Effect.fail(
            error(
              "recording.finish",
              `OpenCode returned an unexpected recording path: ${timeline}`,
            ),
          )
        return timeline
      }),
    )
    const exportFinishedRecording = yield* Effect.cached(
      Effect.flatMap(finishTimeline, (timeline) =>
        Effect.tryPromise({
          try: (signal) => finalizeRecording(timeline, recording, { signal }),
          catch: (cause) => error("recording.export", cause),
        }),
      ),
    )
    managedRecording = {
      finishTimeline,
      exportRecording: exportFinishedRecording,
    }
    yield* Effect.addFinalizer(() =>
      finishTimeline.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logError("OpenCode client recording finalization failed", cause),
        ),
      ),
    )
  }

  return {
    ui,
    close: () => Effect.void,
    ...(recording === undefined || managedRecording === undefined
      ? {}
      : {
          recording: {
            path: recording.video,
            finish: () => managedRecording.exportRecording,
          },
          _recording: managedRecording,
        }),
  } satisfies ManagedClient
})

export interface Clients {
  readonly make: (
    options?: Options,
  ) => Effect.Effect<
    Client,
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
    | OpenCodeUi.UiWaitOptionsError
  >
}

export interface Control extends Clients {
  readonly settle: () => Effect.Effect<
    ReadonlyArray<string>,
    OpenCodeDriverError | OpenCodeUi.OperationError
  >
}

export const makeClients = Effect.fn("OpenCodeClients.make")(function* (
  instance: OpenCodeInstance.Instance,
  visible: boolean,
  connector: SimulationConnector.Interface,
) {
  const parentScope = yield* Scope.Scope
  const clientsScope = yield* Scope.fork(parentScope, "parallel")
  const lock = yield* Semaphore.make(1)
  const closed = yield* Ref.make(false)
  const recordings = yield* Ref.make<
    ReadonlyArray<{
      readonly finishTimeline: Effect.Effect<
        string,
        OpenCodeDriverError | OpenCodeUi.OperationError
      >
      readonly exportRecording: Effect.Effect<
        string,
        OpenCodeDriverError | OpenCodeUi.OperationError
      >
    }>
  >([])
  const nextIdentity = yield* Ref.make(0)

  const makeClient = Effect.fn("OpenCodeClients.makeClient")(function* (
    options: Options = {},
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(closed))
          return yield* Effect.fail(
            error("client.make", "OpenCode clients are closed"),
          )
        const identity = `client-${yield* Ref.getAndUpdate(
          nextIdentity,
          (value) => value + 1,
        )}`
        const scope = yield* Scope.fork(clientsScope)
        const client = yield* make(
          instance,
          visible,
          identity,
          options,
          connector,
        ).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const recording = client._recording
        if (recording !== undefined) {
          yield* Ref.update(recordings, (active) => [
            ...active,
            recording,
          ])
        }
        const publicClient: Client = {
          ui: client.ui,
          ...(client.recording === undefined
            ? {}
            : { recording: client.recording }),
          close: () => Scope.close(scope, Exit.void),
        }
        return publicClient
      }),
    )
  })

  const settle = Effect.fn("OpenCodeClients.settle")(function* () {
    const active = yield* lock.withPermit(
      Effect.gen(function* () {
        yield* Ref.set(closed, true)
        return yield* Ref.get(recordings)
      }),
    )
    const finished = yield* Effect.forEach(active, (recording) =>
      Effect.exit(recording.finishTimeline), {
      concurrency: "unbounded",
    })
    yield* Scope.close(clientsScope, Exit.void)
    const exported = yield* Effect.forEach(active, (recording, index) =>
      Exit.isSuccess(finished[index]!)
        ? Effect.exit(recording.exportRecording).pipe(
            Effect.map((result): Exit.Exit<
              string | undefined,
              OpenCodeDriverError | OpenCodeUi.OperationError
            > => result),
          )
        : Effect.succeed(Exit.succeed<string | undefined>(undefined)), {
      concurrency: 2,
    })
    let failure: Cause.Cause<
      OpenCodeDriverError | OpenCodeUi.OperationError
    > | undefined
    for (const result of [...finished, ...exported]) {
      if (!Exit.isFailure(result)) continue
      failure = failure === undefined
        ? result.cause
        : Cause.combine(failure, result.cause)
    }
    if (failure !== undefined)
      return yield* Effect.failCause(failure)
    return exported.flatMap((result) =>
      Exit.isSuccess(result) && result.value !== undefined
        ? [result.value]
        : [],
    )
  })

  return { make: makeClient, settle } satisfies Control
})

export * as OpenCodeClient from "./client.js"

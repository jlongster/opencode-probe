import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { BackendConnection } from "../simulation/connector.js"
import type { Backend } from "../simulation/protocol.js"
import * as Llm from "../llm/index.js"
import { chunkText, isTitleRequest } from "../llm/internal.js"

export class LlmModeError extends Schema.TaggedErrorClass<LlmModeError>()(
  "LlmModeError",
  {
    operation: Schema.Literals(["queue", "send", "serve", "title"]),
    message: Schema.String,
  },
) {}

export class LlmControllerError extends Schema.TaggedErrorClass<LlmControllerError>()(
  "LlmControllerError",
  {
    operation: Schema.String,
    requestId: Schema.optionalKey(Schema.String),
    message: Schema.String,
  },
) {}

export class LlmSettlementError extends Schema.TaggedErrorClass<LlmSettlementError>()(
  "LlmSettlementError",
  {
    unusedResponses: Schema.Number,
    unexpectedRequests: Schema.Number,
    message: Schema.String,
  },
) {}

export type Response = Stream.Stream<Llm.Output, LlmControllerError>
export type ServeHandler = (
  request: Backend.OpenedExchange,
  index: number,
) => Response
export type TitleHandler = (
  request: Backend.OpenedExchange,
  index: number,
) => Effect.Effect<string, LlmControllerError>

export interface Options {
  /** Per-backend-RPC timeout in milliseconds. Defaults to 30,000. */
  readonly requestTimeout?: number
  /** Time allowed for queued and active responses to settle. Defaults to 30,000. */
  readonly settlementTimeout?: number
}

export interface Controller {
  /** Attaches one backend generation while preserving response state. */
  readonly attach: (
    backend: BackendConnection,
  ) => Effect.Effect<Attachment, LlmControllerError>
  readonly queue: (
    ...output: ReadonlyArray<Llm.Output>
  ) => Effect.Effect<void, LlmModeError | LlmControllerError>
  readonly send: (
    ...output: ReadonlyArray<Llm.Output>
  ) => Effect.Effect<void, LlmModeError | LlmControllerError>
  readonly serve: (
    handler: ServeHandler,
  ) => Effect.Effect<void, LlmModeError | LlmControllerError>
  readonly title: (
    handler: TitleHandler,
  ) => Effect.Effect<void, LlmModeError | LlmControllerError>
  readonly settle: () => Effect.Effect<
    void,
    LlmControllerError | LlmSettlementError
  >
  /** Interrupts request routing and response workers. Used by the driver coordinator. */
  readonly shutdown: () => Effect.Effect<void>
  /** Fails when request routing or the backend connection fails. */
  readonly failure: Effect.Effect<never, LlmControllerError>
}

export interface Attachment {
  readonly detach: () => Effect.Effect<void>
}

interface QueuedResponse {
  readonly output: ReadonlyArray<Llm.Output>
  readonly completed?: Deferred.Deferred<void, LlmControllerError>
}

interface AttachedRequest {
  readonly request: Backend.OpenedExchange
  readonly backend: BackendConnection
}

type ResponseMode =
  | { readonly _tag: "Unset" }
  | { readonly _tag: "Queue" }
  | { readonly _tag: "Serve"; readonly handler: ServeHandler }

interface State {
  readonly mode: ResponseMode
  readonly titleHandler: TitleHandler
  readonly titleConfigured: boolean
  readonly requests: ReadonlyArray<AttachedRequest>
  readonly responses: ReadonlyArray<QueuedResponse>
  readonly activeNormal: ReadonlyArray<
    Deferred.Deferred<void, LlmControllerError>
  >
  readonly activeTitles: ReadonlyArray<Deferred.Deferred<void, LlmControllerError>>
  readonly sendCompletions: ReadonlyArray<
    Deferred.Deferred<void, LlmControllerError>
  >
  readonly requestIndex: number
  readonly titleIndex: number
  readonly failure: LlmControllerError | undefined
  readonly settling: boolean
  readonly settled: boolean
}

type NormalJob = {
  readonly request: AttachedRequest
  readonly index: number
  readonly completion: Deferred.Deferred<void, LlmControllerError>
  readonly sendCompletion?: Deferred.Deferred<void, LlmControllerError>
} & (
  | { readonly source: "queue"; readonly output: Response }
  | { readonly source: "serve"; readonly handler: ServeHandler }
)

const NonNegativeMilliseconds = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
)
const decodeOutput = Schema.decodeUnknownEffect(Llm.Output)

export const make = Effect.fn("LlmController.make")(function* (
  backendOrOptions?: BackendConnection | Options,
  explicitOptions?: Options,
) {
  const initialBackend = isBackendConnection(backendOrOptions)
    ? backendOrOptions
    : undefined
  const options = isBackendConnection(backendOrOptions)
    ? explicitOptions
    : backendOrOptions
  const requestTimeout = NonNegativeMilliseconds.make(
    options?.requestTimeout ?? 30_000,
  )
  const settlementTimeout = NonNegativeMilliseconds.make(
    options?.settlementTimeout ?? 30_000,
  )
  const state = yield* Ref.make<State>({
    mode: { _tag: "Unset" },
    titleHandler: () => Effect.succeed("OpenCode Drive"),
    titleConfigured: false,
    requests: [],
    responses: [],
    activeNormal: [],
    activeTitles: [],
    sendCompletions: [],
    requestIndex: 0,
    titleIndex: 0,
    failure: undefined,
    settling: false,
    settled: false,
  })
  const lock = yield* Semaphore.make(1)
  const changes = yield* Queue.sliding<void>(1)
  const failureSignal = yield* Deferred.make<never, LlmControllerError>()
  const tasks = yield* FiberSet.make<void, never>()
  const parentScope = yield* Scope.Scope
  const attached = yield* Ref.make<
    { readonly backend: BackendConnection; readonly scope: Scope.Scope }
    | undefined
  >(undefined)

  yield* Effect.addFinalizer(() => Queue.shutdown(changes))

  const controllerError = (
    operation: string,
    cause: unknown,
    requestId?: string,
  ) => {
    if (cause instanceof LlmControllerError) return cause
    return new LlmControllerError({
      operation,
      ...(requestId === undefined ? {} : { requestId }),
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }

  const causeError = (
    operation: string,
    cause: Cause.Cause<unknown>,
    requestId?: string,
  ) => {
    const failure = Cause.findErrorOption(cause)
    return Option.isSome(failure)
      ? controllerError(operation, failure.value, requestId)
      : controllerError(operation, Cause.squash(cause), requestId)
  }

  const notify = Queue.offer(changes, undefined).pipe(Effect.asVoid)

  const call = <A, E>(
    operation: string,
    requestId: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, LlmControllerError> =>
    Effect.timeoutOrElse(effect, {
      duration: requestTimeout,
      orElse: () =>
        Effect.fail(
          new LlmControllerError({
            operation,
            requestId,
            message: `${operation} timed out after ${requestTimeout}ms`,
          }),
        ),
    }).pipe(
      Effect.mapError((cause) => controllerError(operation, cause, requestId)),
    )

  const streamDelta = Effect.fn("LlmController.streamDelta")(function* (
    backend: BackendConnection,
    id: string,
    type: "textDelta" | "reasoningDelta",
    text: string,
    options: Llm.StreamOptions | undefined,
  ) {
    const delay = options?.delay ?? 2
    const chunkSize = options?.chunkSize ?? 15
    const chunks = [...chunkText(text, chunkSize)]
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      yield* call(
        "llm.chunk",
        id,
        backend.rpc["llm.chunk"]({ id, items: [{ type, text: chunk }] }),
      )
      if (index < chunks.length - 1 && delay > 0) yield* Effect.sleep(delay)
    }
  })

  const streamToolCall = Effect.fn("LlmController.streamToolCall")(function* (
    backend: BackendConnection,
    requestId: string,
    toolCall: Llm.ToolCall,
  ) {
    const delay = toolCall.options?.delay ?? 2
    const chunkSize = toolCall.options?.chunkSize ?? 15
    const chunks = [...chunkText(JSON.stringify(toolCall.input), chunkSize)]
    for (let index = 0; index < chunks.length; index++) {
      const text = chunks[index]
      if (text === undefined) continue
      const callDelta =
        index === 0
          ? {
              index: toolCall.index,
              id: toolCall.id,
              function: { name: toolCall.name, arguments: text },
            }
          : {
              index: toolCall.index,
              function: { arguments: text },
            }
      yield* call(
        "llm.chunk",
        requestId,
        backend.rpc["llm.chunk"]({
          id: requestId,
          items: [
            {
              type: "raw",
              chunk: { choices: [{ delta: { tool_calls: [callDelta] } }] },
            },
          ],
        }),
      )
      if (index < chunks.length - 1 && delay > 0) yield* Effect.sleep(delay)
    }
  })

  const respond = Effect.fn("LlmController.respond")(function* (
    attachedRequest: AttachedRequest,
    output: Response,
  ) {
    const { request, backend } = attachedRequest
    let terminal = false
    yield* output.pipe(
      Stream.mapEffect((value) => decodeOutput(value)),
      Stream.runForEach((item) => {
        if (terminal)
          return Effect.fail(
            new LlmControllerError({
              operation: "respond",
              requestId: request.id,
              message: `LLM response ${request.id} emitted output after its terminal event`,
            }),
          )
        switch (item.type) {
          case "finish":
            terminal = true
            return call(
              "llm.finish",
              request.id,
              backend.rpc["llm.finish"]({
                id: request.id,
                ...(item.reason === undefined ? {} : { reason: item.reason }),
              }),
            ).pipe(Effect.asVoid)
          case "disconnect":
            terminal = true
            return call(
              "llm.disconnect",
              request.id,
              backend.rpc["llm.disconnect"]({ id: request.id }),
            ).pipe(Effect.asVoid)
          case "text":
            return streamDelta(
              backend,
              request.id,
              "textDelta",
              item.text,
              item.options,
            )
          case "reasoning":
            return streamDelta(
              backend,
              request.id,
              "reasoningDelta",
              item.text,
              item.options,
            )
          case "pause":
            return item.milliseconds === 0
              ? Effect.void
              : Effect.sleep(item.milliseconds)
          case "toolCall": {
            if (item.options !== undefined)
              return streamToolCall(backend, request.id, item)
            const { options: _, ...toolCall } = item
            return call(
              "llm.chunk",
              request.id,
              backend.rpc["llm.chunk"]({
                id: request.id,
                items: [toolCall],
              }),
            ).pipe(Effect.asVoid)
          }
          case "raw":
            return call(
              "llm.chunk",
              request.id,
              backend.rpc["llm.chunk"]({ id: request.id, items: [item] }),
            ).pipe(Effect.asVoid)
        }
        return Effect.void
      }),
      Effect.mapError((cause) =>
        controllerError("respond", cause, request.id),
      ),
    )
    if (!terminal)
      yield* call(
        "llm.finish",
        request.id,
        backend.rpc["llm.finish"]({ id: request.id, reason: "stop" }),
      )
  })

  const failCompletions = (
    completions: ReadonlyArray<Deferred.Deferred<void, LlmControllerError>>,
    error: LlmControllerError,
  ) =>
    Effect.forEach(
      completions,
      (completion) => Deferred.fail(completion, error),
      { discard: true },
    )

  const recordFailureLocked = Effect.fn("LlmController.recordFailureLocked")(
    function* (error: LlmControllerError) {
      const current = yield* Ref.get(state)
      const failure = current.failure ?? error
      if (current.failure === undefined) {
        yield* Ref.set(state, { ...current, failure })
        yield* Deferred.fail(failureSignal, failure)
      }
      yield* failCompletions(current.sendCompletions, failure)
      yield* notify
      return failure
    },
  )

  const completeNormal = Effect.fn("LlmController.completeNormal")(function* (
    job: NormalJob,
    error?: LlmControllerError,
  ) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const next = {
          ...current,
          activeNormal: current.activeNormal.filter(
            (completion) => completion !== job.completion,
          ),
          sendCompletions:
            job.sendCompletion === undefined
              ? current.sendCompletions
              : current.sendCompletions.filter(
                  (completion) => completion !== job.sendCompletion,
                ),
        }
        yield* Ref.set(state, next)
        if (error === undefined) {
          yield* Deferred.succeed(job.completion, undefined)
          if (job.sendCompletion !== undefined)
            yield* Deferred.succeed(job.sendCompletion, undefined)
        } else {
          yield* Deferred.fail(job.completion, error)
          if (job.sendCompletion !== undefined)
            yield* Deferred.fail(job.sendCompletion, error)
          yield* recordFailureLocked(error)
        }
        yield* notify
      }),
    )
  })

  const runNormal = (job: NormalJob): Effect.Effect<void> => {
    const output =
      job.source === "serve"
        ? Effect.suspend(() =>
            respond(
              job.request,
              job.handler(job.request.request, job.index),
            ),
          )
        : respond(job.request, job.output)
    return Effect.matchCauseEffect(output, {
      onFailure: (cause) =>
        completeNormal(
          job,
          causeError("respond", cause, job.request.request.id),
        ),
      onSuccess: () => completeNormal(job),
    })
  }

  const drainLocked = Effect.fn("LlmController.drainLocked")(function* () {
    while (true) {
      const current = yield* Ref.get(state)
      if (current.failure !== undefined || current.requests.length === 0) return
      const request = current.requests[0]
      if (request === undefined) return

      const completion = yield* Deferred.make<void, LlmControllerError>()
      let job: NormalJob
      let responses: ReadonlyArray<QueuedResponse>
      if (current.mode._tag === "Serve") {
        responses = current.responses
        job = {
          source: "serve",
          request,
          index: current.requestIndex,
          completion,
          handler: current.mode.handler,
        }
      } else {
        const queued = current.responses[0]
        if (queued === undefined) return
        responses = current.responses.slice(1)
        job = {
          source: "queue",
          request,
          index: current.requestIndex,
          completion,
          output: Stream.fromIterable(queued.output),
          ...(queued.completed === undefined
            ? {}
            : { sendCompletion: queued.completed }),
        }
      }
      yield* Ref.set(state, {
        ...current,
        requests: current.requests.slice(1),
        responses,
        activeNormal: [...current.activeNormal, completion],
        requestIndex: current.requestIndex + 1,
      })
      yield* FiberSet.run(tasks, runNormal(job))
      yield* notify
    }
  })

  const completeTitle = Effect.fn("LlmController.completeTitle")(function* (
    completion: Deferred.Deferred<void, LlmControllerError>,
    error?: LlmControllerError,
  ) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        yield* Ref.set(state, {
          ...current,
          activeTitles: current.activeTitles.filter(
            (active) => active !== completion,
          ),
        })
        if (error === undefined) yield* Deferred.succeed(completion, undefined)
        else {
          yield* Deferred.fail(completion, error)
          yield* recordFailureLocked(error)
        }
        yield* notify
      }),
    )
  })

  const startTitleLocked = Effect.fn("LlmController.startTitleLocked")(
    function* (request: AttachedRequest, current: State) {
      const completion = yield* Deferred.make<void, LlmControllerError>()
      const previous = [...current.activeNormal]
      const handler = current.titleHandler
      const index = current.titleIndex
      yield* Ref.set(state, {
        ...current,
        activeTitles: [...current.activeTitles, completion],
        titleIndex: index + 1,
      })
      const task = Effect.gen(function* () {
        yield* Effect.forEach(previous, Deferred.await, { discard: true })
        const text = yield* Effect.suspend(() => handler(request.request, index))
        yield* respond(request, Stream.make(Llm.text(text)))
      })
      yield* FiberSet.run(
        tasks,
        Effect.matchCauseEffect(task, {
          onFailure: (cause) =>
            completeTitle(
              completion,
              causeError("title", cause, request.request.id),
            ),
          onSuccess: () => completeTitle(completion),
        }),
      )
      yield* notify
    },
  )

  const routeRequest = (request: AttachedRequest) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.failure !== undefined || current.settled) return
        if (isTitleRequest(request.request.body)) {
          yield* startTitleLocked(request, current)
          return
        }
        yield* Ref.set(state, {
          ...current,
          requests: [...current.requests, request],
        })
        yield* drainLocked()
        yield* notify
      }),
    )

  const recordRouterFailure = (cause: Cause.Cause<Schema.SchemaError>) =>
    lock.withPermit(
      recordFailureLocked(causeError("route requests", cause)),
    ).pipe(Effect.asVoid)

  const attach = Effect.fn("LlmController.attach")(function* (
    backend: BackendConnection,
  ) {
    const scope = yield* lock.withPermit(
      Effect.gen(function* () {
        if ((yield* Ref.get(attached)) !== undefined)
          return yield* Effect.fail(
            controllerError("attach", "LLM backend is already attached"),
          )
        const scope = yield* Scope.fork(parentScope)
        yield* Ref.set(attached, { backend, scope })
        return scope
      }),
    )
    yield* backend.requests.pipe(
      Stream.runForEach((request) => routeRequest({ request, backend })),
      Effect.matchCauseEffect({
        onFailure: recordRouterFailure,
        onSuccess: () => Effect.void,
      }),
      Effect.forkIn(scope),
    )
    yield* backend.closed.pipe(
      Effect.andThen(
        lock.withPermit(
          Effect.gen(function* () {
            const active = yield* Ref.get(attached)
            if (active?.backend !== backend) return
            const current = yield* Ref.get(state)
            if (current.settled) return
            yield* recordFailureLocked(
              controllerError("backend", "backend connection closed"),
            )
          }),
        ),
      ),
      Effect.forkIn(scope),
    )
    const detach = Effect.fn("LlmController.detach")(function* () {
      const shouldClose = yield* lock.withPermit(
        Effect.gen(function* () {
          const active = yield* Ref.get(attached)
          if (active?.backend !== backend) return false
          yield* Ref.set(attached, undefined)
          return true
        }),
      )
      if (shouldClose) yield* Scope.close(scope, Exit.void)
    })
    return { detach } satisfies Attachment
  })

  const enqueue = Effect.fn("LlmController.enqueue")(function* (
    operation: "queue" | "send",
    output: ReadonlyArray<Llm.Output>,
    completed?: Deferred.Deferred<void, LlmControllerError>,
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Llm.Output))(
      output,
    ).pipe(
      Effect.mapError((cause) => controllerError(operation, cause)),
    )
    yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.failure !== undefined)
          return yield* Effect.fail(current.failure)
        if (current.mode._tag === "Serve")
          return yield* Effect.fail(
            new LlmModeError({
              operation,
              message: `llm.${operation} cannot be used after llm.serve`,
            }),
          )
        if (current.settling || current.settled)
          return yield* Effect.fail(
            controllerError(operation, "LLM controller is settling"),
          )
        yield* Ref.set(state, {
          ...current,
          mode: { _tag: "Queue" },
          responses: [...current.responses, { output: decoded, completed }],
          sendCompletions:
            completed === undefined
              ? current.sendCompletions
              : [...current.sendCompletions, completed],
        })
        yield* drainLocked()
        yield* notify
        return undefined
      }),
    )
  })

  const queue = Effect.fn("LlmController.queue")(
    (...output: ReadonlyArray<Llm.Output>) => enqueue("queue", output),
  )

  const send = Effect.fn("LlmController.send")(function* (
    ...output: ReadonlyArray<Llm.Output>
  ) {
    const completed = yield* Deferred.make<void, LlmControllerError>()
    yield* enqueue("send", output, completed)
    yield* Deferred.await(completed).pipe(
      Effect.onInterrupt(() =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            yield* Ref.set(state, {
              ...current,
              responses: current.responses.filter(
                (response) => response.completed !== completed,
              ),
              sendCompletions: current.sendCompletions.filter(
                (candidate) => candidate !== completed,
              ),
            })
            yield* notify
          }),
        ),
      ),
    )
  })

  const serve = Effect.fn("LlmController.serve")((handler: ServeHandler) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.failure !== undefined)
          return yield* Effect.fail(current.failure)
        if (current.mode._tag !== "Unset")
          return yield* Effect.fail(
            new LlmModeError({
              operation: "serve",
              message: "llm.serve must be the only LLM response mode",
            }),
          )
        if (current.settling || current.settled)
          return yield* Effect.fail(
            controllerError("serve", "LLM controller is settling"),
          )
        yield* Ref.set(state, {
          ...current,
          mode: { _tag: "Serve", handler },
        })
        yield* drainLocked()
        yield* notify
        return undefined
      }),
    ),
  )

  const title = Effect.fn("LlmController.title")((handler: TitleHandler) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.failure !== undefined)
          return yield* Effect.fail(current.failure)
        if (current.titleConfigured)
          return yield* Effect.fail(
            new LlmModeError({
              operation: "title",
              message: "llm.title may only be configured once",
            }),
          )
        if (current.settling || current.settled)
          return yield* Effect.fail(
            controllerError("title", "LLM controller is settling"),
          )
        yield* Ref.set(state, {
          ...current,
          titleConfigured: true,
          titleHandler: handler,
        })
        yield* notify
        return undefined
      }),
    ),
  )

  type Settlement =
    | { readonly _tag: "Done" }
    | { readonly _tag: "Wait" }
    | {
        readonly _tag: "Fail"
        readonly error: LlmControllerError | LlmSettlementError
      }

  const inspectSettlement: Effect.Effect<Settlement> = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current.failure !== undefined)
        return { _tag: "Fail" as const, error: current.failure }
      if (
        current.mode._tag === "Queue" &&
        current.requests.length > 0 &&
        current.responses.length === 0
      )
        return {
          _tag: "Fail" as const,
          error: new LlmSettlementError({
            unusedResponses: 0,
            unexpectedRequests: current.requests.length,
            message: `received ${current.requests.length} unexpected LLM request(s)`,
          }),
        }
      if (
        current.responses.length > 0 ||
        current.activeNormal.length > 0 ||
        current.activeTitles.length > 0
      )
        return { _tag: "Wait" as const }
      yield* Ref.set(state, { ...current, settled: true })
      return { _tag: "Done" as const }
    }),
  )

  const awaitSettlement = (): Effect.Effect<
    void,
    LlmControllerError | LlmSettlementError
  > => Effect.suspend(() =>
    Effect.flatMap(inspectSettlement, (result) => {
      switch (result._tag) {
        case "Done":
          return Effect.void
        case "Fail":
          return Effect.fail(result.error)
        case "Wait":
          return Effect.andThen(Queue.take(changes), awaitSettlement())
      }
      return Effect.void
    }),
  )

  const settlementTimeoutError = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      const error = new LlmSettlementError({
        unusedResponses: current.responses.length,
        unexpectedRequests: current.requests.length,
        message:
          current.responses.length > 0
            ? `timed out with ${current.responses.length} unused LLM response(s)`
            : "timed out waiting for active LLM responses",
      })
      const controllerFailure = controllerError("settle", error)
      yield* Ref.set(state, {
        ...current,
        failure: current.failure ?? controllerFailure,
        settled: true,
      })
      yield* failCompletions(current.sendCompletions, controllerFailure)
      yield* notify
      return error
    }),
  )

  const settle = Effect.fn("LlmController.settle")(function* () {
    yield* Effect.yieldNow
    yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (!current.settling)
          yield* Ref.set(state, { ...current, settling: true })
        yield* drainLocked()
        yield* notify
      }),
    )
    yield* awaitSettlement().pipe(
      Effect.timeoutOrElse({
        duration: settlementTimeout,
        orElse: () =>
          Effect.flatMap(settlementTimeoutError, (error) => Effect.fail(error)),
      }),
      Effect.tapError((error) =>
        error instanceof LlmSettlementError
          ? FiberSet.clear(tasks)
          : Effect.void,
      ),
    )
  })

  const shutdown = Effect.fn("LlmController.shutdown")(function* () {
    const active = yield* Ref.get(attached)
    if (active !== undefined) {
      yield* Ref.set(attached, undefined)
      yield* Scope.close(active.scope, Exit.void)
    }
    yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const failure =
          current.failure ??
          controllerError("shutdown", "LLM controller is closed")
        yield* Ref.set(state, {
          ...current,
          requests: [],
          responses: [],
          failure,
          settling: true,
          settled: true,
        })
        yield* failCompletions(current.sendCompletions, failure)
        yield* notify
      }),
    )
    yield* FiberSet.clear(tasks)
  })

  if (initialBackend !== undefined) yield* attach(initialBackend)

  return {
    attach,
    queue,
    send,
    serve,
    title,
    settle,
    shutdown,
    failure: Deferred.await(failureSignal),
  } satisfies Controller
})

export const response = (...output: ReadonlyArray<Llm.Output>): Response =>
  Stream.fromIterable(output)

function isBackendConnection(
  value: BackendConnection | Options | undefined,
): value is BackendConnection {
  return value !== undefined && "rpc" in value
}

export * as LlmController from "./llm-controller.js"

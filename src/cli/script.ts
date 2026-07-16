import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as OpenCodeDriver from "../driver/index.js"
import type * as OpenCodeClient from "../driver/client.js"
import * as PreparedDriver from "../driver/prepared.js"
import type * as OpenCodeInstance from "../instance/runtime.js"
import * as Llm from "../llm/index.js"
import { createScriptFileSystem } from "../script/filesystem.js"
import { hasGitMetadata } from "../script/project.js"
import type {
  ScriptClientOptions,
  ScriptDefinition,
  ScriptLlm,
  ScriptUi,
  UiElementQuery,
  UiMatcher,
  UiPredicate,
  UiWaitOptions,
} from "../script/types.js"

export const loadScript = Effect.fn("DriveCli.loadScript")((file: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(file)).href) as Promise<{ readonly default?: unknown }>,
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((module) =>
      isScriptDefinition(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(new Error("script must default-export defineScript({ project?, setup?, run })")),
    ),
  ),
)

export const runScript = Effect.fn("DriveCli.runScript")(function* (
  script: ScriptDefinition,
  instance: OpenCodeInstance.Instance,
  onScreenshot?: (path: string) => void,
  onRecording?: (path: string) => void,
  onReady?: () => void,
) {
  const prepared = yield* PreparedDriver.make(instance, {
    visible: false,
    launch: "launch" in script ? "manual" : "automatic",
    clientName: "default",
    client: { viewport: script.viewport },
  })
  const protectGit = yield* Effect.promise(() =>
    hasGitMetadata(join(instance.artifacts, "files")),
  )
  const operationFailure = yield* Deferred.make<never, unknown>()
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        isTimeoutError(cause)
          ? Deferred.fail(operationFailure, cause).pipe(Effect.asVoid)
          : Effect.void,
      ),
    )
  const recordings = new Set<string>()
  const reportRecording = (path: string) => {
    if (recordings.has(path)) return
    recordings.add(path)
    onRecording?.(path)
  }
  const adaptUi = (client: OpenCodeClient.Client): ScriptUi => {
    const ui = client.ui
    return {
      kill: () =>
        run(Effect.gen(function* () {
          const output = client.recording === undefined
            ? undefined
            : yield* client.recording.finish()
          if (output !== undefined) reportRecording(output)
          yield* client.close()
          return output
        })),
      state: () => run(ui.state()),
      matches: (matcher) => run(ui.matches(matcher)),
      screenshot: (name) => run(ui.screenshot(name)).pipe(Effect.tap((path) => Effect.sync(() => onScreenshot?.(path)))),
      type: (text) => run(ui.type(text)),
      press: (key, modifiers) => run(ui.press(key, modifiers)),
      enter: () => run(ui.enter()),
      arrow: (direction) => run(ui.arrow(direction)),
      focus: (target) => run(ui.focus(target)),
      click: (target, position) => run(ui.click(target, position)),
      resize: (viewport) => run(ui.resize(viewport)),
      submit: (text) => run(ui.submit(text)),
      waitFor(target: UiMatcher | UiPredicate, options?: UiWaitOptions) {
        if (typeof target === "string") return run(ui.waitFor(target, options))
        return run(
          ui.waitForEffect(
            (state) =>
              Effect.try({
                try: (): unknown => target(state),
                catch: toError,
              }).pipe(
                Effect.flatMap((result) => {
                  if (isEffect(result))
                    return result.pipe(
                      Effect.mapError(toError),
                      Effect.flatMap((value) =>
                        typeof value === "boolean"
                          ? Effect.succeed(value)
                          : Effect.fail(new Error("ui.waitFor predicate Effect must produce a boolean")),
                      ),
                    )
                  if (typeof result === "boolean") return Effect.succeed(result)
                  return Effect.fail(new Error("ui.waitFor predicate must return a boolean or Effect"))
                }),
              ),
            options,
          ),
        )
      },
      getElement: (
        target: number | string | UiElementQuery,
        options?: UiWaitOptions,
      ) => run(ui.getElement(target, options)),
    }
  }
  const llm = adaptLlm(prepared.llm, run)
  const clients = {
    launch: (name: string, options?: ScriptClientOptions) =>
      run(prepared.clients.launch(name, {
          recording: options?.record,
          viewport: options?.viewport ?? script.viewport,
        })).pipe(
          Effect.tap(() => Effect.sync(() => onReady?.())),
          Effect.map(adaptUi),
        ),
  }
  const context = {
    fs: createScriptFileSystem(join(instance.artifacts, "files"), {
      git: protectGit,
    }),
    clients,
    server: {
      launch: () => run(prepared.server.launch()),
      kill: () => run(prepared.server.kill()),
    },
    llm,
    artifacts: instance.artifacts,
  }
  const primaryClient = prepared.primary
  const execution =
    "launch" in script
      ? script.run({ ...context, ui: null })
      : script.run({ ...context, ui: adaptUi(primaryClient!) })
  if (!Effect.isEffect(execution))
    return yield* Effect.fail(new Error("script run must return an Effect"))
  if (primaryClient !== undefined) onReady?.()
  yield* Effect.raceAllFirst([
    execution,
    Deferred.await(operationFailure),
    prepared.failure.pipe(
      Effect.catchIf(isZeroStatusClientExit, () => Effect.void),
    ),
  ])
  const settlement = yield* prepared.settle()
  for (const path of settlement.recordings) reportRecording(path)
})

function adaptLlm(
  controller: OpenCodeDriver.Llm,
  run: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
): ScriptLlm {
  return {
    queue: (...output) => run(controller.queue(...output)),
    send: (...output) => run(controller.send(...output)),
    serve: (handler) =>
      run(controller.serve((request, index) =>
        handler(request, index).pipe(
          Stream.mapError((cause) => llmError("serve", cause, request.id)),
        ),
      )),
    title: (handler) =>
      run(controller.title((request, index) =>
        handler(request, index).pipe(
          Effect.mapError((cause) => llmError("title", cause, request.id)),
        ),
      )),
    text: Llm.text,
    reasoning: Llm.reasoning,
    pause: Llm.pause,
    toolCall: Llm.toolCall,
    raw: Llm.raw,
    finish: Llm.finish,
    disconnect: Llm.disconnect,
  }
}

function llmError(operation: string, cause: unknown, requestId?: string) {
  return new OpenCodeDriver.LlmControllerError({
    operation,
    requestId,
    message: cause instanceof Error ? cause.message : String(cause),
  })
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function isEffect(value: unknown): value is Effect.Effect<unknown, unknown> {
  return Effect.isEffect(value)
}

function isZeroStatusClientExit(cause: unknown) {
  return (
    cause instanceof OpenCodeDriver.OpenCodeDriverError &&
    cause.operation === "client.exit" &&
    cause.message.endsWith("status 0")
  )
}

function isTimeoutError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /\btimeout\b|\btimed out\b/i.test(message)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScriptDefinition(value: unknown): value is ScriptDefinition {
  if (!isRecord(value)) return false
  return (
    typeof value.run === "function" &&
    (value.project === undefined || isScriptProject(value.project)) &&
    (value.config === undefined || isJsonObject(value.config)) &&
    (value.tui === undefined || isJsonObject(value.tui)) &&
    (value.setup === undefined || typeof value.setup === "function") &&
    (value.tools === undefined || typeof value.tools === "function") &&
    (!("launch" in value) || value.launch === "manual")
  )
}

function isJsonObject(value: unknown) {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isScriptProject(value: unknown) {
  if (!isRecord(value)) return false
  if (value.git !== undefined && typeof value.git !== "boolean") return false
  if (value.files === undefined) return true
  if (!isRecord(value.files)) return false
  const prototype = Object.getPrototypeOf(value.files)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value.files).every(
    (contents) => typeof contents === "string" || contents instanceof Uint8Array,
  )
}

import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as ToolController from "../../src/tool/controller.js"
import { Failure } from "../../src/tool/index.js"
import plugin from "../../src/tool/plugin.js"
import type { OpenCodeConfig } from "../../src/script/types.js"

interface RegisteredTool {
  readonly execute: (
    input: unknown,
    context: { readonly sessionID: string; readonly callID: string },
  ) => Effect.Effect<{
    readonly structured: unknown
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>
  }, unknown>
}

it.effect("streams progress before shell success and failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ input, index, progress }) =>
          Effect.gen(function* () {
            yield* progress(`running ${index}: ${input.command}\n`)
            if (input.command === "fail")
              return yield* new Failure({ message: "controlled failure" })
            return { output: "controlled success\n", exit: 7 }
          }),
        )
      })
      const config: OpenCodeConfig = { plugins: ["existing-plugin"] }
      controller.configure(config)
      const plugins = config.plugins as Array<unknown>
      expect(plugins[0]).toBe("existing-plugin")
      const injected = plugins[1] as {
        package: string
        options: { endpoint: string; token: string; tools: string[] }
      }
      expect(injected.package.startsWith("/")).toBe(true)
      expect(injected.options.tools).toEqual(["shell"])

      const invoke = (command: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${injected.options.endpoint}/execute/shell`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${injected.options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              input: { command },
              context: { callID: `call_${command}` },
            }),
          })
          return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
        })

      expect(yield* invoke("succeed")).toEqual([
        { type: "progress", result: { output: "running 0: succeed\n" } },
        { type: "success", result: { output: "controlled success\n", exit: 7 } },
      ])
      expect(yield* invoke("fail")).toEqual([
        { type: "progress", result: { output: "running 1: fail\n" } },
        { type: "failure", message: "controlled failure" },
      ])
    }),
  ),
)

it.effect("does not inject a plugin without handlers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make()
      const config: OpenCodeConfig = {}
      controller.configure(config)
      expect(config).toEqual({})
    }),
  ),
)

it.effect("routes typed webfetch and websearch handlers independently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("webfetch", ({ input, index }) =>
          Effect.succeed({ output: `${index}:${input.format}:${input.url}` }),
        )
        tools.handle("websearch", ({ input, index }) =>
          Effect.succeed({ output: `${index}:${input.query}`, provider: "exa" }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string; tools: string[] }
      }>)[0]!
      expect(injected.options.tools).toEqual(["webfetch", "websearch"])

      const invoke = (name: string, input: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`${injected.options.endpoint}/execute/${name}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${injected.options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              input,
              context: { callID: `call_${name}` },
            }),
          })
          return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
        })

      expect(yield* invoke("webfetch", { url: "https://example.com" })).toEqual([
        {
          type: "success",
          result: { output: "0:markdown:https://example.com" },
        },
      ])
      expect(yield* invoke("websearch", { query: "effect typescript" })).toEqual([
        {
          type: "success",
          result: { output: "0:effect typescript", provider: "exa" },
        },
      ])
    }),
  ),
)

it.effect("settles background shells immediately and retains their completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = Promise.withResolvers<void>()
      let interrupted = false
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ input, progress }) =>
          Effect.gen(function* () {
            yield* progress("still running\n")
            yield* Effect.promise(() => release.promise)
            return { output: `${input.command} complete\n`, exit: 0 }
          }).pipe(
            Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
          ),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string }
      }>)[0]!
      const headers = {
        authorization: `Bearer ${injected.options.token}`,
        "content-type": "application/json",
      }
      const started = yield* Effect.promise(async () => {
        const response = await fetch(`${injected.options.endpoint}/execute/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: { command: "compile", background: true },
            context: { callID: "call_background" },
          }),
        })
        return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
      })
      expect(started).toEqual([
        {
          type: "success",
          result: {
            output: "The command was moved to the background.",
            shellID: "call_background",
            status: "running",
          },
        },
      ])
      expect(interrupted).toBe(false)

      const completion = fetch(`${injected.options.endpoint}/background/call_background`, { headers })
        .then((response) => response.json())
      release.resolve()
      expect(yield* Effect.promise(() => completion)).toEqual({
        shellID: "call_background",
        command: "compile",
        state: "completed",
        output: "compile complete\n",
      })
    }),
  ),
)

it.effect("reports background failures with retained progress output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ progress }) =>
          Effect.gen(function* () {
            yield* progress("partial output\n")
            return yield* new Failure({ message: "controlled background failure" })
          }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string }
      }>)[0]!
      const headers = {
        authorization: `Bearer ${injected.options.token}`,
        "content-type": "application/json",
      }
      yield* Effect.promise(() =>
        fetch(`${injected.options.endpoint}/execute/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: { command: "fail", background: true },
            context: { callID: "call_failure" },
          }),
        }).then((response) => response.text()),
      )
      const completion = yield* Effect.promise(() =>
        fetch(`${injected.options.endpoint}/background/call_failure`, { headers }).then((response) => response.json()),
      )
      expect(completion).toEqual({
        shellID: "call_failure",
        command: "fail",
        state: "error",
        output: "partial output\ncontrolled background failure",
      })
    }),
  ),
)

it.effect("bounds retained background output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ progress }) =>
          Effect.gen(function* () {
            yield* progress("x".repeat(1024 * 1024))
            return { output: "unreachable" }
          }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string }
      }>)[0]!
      const headers = {
        authorization: `Bearer ${injected.options.token}`,
        "content-type": "application/json",
      }
      yield* Effect.promise(() =>
        fetch(`${injected.options.endpoint}/execute/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: { command: "verbose", background: true },
            context: { callID: "call_verbose" },
          }),
        }).then((response) => response.text()),
      )
      const completion = yield* Effect.promise(() =>
        fetch(`${injected.options.endpoint}/background/call_verbose`, { headers }).then((response) => response.json()),
      )
      expect(completion).toEqual({
        shellID: "call_verbose",
        command: "verbose",
        state: "error",
        output: "Drive tool event exceeds 1048576 bytes",
      })
    }),
  ),
)

it.effect("notifies OpenCode when a registered background shell completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = Promise.withResolvers<void>()
      const notified = Promise.withResolvers<unknown>()
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => release.promise)
            return { output: "plugin completion\n", exit: 0 }
          }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const options = (config.plugins as Array<{ options: unknown }>)[0]!.options
      let shell: RegisteredTool | undefined
      yield* plugin.effect({
        options,
        tool: {
          transform: (register: (tools: { add: (name: string, tool: RegisteredTool) => void }) => void) =>
            Effect.sync(() =>
              register({
                add: (name, tool) => {
                  if (name === "shell") shell = tool
                },
              }),
            ),
        },
        session: {
          synthetic: (input: unknown) => Effect.sync(() => notified.resolve(input)),
        },
      })
      if (shell === undefined) return yield* Effect.die(new Error("shell tool was not registered"))

      const started = yield* shell.execute(
        { command: "plugin", background: true },
        { sessionID: "ses_plugin", callID: "call_plugin" },
      )
      expect(started).toEqual({
        structured: {
          output: "The command was moved to the background.",
          shellID: "call_plugin",
          status: "running",
        },
        content: [
          { type: "text", text: "The command was moved to the background." },
          {
            type: "text",
            text: "You will be notified automatically when the command finishes. DO NOT sleep, poll, or proactively check on its progress.",
          },
        ],
      })

      release.resolve()
      expect(yield* Effect.promise(() => notified.promise)).toEqual({
        id: "msg_call_plugin_completion",
        sessionID: "ses_plugin",
        text: '<shell id="call_plugin" state="completed" command="plugin">\nplugin completion\n\n</shell>',
        description: "plugin",
        metadata: { source: "shell", state: "completed" },
      })
    }),
  ),
)

it.effect("cancels retained background shells when the controller stops", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const scope = yield* Scope.make()
    const controller = yield* ToolController.make((tools) => {
      tools.handle("shell", () =>
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
        ),
      )
    }).pipe(Scope.provide(scope))
    const config: OpenCodeConfig = {}
    controller.configure(config)
    const injected = (config.plugins as Array<{
      options: { endpoint: string; token: string }
    }>)[0]!
    yield* Effect.promise(() =>
      fetch(`${injected.options.endpoint}/execute/shell`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${injected.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: { command: "wait", background: true },
          context: { callID: "call_shutdown" },
        }),
      }).then((response) => response.text()),
    )
    yield* Effect.promise(() => started.promise)
    yield* Scope.close(scope, Exit.void)
    yield* Effect.promise(() => interrupted.promise)
  }),
)

it.effect("waits for foreground handler finalizers when the controller stops", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const finalizing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let finalized = false
    const scope = yield* Scope.make()
    const controller = yield* ToolController.make((tools) => {
      tools.handle("shell", () =>
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => finalizing.resolve()).pipe(
              Effect.andThen(Effect.promise(() => release.promise)),
              Effect.andThen(Effect.sync(() => {
                finalized = true
              })),
            ),
          ),
        ),
      )
    }).pipe(Scope.provide(scope))
    const config: OpenCodeConfig = {}
    controller.configure(config)
    const injected = (config.plugins as Array<{
      options: { endpoint: string; token: string }
    }>)[0]!
    const response = fetch(`${injected.options.endpoint}/execute/shell`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${injected.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: { command: "wait" },
        context: { callID: "call_foreground_shutdown" },
      }),
    }).then((response) => response.text()).catch(() => undefined)
    yield* Effect.promise(() => started.promise)
    let closed = false
    const close = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      closed = true
    })
    yield* Effect.promise(() => finalizing.promise)
    expect(closed).toBe(false)
    expect(finalized).toBe(false)
    release.resolve()
    yield* Effect.promise(() => close)
    yield* Effect.promise(() => response)
    expect(closed).toBe(true)
    expect(finalized).toBe(true)
  }),
)

it.effect("interrupts a handler when its transport disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const interrupted = Promise.withResolvers<void>()
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", () =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
          ),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string }
      }>)[0]!
      const request = new AbortController()
      const response = fetch(`${injected.options.endpoint}/execute/shell`, {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${injected.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: { command: "wait" },
          context: { callID: "call_disconnect" },
        }),
      }).catch(() => undefined)
      yield* Effect.promise(() => started.promise)
      request.abort()
      yield* Effect.promise(() => interrupted.promise)
      yield* Effect.promise(() => response)
    }),
  ),
)

it.effect("interrupts a handler with its plugin execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const interrupted = Promise.withResolvers<void>()
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", () =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
          ),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const options = (config.plugins as Array<{ options: unknown }>)[0]!.options
      let shell: RegisteredTool | undefined
      yield* plugin.effect({
        options,
        tool: {
          transform: (register: (tools: { add: (name: string, tool: RegisteredTool) => void }) => void) =>
            Effect.sync(() =>
              register({
                add: (name, tool) => {
                  if (name === "shell") shell = tool
                },
              }),
            ),
        },
        session: {
          synthetic: () => Effect.void,
        },
      })
      if (shell === undefined) return yield* Effect.die(new Error("shell tool was not registered"))

      const execution = yield* shell.execute(
        { command: "wait" },
        { sessionID: "ses_interrupt", callID: "call_interrupt" },
      ).pipe(Effect.forkScoped)
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(execution)
      yield* Effect.promise(() => interrupted.promise)
    }),
  ),
)

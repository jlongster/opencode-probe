import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { connectBackendSimulation, connectSimulation } from "../client/index.js"
import type {
  BackendSimulationClient,
  SimulationClient,
} from "../client/index.js"
import { createScriptFileSystem } from "../script/filesystem.js"
import { exportRecording } from "../recording/index.js"
import type {
  LlmOutput,
  JsonValue,
  LlmRequest,
  LlmResponse,
  LlmServeHandler,
  LlmTitleHandler,
  ScriptDefinition,
  ScriptClients,
  ScriptLlm,
  ScriptServer,
  ScriptUi,
  UiElement,
  UiElementQuery,
  UiKeyModifiers,
  UiMatcher,
  UiPosition,
  UiPredicate,
  UiState,
  UiWaitOptions,
  UiViewport,
} from "../script/types.js"

export async function loadScript(file: string): Promise<ScriptDefinition> {
  const module: { readonly default?: unknown } = await import(
    pathToFileURL(resolve(file)).href
  )
  if (!isScriptDefinition(module.default))
    throw new Error("script must default-export defineScript({ setup?, run })")
  return module.default
}

export async function runScript(
  script: ScriptDefinition,
  artifacts: string,
  launchServer: () => Promise<{
    readonly endpoints: { readonly backend: string }
  }>,
  killServer: () => Promise<void>,
  launchClient: (
    name: string,
    options?: { readonly record?: boolean; readonly viewport?: UiViewport },
  ) => Promise<{
    readonly endpoints: { readonly ui: string }
    readonly child: { readonly exited: Promise<number> }
    readonly kill: () => Promise<void>
    readonly recording?: { readonly timeline: string; readonly video: string }
  }>,
  signal: AbortSignal,
  onScreenshot?: (path: string) => void,
  onRecording?: (path: string) => void,
  onReady?: () => void,
) {
  let backend: BackendSimulationClient | undefined
  const backendFailure = Promise.withResolvers<void>()
  const connected = new Map<string, SimulationClient>()
  const finalizers = new Map<string, () => Promise<string | undefined>>()
  let closing = false
  const clientAbort = new AbortController()
  const scriptSignal = AbortSignal.any([signal, clientAbort.signal])
  const timeoutFailure = Promise.withResolvers<never>()
  void timeoutFailure.promise.catch(() => undefined)
  let fatalTimeout = false
  const abortTimeout = (error: unknown) => {
    if (!isTimeoutError(error)) return
    const reason = error instanceof Error ? error : new Error(String(error))
    fatalTimeout = true
    timeoutFailure.reject(reason)
    if (!clientAbort.signal.aborted) clientAbort.abort(reason)
  }
  const clientExit = Promise.withResolvers<{
    readonly name: string
    readonly status: number
  }>()
  const clients: ScriptClients = {
    async launch(name, options) {
      if (connected.has(name)) throw new Error(`client "${name}" is already connected`)
      const launched = await launchClient(name, {
        ...options,
        viewport: options?.viewport ?? script.viewport,
      })
      let intentional = false
      void launched.child.exited.then((status) => {
        if (!closing && !intentional) clientExit.resolve({ name, status })
      })
      const client = await connectSimulation({
        url: launched.endpoints.ui,
        onScreenshot,
      })
      connected.set(name, client)
      try {
        await waitForEditor(client, scriptSignal).catch((error) => {
          abortTimeout(error)
          throw error
        })
      } catch (error) {
        connected.delete(name)
        client.close()
        throw error
      }
      onReady?.()
      let finalizing: Promise<string | undefined> | undefined
      const finalize = () => {
        finalizing ??= (async () => {
          intentional = true
          let output: string | undefined
          try {
            if (launched.recording && !fatalTimeout) {
              const timeline = await client.finishRecording().catch((error) => {
                abortTimeout(error)
                throw error
              })
              if (timeline !== launched.recording.timeline)
                throw new Error(
                  `OpenCode returned an unexpected recording path: ${timeline}`,
                )
              if (!(await Bun.file(timeline).exists()))
                throw new Error(
                  `OpenCode recording timeline was not created: ${timeline}`,
                )
              await exportRecording(timeline, launched.recording.video)
              output = launched.recording.video
              onRecording?.(output)
            }
            return output
          } finally {
            finalizers.delete(name)
            connected.delete(name)
            client.close()
            await launched.kill()
          }
        })()
        return finalizing
      }
      finalizers.set(name, finalize)
      return new ScriptUiClient(client, scriptSignal, finalize, abortTimeout)
    },
  }
  const llm = new ScriptLlmClient(abortTimeout)
  let serverStarted = false
  let serverStarting = false
  let serverKilling = false
  const server: ScriptServer = {
    async launch() {
      if (serverStarted || serverStarting || serverKilling)
        throw new Error("the script server has already been launched")
      serverStarting = true
      try {
        const launched = await launchServer()
        const client = await connectBackendSimulation({
          url: launched.endpoints.backend,
        })
        try {
          await llm.attach(client).catch((error) => {
            abortTimeout(error)
            throw error
          })
        } catch (error) {
          client.close()
          throw error
        }
        backend = client
        void client.closed.then(() => {
          if (backend === client && serverStarted && !serverKilling)
            backendFailure.resolve()
        })
        serverStarted = true
      } finally {
        serverStarting = false
      }
    },
    async kill() {
      if (!serverStarted || serverStarting || serverKilling)
        throw new Error("the script server is not running")
      serverKilling = true
      try {
        const client = backend
        backend = undefined
        llm.detach(client)
        client?.close()
        await killServer()
        serverStarted = false
      } finally {
        serverKilling = false
      }
    },
  }
  const abort = () => {
    backend?.close()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    if (!("launch" in script)) await server.launch()
    const context = {
      fs: createScriptFileSystem(join(artifacts, "files")),
      clients,
      server,
      llm,
      artifacts,
      signal: scriptSignal,
    }
    const execution =
      "launch" in script
        ? Promise.resolve(script.run({ ...context, ui: null }))
        : Promise.resolve(
            script.run({ ...context, ui: await clients.launch("default", { viewport: script.viewport }) }),
          )
    const result = await Promise.race([
      execution.then(() => ({ script: true as const })),
      llm.failure,
      timeoutFailure.promise,
      clientExit.promise.then((exit) => ({ script: false as const, exit })),
      backendFailure.promise.then(() => ({ backend: true as const })),
      aborted(scriptSignal),
    ])
    if ("backend" in result)
      throw new Error("OpenCode simulation backend disconnected")
    if (!result.script) {
      clientAbort.abort(
        new Error(`OpenCode client "${result.exit.name}" exited`),
      )
      await execution
      if (result.exit.status !== 0)
        throw new Error(
          `OpenCode client "${result.exit.name}" exited with status ${result.exit.status}`,
        )
      return
    }
    await Promise.race([
      llm.settle(),
      backendFailure.promise.then(() => {
        throw new Error("OpenCode simulation backend disconnected")
      }),
    ])
  } finally {
    closing = true
    clientAbort.abort(new Error("script finished"))
    signal.removeEventListener("abort", abort)
    await Promise.all([...finalizers.values()].map((finalize) => finalize()))
    for (const client of connected.values()) client.close()
    backend?.close()
  }
}

class ScriptUiClient implements ScriptUi {
  constructor(
    private readonly client: SimulationClient,
    private readonly signal: AbortSignal,
    private readonly terminate: () => Promise<string | undefined>,
    private readonly abortTimeout: (error: unknown) => void,
  ) {}

  kill(): Promise<string | undefined> {
    return this.terminate()
  }

  state(): Promise<UiState> {
    return this.failOnTimeout(this.client.state())
  }

  matches(matcher: UiMatcher): Promise<boolean> {
    return this.failOnTimeout(this.client.matches(matcher))
  }

  screenshot(name?: string): Promise<string> {
    return this.failOnTimeout(this.client.screenshot(name))
  }

  type(text: string): Promise<UiState> {
    return this.failOnTimeout(this.client.typeText(text))
  }

  press(key: string, modifiers?: UiKeyModifiers): Promise<UiState> {
    return this.failOnTimeout(this.client.pressKey(key, modifiers))
  }

  enter(): Promise<UiState> {
    return this.failOnTimeout(this.client.pressEnter())
  }

  arrow(direction: "up" | "down" | "left" | "right"): Promise<UiState> {
    return this.failOnTimeout(this.client.pressArrow(direction))
  }

  focus(target: number | UiElement): Promise<UiState> {
    return this.failOnTimeout(
      this.client.focus(typeof target === "number" ? target : target.num),
    )
  }

  async click(
    target: number | UiElement,
    position?: UiPosition,
  ): Promise<UiState> {
    const element =
      typeof target === "number" ? await this.getElement(target) : target
    return this.failOnTimeout(
      this.client.click(
        element.num,
        position?.x ?? Math.floor(element.width / 2),
        position?.y ?? Math.floor(element.height / 2),
      ),
    )
  }

  resize(viewport: UiViewport): Promise<UiState> {
    return this.failOnTimeout(this.client.resize(viewport))
  }

  async submit(text: string): Promise<UiState> {
    await this.type(text)
    return this.enter()
  }

  waitFor(
    target: UiMatcher | UiPredicate,
    options?: UiWaitOptions,
  ): Promise<UiState> {
    const message = typeof target === "string"
      ? `timed out waiting for the UI to match ${JSON.stringify(target)}`
      : "timed out waiting for the UI to match"
    return this.poll(async () => {
      if (typeof target === "string")
        return (await this.matches(target)) ? await this.state() : undefined
      const state = await this.state()
      return (await target(state)) ? state : undefined
    }, options, message)
  }

  getElement(
    target: number | string | UiElementQuery,
    options?: UiWaitOptions,
  ): Promise<UiElement> {
    return this.poll(async () => {
      const state = await this.state()
      const elements = state.elements.filter((element) =>
        typeof target === "number"
          ? element.num === target
          : typeof target === "string"
            ? element.id === target
            : matchesElement(element, target),
      )
      if (elements.length > 1)
        throw new Error(`ui.getElement matched ${elements.length} elements`)
      return elements[0]
    }, options, "timed out waiting for the UI element")
  }

  private async poll<T>(
    read: () => Promise<T | undefined>,
    options: UiWaitOptions | undefined,
    message: string,
  ): Promise<T> {
    const deadline = Date.now() + (options?.timeout ?? 5_000)
    do {
      this.signal.throwIfAborted()
      const result = await read()
      if (result !== undefined) return result
      await Bun.sleep(options?.interval ?? 50)
    } while (Date.now() <= deadline)
    const error = new Error(message)
    this.abortTimeout(error)
    throw error
  }

  private async failOnTimeout<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise
    } catch (error) {
      this.abortTimeout(error)
      throw error
    }
  }
}

class ScriptLlmClient implements ScriptLlm {
  constructor(private readonly abortTimeout: (error: unknown) => void) {}

  private readonly pending: LlmRequest[] = []
  private readonly queued: QueuedLlmResponse[] = []
  private readonly tasks = new Set<Promise<void>>()
  private handler: LlmServeHandler | undefined
  private titleHandler: LlmTitleHandler = () => "OpenCode Drive"
  private titleHandlerSet = false
  private mode: "queue" | "serve" | undefined
  private requestIndex = 0
  private titleRequestIndex = 0
  private failed = false
  private readonly changes = new Set<() => void>()
  private rejectFailure!: (error: unknown) => void
  readonly failure = new Promise<never>((_resolve, reject) => {
    this.rejectFailure = reject
  })

  private backend: BackendSimulationClient | undefined

  async attach(backend: BackendSimulationClient) {
    if (this.backend) throw new Error("LLM backend is already attached")
    this.backend = backend
    await backend.attach((request) => {
      if (isTitleRequest(request)) {
        const index = this.titleRequestIndex++
        const pending = [...this.tasks]
        this.start(request, async function* (this: ScriptLlmClient) {
          await Promise.all(pending)
          yield this.text(await this.titleHandler(request, index))
        }.bind(this))
        return
      }
      this.pending.push(request)
      this.drain()
      this.notify()
    })
  }

  detach(backend: BackendSimulationClient | undefined) {
    if (this.backend === backend) this.backend = undefined
  }

  queue(...output: ReadonlyArray<LlmOutput>): void {
    if (this.mode === "serve")
      throw new Error("llm.queue cannot be used after llm.serve")
    this.mode = "queue"
    this.queued.push({ output })
    this.drain()
  }

  send(...output: ReadonlyArray<LlmOutput>): Promise<void> {
    if (this.mode === "serve")
      throw new Error("llm.send cannot be used after llm.serve")
    this.mode = "queue"
    const completed = Promise.withResolvers<void>()
    this.queued.push({ output, completed })
    this.drain()
    return completed.promise
  }

  serve(handler: LlmServeHandler): void {
    if (this.mode !== undefined)
      throw new Error("llm.serve must be the only LLM response mode")
    this.mode = "serve"
    this.handler = handler
    this.drain()
  }

  title(handler: LlmTitleHandler): void {
    if (this.titleHandlerSet) throw new Error("llm.title may only be configured once")
    this.titleHandlerSet = true
    this.titleHandler = handler
  }

  text(text: string, options?: Parameters<ScriptLlm["text"]>[1]) {
    return {
      type: "text" as const,
      text,
      ...(options === undefined ? {} : { options }),
    }
  }

  reasoning(text: string, options?: Parameters<ScriptLlm["reasoning"]>[1]) {
    return {
      type: "reasoning" as const,
      text,
      ...(options === undefined ? {} : { options }),
    }
  }

  pause(milliseconds: number) {
    return { type: "pause" as const, milliseconds }
  }

  toolCall(call: Parameters<ScriptLlm["toolCall"]>[0]) {
    return { type: "toolCall" as const, ...call }
  }

  raw(chunk: Parameters<ScriptLlm["raw"]>[0]) {
    return { type: "raw" as const, chunk }
  }

  finish(reason?: Parameters<ScriptLlm["finish"]>[0]) {
    return { type: "finish" as const, ...(reason === undefined ? {} : { reason }) }
  }

  disconnect() {
    return { type: "disconnect" as const }
  }

  async settle() {
    const deadline = Date.now() + 30_000
    while (this.mode === "queue" && this.queued.length > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const error = new Error(
          `timed out with ${this.queued.length} unused LLM response(s)`,
        )
        this.abortTimeout(error)
        throw error
      }
      await this.waitForChange(remaining)
    }
    while (this.tasks.size > 0) await Promise.all(this.tasks)
    if (this.mode === "queue" && this.pending.length > 0)
      throw new Error(`received ${this.pending.length} unexpected LLM request(s)`)
  }

  private drain() {
    while (this.pending.length > 0) {
      const request = this.pending[0]!
      if (this.handler !== undefined) {
        this.pending.shift()
        const index = this.requestIndex++
        this.start(request, () => this.handler!(request, index))
        continue
      }
      const queued = this.queued.shift()
      if (queued === undefined) return
      this.pending.shift()
      this.requestIndex++
      this.start(request, () => queued.output, queued.completed)
    }
  }

  private start(
    request: LlmRequest,
    output: () => LlmResponse,
    completed?: PromiseWithResolvers<void>,
  ) {
    const task = this.respond(request, output)
      .then(() => completed?.resolve())
      .catch((error) => {
        completed?.reject(error)
        this.abortTimeout(error)
        if (!this.failed) {
          this.failed = true
          this.rejectFailure(error)
        }
        throw error
      })
      .finally(() => this.tasks.delete(task))
    this.tasks.add(task)
    void task.catch(() => undefined)
  }

  private waitForChange(timeout: number) {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (result: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.changes.delete(changed)
        result()
      }
      const changed = () => {
        finish(resolve)
      }
      const timer = setTimeout(
        () =>
          finish(() => {
            const error = new Error(
              `timed out with ${this.queued.length} unused LLM response(s)`,
            )
            this.abortTimeout(error)
            reject(error)
          }),
        timeout,
      )
      this.changes.add(changed)
      void this.failure.catch((error) => finish(() => reject(error)))
    })
  }

  private notify() {
    for (const changed of this.changes) changed()
  }

  private async respond(request: LlmRequest, output: () => LlmResponse) {
    const backend = this.backend
    if (!backend) throw new Error("launch the script server before handling LLM requests")
    let terminal = false
    for await (const item of output()) {
      if (terminal)
        throw new Error(`LLM response ${request.id} emitted output after its terminal event`)
      if (item.type === "finish") {
        terminal = true
        await backend.finish(request.id, item.reason)
      } else if (item.type === "disconnect") {
        terminal = true
        await backend.disconnect(request.id)
      } else if (item.type === "text") {
        await this.streamDelta(
          request.id,
          "textDelta",
          "text",
          item.text,
          item.options,
        )
      } else if (item.type === "reasoning") {
        await this.streamDelta(
          request.id,
          "reasoningDelta",
          "reasoning",
          item.text,
          item.options,
        )
      } else if (item.type === "pause") {
        if (!Number.isFinite(item.milliseconds) || item.milliseconds < 0)
          throw new Error("llm.pause milliseconds must be a non-negative number")
        if (item.milliseconds > 0) await Bun.sleep(item.milliseconds)
      } else {
        await backend.chunk(request.id, [item])
      }
    }
    if (!terminal) await backend.finish(request.id, "stop")
  }

  private async streamDelta(
    id: string,
    type: "textDelta" | "reasoningDelta",
    helper: "text" | "reasoning",
    text: string,
    options: Parameters<ScriptLlm["text"]>[1],
  ) {
    const backend = this.backend
    if (!backend) throw new Error("launch the script server before streaming LLM output")
    const delay = options?.delay ?? 2
    const chunkSize = options?.chunkSize ?? 15
    if (!Number.isFinite(delay) || delay < 0)
      throw new Error(`llm.${helper} delay must be a non-negative number`)
    if (!Number.isInteger(chunkSize) || chunkSize < 1)
      throw new Error(`llm.${helper} chunkSize must be a positive integer`)

    const characters = Array.from(text)
    for (let index = 0; index < characters.length; ) {
      const size = Math.max(1, chunkSize + Math.floor(Math.random() * 11) - 5)
      const end = Math.min(characters.length, index + size)
      const chunk = characters.slice(index, end).join("")
      index = end
      await backend.chunk(id, [{ type, text: chunk }])
      if (index < characters.length && delay > 0) await Bun.sleep(delay)
    }
  }
}

interface QueuedLlmResponse {
  readonly output: ReadonlyArray<LlmOutput>
  readonly completed?: PromiseWithResolvers<void>
}

async function waitForEditor(ui: SimulationClient, signal: AbortSignal) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if ((await ui.state()).focused.editor) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for the prompt editor")
}

function matchesElement(element: UiElement, query: UiElementQuery) {
  return (
    (query.id === undefined || element.id === query.id) &&
    (query.num === undefined || element.num === query.num) &&
    (query.focusable === undefined || element.focusable === query.focusable) &&
    (query.focused === undefined || element.focused === query.focused) &&
    (query.clickable === undefined || element.clickable === query.clickable) &&
    (query.editor === undefined || element.editor === query.editor)
  )
}

function isTitleRequest(request: LlmRequest) {
  const body = request.body
  if (!isJsonObject(body)) return false
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  const first = messages.find(isMessageObject)
  const firstContent = messageContent(first)
  if (
    first?.role === "user" &&
    firstContent?.startsWith("Generate a title for this conversation:")
  )
    return true
  const system = messages.find(
    (message) => isMessageObject(message) && message.role === "system",
  )
  return (
    messageContent(system)?.startsWith("You are a title generator.") ?? false
  )
}

function isMessageObject(value: unknown) {
  return isJsonObject(value) && typeof value.role === "string"
}

function messageContent(message: unknown): string | undefined {
  if (!isJsonObject(message)) return undefined
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (isJsonObject(part) && typeof part.text === "string") return part.text
      return ""
    })
    .join("")
}

function isJsonObject(
  value: unknown,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function aborted(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("script aborted"))
      return
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("script aborted")),
      { once: true },
    )
  })
}

function isTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /\btimeout\b|\btimed out\b/i.test(message)
}

function isScriptDefinition(value: unknown): value is ScriptDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const script = value as { readonly run?: unknown; readonly setup?: unknown }
  return (
    typeof script.run === "function" &&
    (script.setup === undefined || typeof script.setup === "function") &&
    (!("launch" in script) || script.launch === "manual")
  )
}

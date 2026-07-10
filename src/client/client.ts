import { Frontend, type JsonRpc } from "./protocol.js"
import { recordLog } from "../log.js"

const defaultPort = 40900

type Methods = {
  readonly "ui.screenshot": {
    readonly params: Frontend.ScreenshotParams | undefined
    readonly result: Frontend.Screenshot
  }
  readonly "ui.state": {
    readonly params: undefined
    readonly result: Frontend.State
  }
  readonly "ui.matches": {
    readonly params: Frontend.MatchesParams
    readonly result: Frontend.Matches
  }
  readonly "ui.recording.finish": {
    readonly params: undefined
    readonly result: Frontend.RecordingFinish
  }
  readonly "ui.type": {
    readonly params: Frontend.TypeParams
    readonly result: Frontend.State
  }
  readonly "ui.press": {
    readonly params: Frontend.PressParams
    readonly result: Frontend.State
  }
  readonly "ui.enter": {
    readonly params: undefined
    readonly result: Frontend.State
  }
  readonly "ui.arrow": {
    readonly params: Frontend.ArrowParams
    readonly result: Frontend.State
  }
  readonly "ui.focus": {
    readonly params: Frontend.FocusParams
    readonly result: Frontend.State
  }
  readonly "ui.click": {
    readonly params: Frontend.ClickParams
    readonly result: Frontend.State
  }
  readonly "ui.resize": {
    readonly params: Frontend.ResizeParams
    readonly result: Frontend.State
  }
}

type MethodName = keyof Methods

/**
 * WebSocket client for the OpenCode simulation control server.
 *
 * Start OpenCode with `OPENCODE_SIMULATION=1` (optionally
 * `OPENCODE_SIMULATION_RENDERER=headless`), then connect from a probe run:
 *
 * ```ts
 * const client = await connectSimulation()
 * const state = await client.state()
 * await client.typeText("hello")
 * client.close()
 * ```
 */
export interface SimulationClientOptions {
  /** Explicit server URL; skips port scanning. */
  readonly url?: string
  /** First port to try when no URL is given. Defaults to 40900. */
  readonly port?: number
  /** Ports to scan upward from `port`. Defaults to 10. */
  readonly portAttempts?: number
  /** Per-call timeout in milliseconds. Defaults to 30_000. */
  readonly timeout?: number
  readonly onScreenshot?: (path: string) => void
}

export class SimulationError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "SimulationError"
  }
}

interface Waiter {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class SimulationClient {
  readonly url: string

  private readonly socket: WebSocket
  private readonly timeout: number
  private readonly onScreenshot?: (path: string) => void
  private nextId = 1
  private readonly pending = new Map<number, Waiter>()

  private constructor(
    socket: WebSocket,
    url: string,
    timeout: number,
    onScreenshot?: (path: string) => void,
  ) {
    this.socket = socket
    this.url = url
    this.timeout = timeout
    this.onScreenshot = onScreenshot
    socket.addEventListener("message", (event) =>
      this.onMessage(String(event.data)),
    )
    socket.addEventListener("close", () =>
      this.rejectAll(new SimulationError("connection closed")),
    )
    socket.addEventListener("error", () =>
      this.rejectAll(new SimulationError("connection error")),
    )
  }

  static async connect(
    options?: SimulationClientOptions,
  ): Promise<SimulationClient> {
    const timeout = options?.timeout ?? 30_000
    if (options?.url !== undefined) {
      return new SimulationClient(
        await open(options.url),
        options.url,
        timeout,
        options.onScreenshot,
      )
    }
    const first = options?.port ?? defaultPort
    const attempts = options?.portAttempts ?? 10
    for (let offset = 0; offset < attempts; offset++) {
      const url = `ws://127.0.0.1:${first + offset}`
      try {
        return new SimulationClient(
          await open(url),
          url,
          timeout,
          options?.onScreenshot,
        )
      } catch {
        // occupied by something else or nothing listening; try the next port
      }
    }
    throw new SimulationError(
      `no simulation server found on ports ${first}-${first + attempts - 1}; ` +
        "is OpenCode running with OPENCODE_SIMULATION=1?",
    )
  }

  /** Raw JSON-RPC call. Prefer the typed wrappers below. */
  async call<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): Promise<Methods[M]["result"]> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new SimulationError("connection is not open", method)
    }
    recordLog("INFO", `ui command ${method} params=${formatParams(params)}`)
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SimulationError(`timed out after ${this.timeout}ms`, method))
      }, this.timeout)
      this.pending.set(id, { method, resolve, reject, timer })
    })
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    )
    // The server contract types each method's result; the cast happens once
    // here rather than at every call site.
    try {
      const result = await promise
      recordLog("INFO", `ui command ${method} completed`)
      return result as Methods[M]["result"]
    } catch (error) {
      recordLog(
        "ERROR",
        `ui command ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  // ── ui ────────────────────────────────────────────────────────────────

  /** Current screen, focus, elements, and generated actions. */
  state(): Promise<Frontend.State> {
    return this.call("ui.state")
  }

  matches(text: string): Promise<Frontend.Matches> {
    return this.call("ui.matches", { text })
  }

  async screenshot(name?: string): Promise<Frontend.Screenshot> {
    const path = await this.call(
      "ui.screenshot",
      name === undefined ? undefined : { name },
    )
    this.onScreenshot?.(path)
    return path
  }

  finishRecording(): Promise<Frontend.RecordingFinish> {
    return this.call("ui.recording.finish")
  }

  /** Executes one user-level action and returns the post-action state. */
  typeText(text: string): Promise<Frontend.State> {
    return this.call("ui.type", { text })
  }

  pressKey(
    key: string,
    modifiers?: Frontend.KeyModifiers,
  ): Promise<Frontend.State> {
    return this.call("ui.press", {
      key: key === "escape" ? "\u001b" : key,
      ...(modifiers === undefined ? {} : { modifiers }),
    })
  }

  pressEnter(): Promise<Frontend.State> {
    return this.call("ui.enter")
  }

  pressArrow(
    direction: "up" | "down" | "left" | "right",
  ): Promise<Frontend.State> {
    return this.call("ui.arrow", { direction })
  }

  focus(target: number): Promise<Frontend.State> {
    return this.call("ui.focus", { target })
  }

  click(target: number, x: number, y: number): Promise<Frontend.State> {
    return this.call("ui.click", { target, x, y })
  }

  resize(viewport: Frontend.ResizeParams): Promise<Frontend.State> {
    return this.call("ui.resize", viewport)
  }

  close(): void {
    this.socket.terminate()
  }

  private onMessage(data: string) {
    const message = parseResponse(data)
    if (message === undefined || typeof message.id !== "number") return
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error)
      waiter.reject(new SimulationError(message.error.message, waiter.method))
    else waiter.resolve(message.result)
  }

  private rejectAll(error: SimulationError) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

function parseResponse(data: string): JsonRpc.Response | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  if (!("jsonrpc" in value) || value.jsonrpc !== "2.0") return undefined
  if (!("id" in value)) return undefined
  const id = value.id
  if (typeof id !== "number" && typeof id !== "string" && id !== null)
    return undefined
  const result = "result" in value ? value.result : undefined
  const error = "error" in value ? value.error : undefined
  if (error !== undefined) {
    if (typeof error !== "object" || error === null) return undefined
    const code = "code" in error ? error.code : undefined
    const message = "message" in error ? error.message : undefined
    if (typeof code !== "number" || typeof message !== "string")
      return undefined
    return { jsonrpc: "2.0", id, error: { code, message } }
  }
  return { jsonrpc: "2.0", id, result: result as JsonRpc.Response["result"] }
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const onOpen = () => {
      cleanup()
      resolve(socket)
    }
    const onError = () => {
      cleanup()
      reject(new SimulationError(`cannot connect to ${url}`))
    }
    const cleanup = () => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
  })
}

function formatParams(value: unknown) {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

export const connectSimulation = (
  options?: SimulationClientOptions,
): Promise<SimulationClient> => SimulationClient.connect(options)

import {
  defaultPort,
  type JsonRpcResponse,
  type KeyModifiers,
  type MethodName,
  type Methods,
  type TraceCleared,
  type TraceList,
  type UiAction,
  type UiState,
} from "./protocol.js"

/**
 * WebSocket client for the OpenCode simulation control server.
 *
 * Start OpenCode with `OPENCODE_SIMULATION=1` (optionally
 * `OPENCODE_SIMULATION_RENDERER=fake`), then connect from a probe run:
 *
 * ```ts
 * const client = await connectSimulation()
 * const state = await client.render()
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
  private nextId = 1
  private readonly pending = new Map<number, Waiter>()

  private constructor(socket: WebSocket, url: string, timeout: number) {
    this.socket = socket
    this.url = url
    this.timeout = timeout
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)))
    socket.addEventListener("close", () => this.rejectAll(new SimulationError("connection closed")))
    socket.addEventListener("error", () => this.rejectAll(new SimulationError("connection error")))
  }

  static async connect(options?: SimulationClientOptions): Promise<SimulationClient> {
    const timeout = options?.timeout ?? 30_000
    if (options?.url !== undefined) {
      return new SimulationClient(await open(options.url), options.url, timeout)
    }
    const first = options?.port ?? defaultPort
    const attempts = options?.portAttempts ?? 10
    for (let offset = 0; offset < attempts; offset++) {
      const url = `ws://127.0.0.1:${first + offset}`
      try {
        return new SimulationClient(await open(url), url, timeout)
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
  async call<M extends MethodName>(method: M, params?: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new SimulationError("connection is not open", method)
    }
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SimulationError(`timed out after ${this.timeout}ms`, method))
      }, this.timeout)
      this.pending.set(id, { method, resolve, reject, timer })
    })
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }))
    // The server contract types each method's result; the cast happens once
    // here rather than at every call site.
    return (await promise) as Methods[M]["result"]
  }

  // ── ui ────────────────────────────────────────────────────────────────

  /** Current screen, focus, elements, and generated actions. */
  state(): Promise<UiState> {
    return this.call("ui.state")
  }

  /** Executes one user-level action and returns the post-action state. */
  action(action: UiAction): Promise<UiState> {
    return this.call("ui.action", { action })
  }

  /** Forces a render pass and returns the state. */
  render(): Promise<UiState> {
    return this.call("ui.render")
  }

  eventPause() {
    return this.call("event.pause")
  }

  eventResume() {
    return this.call("event.resume")
  }

  eventState() {
    return this.call("event.state")
  }

  typeText(text: string): Promise<UiState> {
    return this.action({ type: "typeText", text })
  }

  pressKey(key: string, modifiers?: KeyModifiers): Promise<UiState> {
    return this.action({ type: "pressKey", key: key === "escape" ? "\u001b" : key, ...(modifiers === undefined ? {} : { modifiers }) })
  }

  pressEnter(): Promise<UiState> {
    return this.action({ type: "pressEnter" })
  }

  pressArrow(direction: "up" | "down" | "left" | "right"): Promise<UiState> {
    return this.action({ type: "pressArrow", direction })
  }

  focus(target: number): Promise<UiState> {
    return this.action({ type: "focus", target })
  }

  click(target: number, x: number, y: number): Promise<UiState> {
    return this.action({ type: "click", target, x, y })
  }

  // ── trace ─────────────────────────────────────────────────────────────

  traceList(): Promise<TraceList> {
    return this.call("trace.list")
  }

  traceClear(): Promise<TraceCleared> {
    return this.call("trace.clear")
  }

  traceExport(): Promise<TraceList> {
    return this.call("trace.export")
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  close(): void {
    this.socket.close()
  }

  private onMessage(data: string) {
    const message = parseResponse(data)
    if (message === undefined || typeof message.id !== "number") return
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new SimulationError(message.error.message, waiter.method))
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

function parseResponse(data: string): JsonRpcResponse | undefined {
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
  if (typeof id !== "number" && typeof id !== "string" && id !== null) return undefined
  const result = "result" in value ? value.result : undefined
  const error = "error" in value ? value.error : undefined
  if (error !== undefined) {
    if (typeof error !== "object" || error === null) return undefined
    const code = "code" in error ? error.code : undefined
    const message = "message" in error ? error.message : undefined
    if (typeof code !== "number" || typeof message !== "string") return undefined
    return { jsonrpc: "2.0", id, error: { code, message } }
  }
  return { jsonrpc: "2.0", id, result: result as JsonRpcResponse["result"] }
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

export const connectSimulation = (options?: SimulationClientOptions): Promise<SimulationClient> =>
  SimulationClient.connect(options)

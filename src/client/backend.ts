import {
  defaultBackendPort,
  type BackendFinishReason,
  type BackendItem,
  type BackendMethodName,
  type BackendMethods,
  type JsonRpcResponse,
  type NetworkLogEntry,
  type OpenedExchange,
} from "./protocol.js"

export interface BackendSimulationClientOptions {
  readonly url?: string
  readonly port?: number
  readonly portAttempts?: number
  readonly timeout?: number
}

export class BackendSimulationError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "BackendSimulationError"
  }
}

interface Waiter {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class BackendSimulationClient {
  readonly url: string

  private readonly socket: WebSocket
  private readonly timeout: number
  private nextId = 1
  private readonly pending = new Map<number, Waiter>()
  private readonly llmRequests = new Set<(request: OpenedExchange) => void>()

  private constructor(socket: WebSocket, url: string, timeout: number) {
    this.socket = socket
    this.url = url
    this.timeout = timeout
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)))
    socket.addEventListener("close", () => this.rejectAll(new BackendSimulationError("connection closed")))
    socket.addEventListener("error", () => this.rejectAll(new BackendSimulationError("connection error")))
  }

  static async connect(options?: BackendSimulationClientOptions): Promise<BackendSimulationClient> {
    const timeout = options?.timeout ?? 30_000
    if (options?.url !== undefined) return new BackendSimulationClient(await open(options.url), options.url, timeout)
    const first = options?.port ?? defaultBackendPort
    const attempts = options?.portAttempts ?? 10
    for (let offset = 0; offset < attempts; offset++) {
      const url = `ws://127.0.0.1:${first + offset}`
      try {
        return new BackendSimulationClient(await open(url), url, timeout)
      } catch {}
    }
    throw new BackendSimulationError(`no backend simulation server found on ports ${first}-${first + attempts - 1}`)
  }

  async call<M extends BackendMethodName>(
    method: M,
    params?: BackendMethods[M]["params"],
  ): Promise<BackendMethods[M]["result"]> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new BackendSimulationError("connection is not open", method)
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BackendSimulationError(`timed out after ${this.timeout}ms`, method))
      }, this.timeout)
      this.pending.set(id, { method, resolve, reject, timer })
    })
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }))
    return (await promise) as BackendMethods[M]["result"]
  }

  async attach(onRequest: (request: OpenedExchange) => void | Promise<void>) {
    this.llmRequests.add((request) => void onRequest(request))
    return await this.call("llm.attach")
  }

  chunk(id: string, items: ReadonlyArray<BackendItem>) {
    return this.call("llm.chunk", { id, items })
  }

  finish(id: string, reason?: BackendFinishReason) {
    return this.call("llm.finish", { id, ...(reason === undefined ? {} : { reason }) })
  }

  disconnect(id: string) {
    return this.call("llm.disconnect", { id })
  }

  pendingExchanges() {
    return this.call("llm.pending")
  }

  networkLog(): Promise<{ readonly entries: ReadonlyArray<NetworkLogEntry> }> {
    return this.call("network.log")
  }

  close() {
    this.socket.close()
  }

  private onMessage(data: string) {
    const message = parseResponse(data)
    if (message === undefined) return
    if ("method" in message) {
      if (message.method === "llm.request") {
        for (const listener of this.llmRequests) listener(message.params as OpenedExchange)
      }
      return
    }
    if (typeof message.id !== "number") return
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new BackendSimulationError(message.error.message, waiter.method))
    else waiter.resolve(message.result)
  }

  private rejectAll(error: BackendSimulationError) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

function parseResponse(data: string): JsonRpcResponse | { readonly method: string; readonly params: unknown } | undefined {
  try {
    const value = JSON.parse(data) as unknown
    if (typeof value !== "object" || value === null) return undefined
    if (!("jsonrpc" in value) || value.jsonrpc !== "2.0") return undefined
    if ("method" in value && typeof value.method === "string") {
      return { method: value.method, params: "params" in value ? value.params : undefined }
    }
    if (!("id" in value)) return undefined
    return value as JsonRpcResponse
  } catch {
    return undefined
  }
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
      reject(new BackendSimulationError(`cannot connect to ${url}`))
    }
    const cleanup = () => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
  })
}

export const connectBackendSimulation = (options?: BackendSimulationClientOptions): Promise<BackendSimulationClient> =>
  BackendSimulationClient.connect(options)

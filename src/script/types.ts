export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export interface ScriptFileSystem {
  /** Writes inside the simulated project and creates parent directories. */
  writeFile(path: string, contents: string | Uint8Array): Promise<void>
}

export interface UiKeyModifiers {
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly hyper?: boolean
}

export type UiDirection = "up" | "down" | "left" | "right"

export type UiAction =
  | { readonly type: "ui.type"; readonly text: string }
  | {
      readonly type: "ui.press"
      readonly key: string
      readonly modifiers?: UiKeyModifiers
    }
  | { readonly type: "ui.enter" }
  | { readonly type: "ui.arrow"; readonly direction: UiDirection }
  | { readonly type: "ui.focus"; readonly target: number }
  | {
      readonly type: "ui.click"
      readonly target: number
      readonly x: number
      readonly y: number
    }

export interface UiElement {
  readonly id: string
  readonly num: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly focusable: boolean
  readonly focused: boolean
  readonly clickable: boolean
  readonly editor: boolean
}

export interface UiState {
  readonly focused: {
    readonly renderable?: number
    readonly editor: boolean
  }
  readonly elements: ReadonlyArray<UiElement>
}

export type UiMatcher = string

export interface UiWaitOptions {
  /** Maximum wait in milliseconds. Defaults to 5,000. */
  readonly timeout?: number
  /** Poll interval in milliseconds. Defaults to 50. */
  readonly interval?: number
}

export interface UiElementQuery {
  readonly id?: string
  readonly num?: number
  readonly focusable?: boolean
  readonly focused?: boolean
  readonly clickable?: boolean
  readonly editor?: boolean
}

export interface UiPosition {
  readonly x: number
  readonly y: number
}

export interface UiViewport {
  readonly cols: number
  readonly rows: number
}

export type UiPredicate = (state: UiState) => boolean | Promise<boolean>

export interface ScriptUi {
  /** Terminates this TUI. The client name may be launched again afterward. */
  kill(): Promise<string | undefined>
  state(): Promise<UiState>
  matches(matcher: UiMatcher): Promise<boolean>
  screenshot(name?: string): Promise<string>

  type(text: string): Promise<UiState>
  press(key: string, modifiers?: UiKeyModifiers): Promise<UiState>
  enter(): Promise<UiState>
  arrow(direction: UiDirection): Promise<UiState>
  focus(target: number | UiElement): Promise<UiState>
  /** Clicks the element center unless a local position is provided. */
  click(target: number | UiElement, position?: UiPosition): Promise<UiState>
  resize(viewport: UiViewport): Promise<UiState>
  submit(text: string): Promise<UiState>

  waitFor(matcher: UiMatcher, options?: UiWaitOptions): Promise<UiState>
  waitFor(predicate: UiPredicate, options?: UiWaitOptions): Promise<UiState>
  /** Waits for exactly one element matching a renderable number, id, or query. */
  getElement(target: number, options?: UiWaitOptions): Promise<UiElement>
  getElement(id: string, options?: UiWaitOptions): Promise<UiElement>
  getElement(query: UiElementQuery, options?: UiWaitOptions): Promise<UiElement>
}

export interface LlmTextDelta {
  readonly type: "textDelta"
  readonly text: string
}

export interface LlmStreamOptions {
  /** Milliseconds to wait between chunks. Defaults to 2. */
  readonly delay?: number
  /** Target characters per chunk. Defaults to 15 and varies by plus or minus 5. */
  readonly chunkSize?: number
}

export interface LlmText {
  readonly type: "text"
  readonly text: string
  readonly options?: LlmStreamOptions
}

export interface LlmReasoningDelta {
  readonly type: "reasoningDelta"
  readonly text: string
}

export interface LlmReasoning {
  readonly type: "reasoning"
  readonly text: string
  readonly options?: LlmStreamOptions
}

export interface LlmPause {
  readonly type: "pause"
  readonly milliseconds: number
}

export interface LlmToolCall {
  readonly type: "toolCall"
  readonly index: number
  readonly id: string
  readonly name: string
  readonly input: JsonValue
}

export interface LlmRawChunk {
  readonly type: "raw"
  readonly chunk: JsonValue
}

export type LlmItem =
  | LlmTextDelta
  | LlmReasoningDelta
  | LlmToolCall
  | LlmRawChunk

export type LlmFinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"

export interface LlmFinish {
  readonly type: "finish"
  readonly reason?: LlmFinishReason
}

export interface LlmDisconnect {
  readonly type: "disconnect"
}

export type LlmOutput =
  | LlmText
  | LlmReasoning
  | LlmPause
  | LlmItem
  | LlmFinish
  | LlmDisconnect

export interface LlmRequest {
  readonly id: string
  readonly url: string
  readonly body: JsonValue
}

export type LlmResponse = Iterable<LlmOutput> | AsyncIterable<LlmOutput>

export type LlmServeHandler = (
  request: LlmRequest,
  index: number,
) => LlmResponse

export type LlmTitleHandler = (
  request: LlmRequest,
  index: number,
) => string | Promise<string>

export interface ScriptLlm {
  /** Queues one response composed of these chunks and terminal events. */
  queue(...output: ReadonlyArray<LlmOutput>): void
  /** Waits for the next request and resolves after its response is accepted. */
  send(...output: ReadonlyArray<LlmOutput>): Promise<void>
  /** Generates a response for every LLM request until the script ends. */
  serve(handler: LlmServeHandler): void
  /** Overrides the default response for background title requests. */
  title(handler: LlmTitleHandler): void

  text(text: string, options?: LlmStreamOptions): LlmText
  reasoning(text: string, options?: LlmStreamOptions): LlmReasoning
  /** Waits locally before processing the next output. */
  pause(milliseconds: number): LlmPause
  toolCall(call: Omit<LlmToolCall, "type">): LlmToolCall
  raw(chunk: JsonValue): LlmRawChunk
  /** Explicitly finishes a response; responses without this event finish with "stop". */
  finish(reason?: LlmFinishReason): LlmFinish
  /** Terminates a response without sending a finish event. */
  disconnect(): LlmDisconnect
}

export interface ScriptSetupContext {
  readonly fs: ScriptFileSystem
  /** The current OpenCode config object. Mutate it to customize the run. */
  readonly config: JsonObject
}

export interface ScriptClients {
  /** Launches a headless TUI connected to this script's shared service. */
  launch(name: string, options?: ScriptClientOptions): Promise<ScriptUi>
}

export interface ScriptClientOptions {
  /** Records this client and exports an MP4 before it is killed. */
  readonly record?: boolean
  /** Initial terminal viewport for this client. */
  readonly viewport?: UiViewport
}

export interface ScriptServer {
  /** Launches the one shared OpenCode server for this script. */
  launch(): Promise<void>
  /** Stops the shared server. It may be launched again afterward. */
  kill(): Promise<void>
}

export interface ScriptContext {
  readonly fs: ScriptFileSystem
  readonly ui: ScriptUi
  readonly clients: ScriptClients
  readonly server: ScriptServer
  readonly llm: ScriptLlm
  readonly artifacts: string
  readonly signal: AbortSignal
}

export interface ManualScriptContext extends Omit<ScriptContext, "ui"> {
  readonly ui: null
}

export type ScriptSetup = (
  context: ScriptSetupContext,
) => void | Promise<void>

export type ScriptRun = (context: ScriptContext) => void | Promise<void>
export type ManualScriptRun = (
  context: ManualScriptContext,
) => void | Promise<void>

export interface AutomaticScriptDefinition {
  /** Runs once before OpenCode starts. */
  readonly setup?: ScriptSetup
  /** Initial terminal viewport for the default client. */
  readonly viewport?: UiViewport
  /** Runs after the UI and LLM connections are ready, and again after restart. */
  readonly run: ScriptRun
}

export interface ManualScriptDefinition {
  /** The server and every client are launched explicitly by the script. */
  readonly launch: "manual"
  /** Runs once before OpenCode starts. */
  readonly setup?: ScriptSetup
  /** Initial terminal viewport for clients that do not specify one. */
  readonly viewport?: UiViewport
  /** Runs after the shared service and LLM connection are ready. */
  readonly run: ManualScriptRun
}

export type ScriptDefinition = AutomaticScriptDefinition | ManualScriptDefinition

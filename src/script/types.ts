import type * as Llm from "../llm/index.js"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

/** OpenCode's semantic project configuration, written to opencode.jsonc. */
export interface OpenCodeConfig extends JsonObject {}

/** OpenCode's semantic TUI configuration, written to tui.jsonc. */
export interface OpenCodeTuiConfig extends JsonObject {}

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

export type LlmStreamOptions = Llm.StreamOptions

export type LlmText = Llm.Text

export interface LlmReasoningDelta {
  readonly type: "reasoningDelta"
  readonly text: string
}

export type LlmReasoning = Llm.Reasoning

export type LlmPause = Llm.Pause

export type LlmToolCall = Llm.ToolCall

export type LlmRawChunk = Llm.Raw

export type LlmItem =
  | LlmTextDelta
  | LlmReasoningDelta
  | LlmToolCall
  | LlmRawChunk

export type LlmFinishReason = Llm.FinishReason

export type LlmFinish = Llm.Finish

export type LlmDisconnect = Llm.Disconnect

export type LlmOutput =
  | Llm.Output
  // Legacy scripts may still send protocol-level deltas directly.
  | LlmItem

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
  /** Streams JSON input when options are provided; otherwise emits the call atomically. */
  toolCall(
    call: Omit<LlmToolCall, "type" | "options">,
    options?: LlmStreamOptions,
  ): LlmToolCall
  raw(chunk: JsonValue): LlmRawChunk
  /** Explicitly finishes a response; responses without this event finish with "stop". */
  finish(reason?: LlmFinishReason): LlmFinish
  /** Terminates a response without sending a finish event. */
  disconnect(): LlmDisconnect
}

export interface ScriptSetupContext {
  readonly fs: ScriptFileSystem
  /** The current OpenCode config object. Mutate it to customize the run. */
  readonly config: OpenCodeConfig
  /** The current OpenCode TUI config object. Mutate it to customize the run. */
  readonly tui: OpenCodeTuiConfig
}

export interface ScriptProject {
  /** Files written into the isolated project before setup runs. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>
  /** Initializes the project as a Git repository and commits its pre-launch state. */
  readonly git?: boolean
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
  /** Declares the isolated project OpenCode runs against. */
  readonly project?: ScriptProject
  /** OpenCode configuration merged over project fixture configuration. */
  readonly config?: OpenCodeConfig
  /** OpenCode TUI configuration merged over project fixture configuration. */
  readonly tui?: OpenCodeTuiConfig
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
  /** Declares the isolated project OpenCode runs against. */
  readonly project?: ScriptProject
  /** OpenCode configuration merged over project fixture configuration. */
  readonly config?: OpenCodeConfig
  /** OpenCode TUI configuration merged over project fixture configuration. */
  readonly tui?: OpenCodeTuiConfig
  /** Runs once before OpenCode starts. */
  readonly setup?: ScriptSetup
  /** Initial terminal viewport for clients that do not specify one. */
  readonly viewport?: UiViewport
  /** Runs after the shared service and LLM connection are ready. */
  readonly run: ManualScriptRun
}

export type ScriptDefinition = AutomaticScriptDefinition | ManualScriptDefinition

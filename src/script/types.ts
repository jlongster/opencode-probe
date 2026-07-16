import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type * as Llm from "../llm/index.js"
import type * as Tool from "../tool/index.js"

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
  writeFile(path: string, contents: string | Uint8Array): Effect.Effect<void, Error>
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

export type UiPredicate = (
  state: UiState,
) => boolean | Effect.Effect<boolean, Error>

export interface ScriptUi {
  /** Terminates this TUI. The client name may be launched again afterward. */
  kill(): Effect.Effect<string | undefined, unknown>
  state(): Effect.Effect<UiState, unknown>
  matches(matcher: UiMatcher): Effect.Effect<boolean, unknown>
  screenshot(name?: string): Effect.Effect<string, unknown>

  type(text: string): Effect.Effect<UiState, unknown>
  press(key: string, modifiers?: UiKeyModifiers): Effect.Effect<UiState, unknown>
  enter(): Effect.Effect<UiState, unknown>
  arrow(direction: UiDirection): Effect.Effect<UiState, unknown>
  focus(target: number | UiElement): Effect.Effect<UiState, unknown>
  /** Clicks the element center unless a local position is provided. */
  click(target: number | UiElement, position?: UiPosition): Effect.Effect<UiState, unknown>
  resize(viewport: UiViewport): Effect.Effect<UiState, unknown>
  submit(text: string): Effect.Effect<UiState, unknown>

  waitFor(matcher: UiMatcher, options?: UiWaitOptions): Effect.Effect<UiState, unknown>
  waitFor(predicate: UiPredicate, options?: UiWaitOptions): Effect.Effect<UiState, unknown>
  /** Waits for exactly one element matching a renderable number, id, or query. */
  getElement(target: number, options?: UiWaitOptions): Effect.Effect<UiElement, unknown>
  getElement(id: string, options?: UiWaitOptions): Effect.Effect<UiElement, unknown>
  getElement(query: UiElementQuery, options?: UiWaitOptions): Effect.Effect<UiElement, unknown>
}

export type LlmStreamOptions = Llm.StreamOptions

export type LlmText = Llm.Text

export type LlmReasoning = Llm.Reasoning

export type LlmPause = Llm.Pause

export type LlmToolCall = Llm.ToolCall

export type LlmRawChunk = Llm.Raw

export type LlmFinishReason = Llm.FinishReason

export type LlmFinish = Llm.Finish

export type LlmDisconnect = Llm.Disconnect

export type LlmOutput = Llm.Output
export type LlmItem = Llm.Output

export interface LlmRequest {
  readonly id: string
  readonly url: string
  readonly body: JsonValue
}

export type LlmResponse = Stream.Stream<LlmOutput, unknown>

export type LlmServeHandler = (
  request: LlmRequest,
  index: number,
) => LlmResponse

export type LlmTitleHandler = (
  request: LlmRequest,
  index: number,
) => Effect.Effect<string, unknown>

export interface ScriptLlm {
  /** Queues one response composed of these chunks and terminal events. */
  queue(...output: ReadonlyArray<LlmOutput>): Effect.Effect<void, unknown>
  /** Waits for the next request and resolves after its response is accepted. */
  send(...output: ReadonlyArray<LlmOutput>): Effect.Effect<void, unknown>
  /** Generates a response for every LLM request until the script ends. */
  serve(handler: LlmServeHandler): Effect.Effect<void, unknown>
  /** Overrides the default response for background title requests. */
  title(handler: LlmTitleHandler): Effect.Effect<void, unknown>

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
  launch(name: string, options?: ScriptClientOptions): Effect.Effect<ScriptUi, unknown>
}

export interface ScriptClientOptions {
  /** Records this client and exports an MP4 before it is killed. */
  readonly record?: boolean
  /** Initial terminal viewport for this client. */
  readonly viewport?: UiViewport
}

export interface ScriptServer {
  /** Launches the one shared OpenCode server for this script. */
  launch(): Effect.Effect<void, unknown>
  /** Stops the shared server. It may be launched again afterward. */
  kill(): Effect.Effect<void, unknown>
}

export interface ScriptContext {
  readonly fs: ScriptFileSystem
  readonly ui: ScriptUi
  readonly clients: ScriptClients
  readonly server: ScriptServer
  readonly llm: ScriptLlm
  readonly artifacts: string
}

export interface ManualScriptContext extends Omit<ScriptContext, "ui"> {
  readonly ui: null
}

export type ScriptSetup = (
  context: ScriptSetupContext,
) => Effect.Effect<void, unknown>

export type ScriptRun = (context: ScriptContext) => Effect.Effect<void, unknown>
export type ManualScriptRun = (
  context: ManualScriptContext,
) => Effect.Effect<void, unknown>

export interface AutomaticScriptDefinition {
  /** Declares the isolated project OpenCode runs against. */
  readonly project?: ScriptProject
  /** OpenCode configuration merged over project fixture configuration. */
  readonly config?: OpenCodeConfig
  /** OpenCode TUI configuration merged over project fixture configuration. */
  readonly tui?: OpenCodeTuiConfig
  /** Runs once before OpenCode starts. */
  readonly setup?: ScriptSetup
  /** Declares built-in tool replacements before OpenCode starts. */
  readonly tools?: Tool.Setup
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
  /** Declares built-in tool replacements before OpenCode starts. */
  readonly tools?: Tool.Setup
  /** Initial terminal viewport for clients that do not specify one. */
  readonly viewport?: UiViewport
  /** Runs after the shared service and LLM connection are ready. */
  readonly run: ManualScriptRun
}

export type ScriptDefinition = AutomaticScriptDefinition | ManualScriptDefinition

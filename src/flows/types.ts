import type { BackendFinishReason, BackendItem } from "../client/index.js"

export type ResponseKind = "text" | "chunked" | "reasoning" | "markdown" | "raw" | "tool"
export type InteractionKind = "normal" | "double-submit" | "steer" | "interrupt" | "provider-drop"

export interface FlowResponse {
  readonly kind: ResponseKind
  readonly chunks: ReadonlyArray<ReadonlyArray<BackendItem>>
  readonly finish: BackendFinishReason
  readonly toolNames?: ReadonlyArray<string>
  readonly terminal?: "finish" | "invalid-provider-event" | "disconnect"
  readonly streamChunkTypes?: ReadonlyArray<string>
}

export interface FlowTurn {
  readonly prompt: string
  readonly marker: string
  readonly interaction: InteractionKind
  readonly steerPrompt?: string
  readonly responses: ReadonlyArray<FlowResponse>
}

export interface FlowScenario {
  readonly version: 1
  readonly seed: number
  readonly name: string
  readonly turns: ReadonlyArray<FlowTurn>
  readonly coverage: {
    readonly responseKinds: Readonly<Record<ResponseKind, number>>
    readonly toolNames: Readonly<Record<string, number>>
    readonly interactions: Readonly<Record<InteractionKind, number>>
    readonly streamChunkTypes: ReadonlyArray<string>
    readonly providerExchanges: number
  }
}

export interface FlowResult {
  readonly seed: number
  readonly name: string
  readonly turns: number
  readonly assistantExchanges: number
  readonly subagentExchanges: number
  readonly titleExchanges: number
  readonly traceRecords: number
  readonly durationMs: number
  readonly finalScreen: string
}

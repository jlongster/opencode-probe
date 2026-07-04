import type { SimulationProtocol } from "../opencode-simulation.js"

export type JsonRpcRequest = SimulationProtocol.JsonRpc.Request
export type JsonRpcResponse = SimulationProtocol.JsonRpc.Response

export type KeyModifiers = SimulationProtocol.Frontend.KeyModifiers
export type UiAction = SimulationProtocol.Frontend.Action
export type UiElement = SimulationProtocol.Frontend.Element
export type UiState = SimulationProtocol.Frontend.State
export type TraceRecord = SimulationProtocol.Frontend.TraceRecord
export type TraceList = SimulationProtocol.Frontend.TraceList

export type BackendItem = SimulationProtocol.Backend.Item
export type BackendFinishReason = SimulationProtocol.Backend.FinishReason
export type OpenedExchange = SimulationProtocol.Backend.OpenedExchange
export type NetworkLogEntry = SimulationProtocol.Backend.NetworkLogEntry

export interface TraceCleared {
  readonly cleared: true
}

export interface Methods {
  readonly "ui.state": { readonly params: undefined; readonly result: UiState }
  readonly "ui.action": { readonly params: { readonly action: UiAction }; readonly result: UiState }
  readonly "ui.render": { readonly params: undefined; readonly result: UiState }
  readonly "event.pause": { readonly params: undefined; readonly result: { readonly state: "paused" } }
  readonly "event.resume": {
    readonly params: undefined
    readonly result: { readonly state: "connected" | "reconnecting" }
  }
  readonly "event.state": {
    readonly params: undefined
    readonly result: { readonly state: "connected" | "paused" | "reconnecting" }
  }
  readonly "trace.list": { readonly params: undefined; readonly result: TraceList }
  readonly "trace.clear": { readonly params: undefined; readonly result: TraceCleared }
  readonly "trace.export": { readonly params: undefined; readonly result: TraceList }
}

export interface BackendMethods {
  readonly "llm.attach": { readonly params: undefined; readonly result: { readonly attached: true } }
  readonly "llm.chunk": {
    readonly params: { readonly id: string; readonly items: ReadonlyArray<BackendItem> }
    readonly result: { readonly ok: true }
  }
  readonly "llm.finish": {
    readonly params: { readonly id: string; readonly reason?: BackendFinishReason }
    readonly result: { readonly ok: true }
  }
  readonly "llm.disconnect": {
    readonly params: { readonly id: string }
    readonly result: { readonly ok: true }
  }
  readonly "llm.pending": { readonly params: undefined; readonly result: { readonly exchanges: ReadonlyArray<OpenedExchange> } }
  readonly "network.log": { readonly params: undefined; readonly result: { readonly entries: ReadonlyArray<NetworkLogEntry> } }
}

export type MethodName = keyof Methods
export type BackendMethodName = keyof BackendMethods

export const defaultPort = 40900
export const defaultBackendPort = 40950

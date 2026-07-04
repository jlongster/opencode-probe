import type { BackendSimulationClient, SimulationClient, UiState } from "../client/index.js"
import type { FlowTurn } from "./types.js"

export type TurnOutcome = "completed" | "interrupted" | "provider-error"

export interface FlowPropertyContext {
  readonly turn: FlowTurn
  readonly ui: SimulationClient
  readonly backend: BackendSimulationClient
  readonly outcome?: TurnOutcome
  readonly waitFor: (label: string, check: () => Promise<boolean>) => Promise<void>
}

export interface FlowProperty {
  readonly name: string
  readonly afterSubmit?: (context: FlowPropertyContext) => Promise<void>
  readonly afterTerminal?: (context: FlowPropertyContext) => Promise<void>
}

export const defineProperty = (property: FlowProperty) => property

export const flowProperties: ReadonlyArray<FlowProperty> = [
  defineProperty({
    name: "submitted-turn-shows-running",
    afterSubmit: (context) => {
      if (context.turn.responses.some((response) => response.terminal === "invalid-provider-event" || response.terminal === "disconnect")) return Promise.resolve()
      return context.waitFor("submitted turn to show running", async () => isRunning(await context.ui.render()))
    },
  }),
  defineProperty({
    name: "turn-reaches-terminal-outcome",
    afterTerminal: async (context) => {
      if (context.outcome === undefined) throw new Error("turn has no terminal outcome")
      await context.waitFor(
        "terminal turn to have no provider exchange",
        async () => (await context.backend.pendingExchanges()).exchanges.length === 0,
      )
    },
  }),
  defineProperty({
    name: "terminal-turn-clears-running",
    afterTerminal: (context) =>
      context.waitFor("terminal turn to stop showing running", async () => {
        return !isRunning(await context.ui.render())
      }),
  }),
]

export function isRunning(state: UiState) {
  return state.screen.includes("esc interrupt") || state.screen.includes("again to interrupt")
}

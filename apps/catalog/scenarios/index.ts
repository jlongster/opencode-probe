import type * as Effect from "effect/Effect"
import type { Driver } from "opencode-drive/driver"
import type { NonEmpty } from "../catalog/dsl"
import { executeFlow, type ExecutableFlow, type FlowState } from "../catalog/flow"
import { patchSuccessFlow } from "./tools/patch-success"
import { shellLifecycleFlow } from "./tools/shell-lifecycle"
import { subagentLifecycleFlow } from "./subagents/subagent-lifecycle"

export const executableFlows = [patchSuccessFlow, shellLifecycleFlow, subagentLifecycleFlow] as const

export const executableStates = [
  ...statesFromFlow(patchSuccessFlow),
  ...statesFromFlow(shellLifecycleFlow),
  ...statesFromFlow(subagentLifecycleFlow),
] as const

function statesFromFlow<
  FlowId extends string,
  States extends NonEmpty<FlowState<FlowId, string>>,
  Error,
>(flow: ExecutableFlow<FlowId, States, Error, never>) {
  return flow.states.map((state) => ({
    address: state.address,
    run: (driver: Driver, capture: () => Effect.Effect<void, unknown>) =>
      executeFlow(flow, { driver, through: state, capture }),
  }))
}

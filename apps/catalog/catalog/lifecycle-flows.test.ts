import { describe, expect, test } from "bun:test"
import { executableFlows, executableStates } from "../scenarios"
import { catalogScenarioRuntime, catalogViewport } from "../scenarios/runtime"
import { shellLifecycleFlow } from "../scenarios/tools/shell-lifecycle"
import { subagentLifecycleFlow } from "../scenarios/subagents/subagent-lifecycle"
import { flowGroups } from "./authored/flows"
import { screens } from "./authored/screens"

describe("catalog lifecycle scenarios", () => {
  test("registers canonical executable state addresses", () => {
    expect(shellLifecycleFlow.states.map((state) => state.address)).toEqual([
      "shell-lifecycle/thinking-streaming",
      "shell-lifecycle/shell-input-streaming",
      "shell-lifecycle/shell-output-streaming",
      "shell-lifecycle/shell-execute-succeeded",
      "shell-lifecycle/shell-execute-failed",
    ])
    expect(subagentLifecycleFlow.states.map((state) => state.address)).toEqual([
      "subagent-lifecycle/subagent-running",
      "subagent-lifecycle/subagent-completed",
      "subagent-lifecycle/subagent-session",
    ])
    expect(executableFlows).toContain(shellLifecycleFlow)
    expect(executableFlows).toContain(subagentLifecycleFlow)
    expect(executableStates.map((state) => state.address)).toContain("shell-lifecycle/shell-execute-failed")
    expect(executableStates.map((state) => state.address)).toContain("subagent-lifecycle/subagent-session")
  })

  test("authors screens and replayable flows from executable scenarios", () => {
    for (const flow of [shellLifecycleFlow, subagentLifecycleFlow]) {
      for (const state of flow.states) expect(screens[state.id]).toBe(state.metadata.screen)
    }
    expect(flowGroups["tool-use"].flows["shell-lifecycle"].replayable).toBe(true)
    expect(flowGroups.subagents.flows["subagent-lifecycle"].replayable).toBe(true)
  })

  test("builds the shared capture and reproduce driver runtime", () => {
    const runtime = catalogScenarioRuntime({ opencode: "/tmp/opencode", theme: "rosepine" })
    expect(runtime.opencode).toEqual({ dev: "/tmp/opencode" })
    expect(runtime.client?.viewport).toEqual(catalogViewport)
    expect(runtime.project?.files).toMatchObject({
      "fixture.txt": "before\n",
      "src/ledger.ts": expect.stringContaining("total"),
    })
    expect(runtime.tools).toBeFunction()
    expect(runtime.setup).toBeFunction()
  })
})

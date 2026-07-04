import { createRng } from "../generators/random.js"
import { defaultWeights, pickWeighted, type GenerationWeights } from "./weights.js"
import type { FlowResponse, FlowScenario, FlowTurn, InteractionKind, ResponseKind } from "./types.js"

const tasks = [
  {
    subject: "the request routing path",
    target: "src/server.ts",
    symbol: "createServer",
    concern: "a request can be dispatched after shutdown begins",
  },
  {
    subject: "the cache invalidation behavior",
    target: "src/cache.ts",
    symbol: "invalidate",
    concern: "stale entries survive a failed refresh",
  },
  {
    subject: "the configuration loading path",
    target: "src/config.ts",
    symbol: "loadConfig",
    concern: "defaults are applied before validation",
  },
  {
    subject: "the greeting helper",
    target: "src/example.ts",
    symbol: "greet",
    concern: "empty names produce awkward output",
  },
] as const

const followUps = [
  "Keep the change narrow and call out any assumptions.",
  "Check the edge cases before proposing a change.",
  "Prefer evidence from the repository over guesses.",
  "Explain what should be tested when you are done.",
] as const

const split = (text: string, pieces: number) => {
  const size = Math.ceil(text.length / pieces)
  return Array.from({ length: pieces }, (_, index) => text.slice(index * size, (index + 1) * size)).filter(Boolean)
}

export function generateFlow(seed: number, options?: { readonly turns?: number; readonly weights?: GenerationWeights; readonly enabledTools?: Set<keyof GenerationWeights["toolSelection"]> }): FlowScenario {
  const rng = createRng(seed)
  const weights = options?.weights ?? defaultWeights
  const task = rng.pick(tasks)
  const count = options?.turns ?? rng.int(6, 9)
  
  if (options?.enabledTools && options.enabledTools.size > 0) {
  }
  
  // Use weights to select response kinds for each turn
  const responseKindKeys: readonly ResponseKind[] = ["text", "chunked", "reasoning", "markdown", "raw", "tool"]
  const responseKindWeights = responseKindKeys.map(k => weights.responseKinds[k])
  const selected: ResponseKind[] = Array.from({ length: count }, () =>
    pickWeighted(responseKindKeys, responseKindWeights, rng.next())
  )
  
  const turns = selected.map((kind, index) => makeTurn(seed, index, kind, task, rng.pick(followUps), rng, weights, options?.enabledTools))
  const responseKinds = { text: 0, chunked: 0, reasoning: 0, markdown: 0, raw: 0, tool: 0 }
  const toolNames: Record<string, number> = {}
  const interactions = { normal: 0, "double-submit": 0, steer: 0, interrupt: 0, "provider-drop": 0 }
  const streamChunkTypes = new Set<string>()
  for (const turn of turns) {
    interactions[turn.interaction]++
    for (const response of turn.responses) {
      responseKinds[response.kind]++
      for (const name of response.toolNames ?? []) toolNames[name] = (toolNames[name] ?? 0) + 1
      for (const type of response.streamChunkTypes ?? []) streamChunkTypes.add(type)
      for (const item of response.chunks.flat()) {
        streamChunkTypes.add(item.type)
      }
    }
  }
  return {
    version: 1,
    seed,
    name: `${task.symbol}-${seed.toString(36)}`,
    turns,
    coverage: {
      responseKinds,
      toolNames,
      interactions,
      streamChunkTypes: [...streamChunkTypes],
      providerExchanges: turns.reduce((total, turn) => total + turn.responses.length, 0),
    },
  }
}

function makeTurn(
  seed: number,
  index: number,
  kind: ResponseKind,
  task: (typeof tasks)[number],
  followUp: string,
  rng: ReturnType<typeof createRng>,
  weights: GenerationWeights,
  enabledTools?: Set<keyof GenerationWeights["toolSelection"]>,
): FlowTurn {
  const marker = `[flow-${seed}-turn-${index + 1}-complete]`
  
  // Use weights to select interaction kind
  const interactionKeys: readonly InteractionKind[] = ["normal", "double-submit", "steer", "interrupt", "provider-drop"]
  const interactionWeights = interactionKeys.map(k => weights.interactions[k])
  const interaction: InteractionKind = kind === "raw" 
    ? "provider-drop"
    : kind === "tool"
    ? (seed % 2 === 0 ? "normal" : "interrupt")
    : pickWeighted(interactionKeys, interactionWeights, rng.next())
  
  const prompts = [
    `Orient yourself in this project and identify where ${task.subject} lives. ${followUp}`,
    `Inspect ${task.target} and trace ${task.symbol} through its callers. What behavior is observable?`,
    `The suspected bug is that ${task.concern}. Find evidence for or against that hypothesis.`,
    "Compare the smallest plausible fixes. Which one preserves existing behavior best?",
    "Describe the implementation in enough detail that another engineer could apply it safely.",
    "Now challenge that approach with one failure scenario and revise it if necessary.",
    "Give me a focused test plan covering the happy path, boundary behavior, and regression risk.",
    "Review the whole investigation for contradictions or unsupported claims.",
    "Summarize the final recommendation and the next concrete action.",
  ]
  return {
    prompt: prompts[index % prompts.length]!,
    marker,
    interaction,
    ...(interaction === "steer" ? { steerPrompt: `While that is running, also check the concurrency boundary for turn ${index + 1}.` } : {}),
    responses: [
      ...makeResponses(kind, marker, task, index, rng, weights, enabledTools),
      ...(interaction === "steer"
        ? [{ kind: "text" as const, chunks: [[{ type: "textDelta" as const, text: `I incorporated the in-flight steering prompt. ${marker}` }]], finish: "stop" as const }]
        : []),
    ],
  }
}

function makeResponses(
  kind: ResponseKind,
  marker: string,
  task: (typeof tasks)[number],
  index: number,
  rng: ReturnType<typeof createRng>,
  weights: GenerationWeights,
  enabledTools?: Set<keyof GenerationWeights["toolSelection"]>,
): ReadonlyArray<FlowResponse> {
  const conclusion = `Turn ${index + 1}: the evidence keeps the investigation focused on \`${task.symbol}\`. ${marker}`
  if (kind === "text") return [{ kind, chunks: [[{ type: "textDelta", text: conclusion }]], finish: "stop" }]
  if (kind === "chunked") {
    return [{ kind, chunks: split(`${conclusion} I will preserve the current API and verify the boundary explicitly.`, 4).map((text) => [{ type: "textDelta", text }] as const), finish: "stop" }]
  }
  if (kind === "reasoning") {
    return [{
      kind,
      chunks: [
        [{ type: "reasoningDelta", text: `I need to separate observed behavior from the hypothesis about ${task.concern}.` }],
        [{ type: "textDelta", text: conclusion }],
      ],
      finish: "stop",
    }]
  }
  if (kind === "markdown") {
    return [{
      kind,
      chunks: [[{
        type: "textDelta",
        text: `### Findings\n\n- Target: \`${task.target}\`\n- Symbol: \`${task.symbol}\`\n- Risk: ${task.concern}\n\n\`\`\`ts\n// Preserve the existing contract; test the boundary first.\n\`\`\`\n\n${marker}`,
      }]],
      finish: "stop",
    }]
  }
  if (kind === "raw") {
    // Use weights to decide whether to generate a failure at all
    const failureTotal = weights.failures.disconnect + 
                         weights.failures.invalidProviderEvent + 
                         weights.failures.disconnectDuringToolInput + 
                         weights.failures.disconnectAfterTools
    const hasAnyFailure = failureTotal > 0 && rng.next() < (failureTotal / (failureTotal + 1))
    
    if (!hasAnyFailure) {
      // Normal raw response, no failures
      return [{
        kind,
        chunks: [
          [{ type: "raw", chunk: { id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1, model: "sim-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] } }],
          [{ type: "raw", chunk: { choices: [] } }],
          [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: null, reasoning_content: "Checking the stream state. " }, finish_reason: null }] } }],
          [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: null }, finish_reason: null }] } }],
          [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: conclusion }, finish_reason: null }] } }],
          [{ type: "raw", chunk: { choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } } } }],
        ],
        finish: (["stop", "length", "content-filter"] as const)[index % 3]!,
        streamChunkTypes: [
          "chat.metadata-role",
          "chat.empty-choices",
          "chat.reasoning-content",
          "chat.content-null",
          "chat.content-delta",
          "chat.usage",
          `chat.finish.${(["stop", "length", "content-filter"] as const)[index % 3]!}`,
        ],
      }]
    }
    
    // Pick which failure mode to use
    const failureKeys: readonly (keyof typeof weights.failures)[] = ["disconnect", "invalidProviderEvent", "disconnectDuringToolInput", "disconnectAfterTools"]
    const failureWeights = failureKeys.map(k => weights.failures[k])
    const failureType = pickWeighted(failureKeys, failureWeights, rng.next())
    
    const regularDisconnect = failureType === "disconnect"
    const invalidEvent = failureType === "invalidProviderEvent"
    
    return [{
      kind,
      chunks: [
        [{ type: "raw", chunk: { id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1, model: "sim-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [] } }],
        [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: null, reasoning_content: "Checking the stream state. " }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: null }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [{ index: 0, delta: { content: conclusion }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } } } }],
        ...(invalidEvent ? [[{ type: "raw" as const, chunk: { choices: "detached" } }]] : []),
      ],
      finish: (["stop", "length", "content-filter"] as const)[index % 3]!,
      ...(regularDisconnect ? { terminal: "disconnect" as const } : invalidEvent ? { terminal: "invalid-provider-event" as const } : {}),
      streamChunkTypes: [
        "chat.metadata-role",
        "chat.empty-choices",
        "chat.reasoning-content",
        "chat.content-null",
        "chat.content-delta",
        "chat.usage",
        `chat.finish.${(["stop", "length", "content-filter"] as const)[index % 3]!}`,
        ...(invalidEvent ? ["chat.invalid-provider-event"] : []),
        ...(regularDisconnect ? ["chat.transport-disconnect"] : []),
      ],
    }]
  }
  
  // Tool response - keep it simple like the original, but filter tools
  const baseTools = [
    { name: "glob" as const, input: { pattern: "src/**/*.ts" } },
    { name: "grep" as const, input: { pattern: task.symbol, path: "src", include: "*.ts" } },
    { name: "read" as const, input: { path: task.target, limit: 120 } },
    { name: "todowrite" as const, input: { todos: [{ content: "Reproduce detached loading state", status: "in_progress", priority: "high" }] } },
  ]
  
  // Filter to only enabled tools
  const availableTools = enabledTools 
    ? baseTools.filter(t => enabledTools.has(t.name))
    : baseTools
  
  if (availableTools.length === 0) {
    // No tools enabled, return text response instead
    return [{ kind: "text", chunks: [[{ type: "textDelta", text: conclusion }]], finish: "stop" }]
  }
  
  const tool = availableTools[index % availableTools.length]!
  return [
    {
      kind,
      chunks: [
        [{ type: "reasoningDelta", text: "I should inspect the repository before making a claim." }],
        [{ type: "textDelta", text: `I'll check ${task.target} and related code.` }],
        [{ type: "raw", chunk: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${marker.slice(1, -1)}`, function: { name: tool.name, arguments: "{" } }] }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.input).slice(1) } }] }, finish_reason: null }] } }],
        [{ type: "raw", chunk: { choices: [], usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 } } }],
      ],
      finish: "tool-calls",
      toolNames: [tool.name],
      streamChunkTypes: ["chat.tool-call-start", "chat.tool-call-arguments", "chat.usage", "chat.finish.tool-calls"],
    },
    {
      kind: "text",
      chunks: [[{ type: "textDelta", text: `The repository observation is now part of the evidence. ${conclusion}` }]],
      finish: "stop",
    },
  ]
}

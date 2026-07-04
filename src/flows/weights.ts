/**
 * Weighted generation config for controlling what kinds of scenarios are generated.
 * All weights are relative; they control probability distribution.
 */

export interface GenerationWeights {
  // Response types
  responseKinds: {
    text: number
    chunked: number
    reasoning: number
    markdown: number
    raw: number
    tool: number
  }

  // Interaction patterns
  interactions: {
    normal: number
    "double-submit": number
    steer: number
    interrupt: number
    "provider-drop": number
  }

  // Failure modes (for raw responses)
  failures: {
    invalidProviderEvent: number // malformed streaming event
    disconnect: number // abrupt connection drop
    disconnectDuringToolInput: number // drop mid-tool-call
    disconnectAfterTools: number // drop after tool submission
  }

  // Tools to generate
  toolSelection: {
    glob: number
    grep: number
    read: number
    todowrite: number
    shell: number
    write: number
    edit: number
    apply_patch: number
    webfetch: number
    websearch: number
    skill: number
    subagent: number
    question: number
  }
}

/**
 * Default weights: balanced distribution across all options
 */
export const defaultWeights: GenerationWeights = {
  responseKinds: {
    text: 1,
    chunked: 1,
    reasoning: 1,
    markdown: 1,
    raw: 1,
    tool: 1,
  },
  interactions: {
    normal: 3,
    "double-submit": 1,
    steer: 1,
    interrupt: 1,
    "provider-drop": 1,
  },
  failures: {
    invalidProviderEvent: 1,
    disconnect: 1,
    disconnectDuringToolInput: 1,
    disconnectAfterTools: 1,
  },
  toolSelection: {
    glob: 1,
    grep: 1,
    read: 1,
    todowrite: 1,
    shell: 1,
    write: 1,
    edit: 1,
    apply_patch: 1,
    webfetch: 1,
    websearch: 1,
    skill: 1,
    subagent: 1,
    question: 1,
  },
}

/**
 * Parse weights from CLI flags like --weight-text=5 --weight-disconnect=10
 * Format: --weight-<key>=<number>
 * Keys can use dashes or underscores (both map to the same key)
 */
export function parseWeightsFromArgs(args: string[]): GenerationWeights {
  const weights = structuredClone(defaultWeights)
  const keyMap = new Map<string, [category: keyof GenerationWeights, key: string]>()

  // Build map of all known keys
  const typedWeights = weights as Record<keyof GenerationWeights, Record<string, number>>
  Object.entries(typedWeights).forEach(([category, items]) => {
    if (typeof items === "object" && !Array.isArray(items)) {
      Object.keys(items).forEach((key) => {
        keyMap.set(key, [category as keyof GenerationWeights, key])
        keyMap.set(key.replace(/_/g, "-"), [category as keyof GenerationWeights, key])
      })
    }
  })

  for (const arg of args) {
    if (!arg.startsWith("--weight-")) continue
    const [keyStr, valueStr] = arg.slice(9).split("=")
    if (!keyStr || !valueStr) continue

    const value = parseFloat(valueStr)
    if (!isFinite(value) || value < 0) {
      console.warn(`Invalid weight value for --weight-${keyStr}: ${valueStr}`)
      continue
    }

    const found = keyMap.get(keyStr)
    if (!found) {
      console.warn(`Unknown weight key: --weight-${keyStr}`)
      continue
    }

    const [category, key] = found
    typedWeights[category][key] = value
  }

  return weights
}

/**
 * Pick from weighted options using an RNG
 */
export function pickWeighted<T extends readonly string[]>(
  options: T,
  weights: readonly number[],
  random: number,
): T[number] {
  const total = weights.reduce((sum, w) => sum + w, 0)
  let accumulated = 0
  const target = random * total

  for (let i = 0; i < options.length; i++) {
    accumulated += weights[i]!
    if (target <= accumulated) return options[i]!
  }

  return options[options.length - 1]!
}

/**
 * Get weighted probability for a single option from a set
 */
export function shouldGenerate(weight: number, total: number, random: number): boolean {
  return random < weight / total
}

/**
 * Filter tools based on enabled set from CLI
 * Usage: --tools=glob,grep,read or --tools glob,grep,read
 */
export function parseEnabledTools(args: string[]): Set<keyof GenerationWeights["toolSelection"]> | null {
  // Look for --tools= format
  let toolsArg = args.find(arg => arg.startsWith("--tools="))?.slice(8)
  
  // Look for --tools <value> format
  if (!toolsArg) {
    const toolsIndex = args.indexOf("--tools")
    if (toolsIndex !== -1 && toolsIndex + 1 < args.length) {
      toolsArg = args[toolsIndex + 1]
    }
  }
  
  if (!toolsArg) return null
  
  const toolList = toolsArg.split(",").map(t => t.trim()).filter(t => t.length > 0)
  if (toolList.length === 0) return null
  
  const validTools: Set<keyof GenerationWeights["toolSelection"]> = new Set()
  const allTools = new Set(Object.keys(defaultWeights.toolSelection) as Array<keyof GenerationWeights["toolSelection"]>)
  
  for (const tool of toolList) {
    if (allTools.has(tool as keyof GenerationWeights["toolSelection"])) {
      validTools.add(tool as keyof GenerationWeights["toolSelection"])
    } else {
      console.warn(`Unknown tool: ${tool}`)
    }
  }
  
  return validTools.size > 0 ? validTools : null
}

import path from "node:path"
import { generateFlow, type FlowResult } from "./flows/index.js"
import { parseWeightsFromArgs, parseEnabledTools } from "./flows/weights.js"

const config = (seed: number) => {
  const provider = seed % 2 === 0 ? "openai" : "simulation"
  return {
    model: `${provider}/sim-model`,
    permissions: [{ action: "*", resource: "*", effect: seed % 3 === 0 ? "ask" : "allow" }],
    skills: [".opencode/skills"],
    providers: {
      [provider]: {
      name: "Simulation",
      request: { body: { apiKey: "sim-key" } },
      models: {
        "sim-model": {
          name: "Simulated Model",
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.openai.com/v1" },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 16000 },
        },
      },
      },
    },
  }
}

const options = parseArgs(process.argv.slice(2))
const weights = parseWeightsFromArgs(process.argv.slice(2))
const enabledTools = parseEnabledTools(process.argv.slice(2)) ?? undefined
const root = path.resolve(options.out)
await Bun.$`rm -rf ${root}`.quiet()
await Bun.$`mkdir -p ${root}`.quiet()
const results: FlowResult[] = []
const coverage = {
  responseKinds: { text: 0, chunked: 0, reasoning: 0, markdown: 0, raw: 0, tool: 0 },
  toolNames: {} as Record<string, number>,
  interactions: { normal: 0, "double-submit": 0, steer: 0, interrupt: 0, "provider-drop": 0 },
  streamChunkTypes: new Set<string>(),
}

for (let index = 0; index < options.count; index++) {
  const seed = options.seed + index
  const directory = path.join(root, `flow-${String(index + 1).padStart(2, "0")}-${seed}`)
  const state = path.join(directory, "state", "project")
  await Bun.$`mkdir -p ${path.join(state, ".config/opencode")} ${path.join(state, "src")}`.quiet()
  await Bun.$`mkdir -p ${path.join(state, ".opencode/skills/simulation-demo")}`.quiet()
  const scenario = generateFlow(seed, { turns: options.turns, weights, enabledTools })
  coverage.responseKinds.text += scenario.coverage.responseKinds.text
  coverage.responseKinds.chunked += scenario.coverage.responseKinds.chunked
  coverage.responseKinds.reasoning += scenario.coverage.responseKinds.reasoning
  coverage.responseKinds.markdown += scenario.coverage.responseKinds.markdown
  coverage.responseKinds.raw += scenario.coverage.responseKinds.raw
  coverage.responseKinds.tool += scenario.coverage.responseKinds.tool
  for (const [name, count] of Object.entries(scenario.coverage.toolNames)) {
    coverage.toolNames[name] = (coverage.toolNames[name] ?? 0) + count
  }
  coverage.interactions.normal += scenario.coverage.interactions.normal
  coverage.interactions["double-submit"] += scenario.coverage.interactions["double-submit"]
  coverage.interactions.steer += scenario.coverage.interactions.steer
  coverage.interactions.interrupt += scenario.coverage.interactions.interrupt
  coverage.interactions["provider-drop"] += scenario.coverage.interactions["provider-drop"]
  for (const type of scenario.coverage.streamChunkTypes) coverage.streamChunkTypes.add(type)
  await Promise.all([
    Bun.write(path.join(directory, "scenario.json"), `${JSON.stringify(scenario, undefined, 2)}\n`),
    Bun.write(path.join(state, "opencode.json"), `${JSON.stringify(config(seed), undefined, 2)}\n`),
    Bun.write(path.join(state, ".config/opencode/opencode.json"), `${JSON.stringify(config(seed), undefined, 2)}\n`),
    Bun.write(path.join(state, ".opencode/skills/simulation-demo/SKILL.md"), "---\nname: simulation-demo\ndescription: Simulation fixture skill\n---\nUse this skill to exercise the built-in skill loader.\n"),
    Bun.write(path.join(state, "src/example.ts"), "export function greet(name: string) {\n  return `hello ${name}`\n}\n"),
    Bun.write(path.join(state, "src/server.ts"), "export function createServer() {\n  return { close() {} }\n}\n"),
    Bun.write(path.join(state, "src/cache.ts"), "export const invalidate = (key: string) => key\n"),
    Bun.write(path.join(state, "src/config.ts"), "export const loadConfig = () => ({})\n"),
  ])
  const driverLog = path.join(directory, "driver.log")
  const simulationLog = path.join(directory, "simulation.log")
  console.log(`[${index + 1}/${options.count}] seed=${seed} turns=${scenario.turns.length} exchanges=${scenario.coverage.providerExchanges}`)
  const visible = options.renderer === "visible"
  const process = Bun.spawn([
    path.resolve("bin/opencode-sim"),
    "--state", path.join(directory, "state"),
    "--anchor", path.join(directory, "anchor"),
    "--renderer", options.renderer,
    "--driver", `bun ${path.resolve("src/flow-driver.ts")} ${path.join(directory, "scenario.json")} ${path.join(directory, "result.json")}`,
    "--",
    "bun", "run", "--conditions=browser", "--preload=@opentui/solid/preload",
    "/root/projects/opencode-latest/packages/cli/src/index.ts", "--standalone",
  ], {
    cwd: path.resolve("."),
    env: {
      ...processEnv(),
      OPENCODE_SIMULATION_DRIVER_LOG: driverLog,
      OPENCODE_SIMULATION_LOG: simulationLog,
      OPENCODE_PROBE_STEP_DELAY: String(options.stepDelay),
      OPENCODE_PROBE_CHUNK_DELAY: String(options.chunkDelay),
    },
    stdin: visible ? "inherit" : "ignore",
    stdout: visible ? "inherit" : "pipe",
    stderr: visible ? "inherit" : "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    process.stdout instanceof ReadableStream ? new Response(process.stdout).text() : "",
    process.stderr instanceof ReadableStream ? new Response(process.stderr).text() : "",
  ])
  if (status !== 0) {
    throw new Error(`flow ${index + 1} failed (seed ${seed})\n${stdout}\n${stderr}\n${await Bun.file(driverLog).text()}`)
  }
  const result: FlowResult = await Bun.file(path.join(directory, "result.json")).json()
  results.push(result)
  console.log(`  passed in ${result.durationMs}ms; trace=${result.traceRecords} title=${result.titleExchanges}`)
}

const summary = {
  count: results.length,
  seed: options.seed,
  turns: results.reduce((total, result) => total + result.turns, 0),
  assistantExchanges: results.reduce((total, result) => total + result.assistantExchanges, 0),
  subagentExchanges: results.reduce((total, result) => total + result.subagentExchanges, 0),
  titleExchanges: results.reduce((total, result) => total + result.titleExchanges, 0),
  traceRecords: results.reduce((total, result) => total + result.traceRecords, 0),
  durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  coverage: { ...coverage, streamChunkTypes: [...coverage.streamChunkTypes] },
}
await Bun.write(path.join(root, "summary.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
console.log(`Campaign passed: ${JSON.stringify(summary)}`)

function parseArgs(args: string[]) {
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : (args[index + 1] ?? fallback)
  }
  return {
    count: Number(value("--count", "10")),
    seed: Number(value("--seed", String(Date.now() % 1_000_000))),
    turns: Number(value("--turns", "7")),
    out: value("--out", "/tmp/opencode-probe-campaign"),
    renderer: value("--renderer", "fake") === "visible" ? "visible" as const : "fake" as const,
    stepDelay: Number(value("--step-delay", "0")),
    chunkDelay: Number(value("--chunk-delay", "30")),
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

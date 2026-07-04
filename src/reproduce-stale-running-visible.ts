import path from "node:path"

const root = "/tmp/opencode-probe-stale-running-visible"
const state = path.join(root, "state", "project")
await Bun.$`rm -rf ${root}`.quiet()
await Bun.$`mkdir -p ${path.join(state, ".config/opencode")} ${path.join(state, "src")}`.quiet()

const config = {
  model: "simulation/sim-model",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: {
    simulation: {
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

await Promise.all([
  Bun.write(path.join(state, "opencode.json"), `${JSON.stringify(config, undefined, 2)}\n`),
  Bun.write(path.join(state, ".config/opencode/opencode.json"), `${JSON.stringify(config, undefined, 2)}\n`),
  Bun.write(path.join(state, "src/example.ts"), "export const example = true\n"),
])

const child = Bun.spawn([
  path.resolve("bin/opencode-sim"),
  "--state", path.join(root, "state"),
  "--anchor", path.join(root, "anchor"),
  "--renderer", "visible",
  "--driver", `bun ${path.resolve("src/stale-running-driver.ts")}`,
  "--",
  "bun", "run", "--conditions=browser", "--preload=@opentui/solid/preload",
  "/root/projects/opencode-latest/packages/cli/src/index.ts", "--standalone",
], {
  cwd: path.resolve("."),
  env: {
    ...processEnv(),
    OPENCODE_SIMULATION_DRIVER_LOG: path.join(root, "driver.log"),
    OPENCODE_SIMULATION_LOG: path.join(root, "simulation.log"),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const status = await child.exited
if (status !== 0) throw new Error(`visible reproduction failed; see ${path.join(root, "driver.log")}`)
console.log(`Reproduction artifacts: ${root}`)

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

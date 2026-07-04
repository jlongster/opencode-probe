import { connectBackendSimulation, connectSimulation, type OpenedExchange } from "./client/index.js"

const ui = await connectSimulation({ url: requiredEnv("OPENCODE_SIMULATION_UI_WS") })
const backend = await connectBackendSimulation({ url: requiredEnv("OPENCODE_SIMULATION_BACKEND_WS") })
let completed!: () => void
const responseCompleted = new Promise<void>((resolve) => {
  completed = resolve
})

await backend.attach(async (request: OpenedExchange) => {
  await backend.chunk(request.id, [{ type: "textDelta", text: "hello" }])
  await backend.finish(request.id, "stop")
  completed()
})

try {
  await waitFor(async () => (await ui.render()).focused.editor)
  await ui.typeText("Say hello")
  await ui.pressEnter()
  await responseCompleted
  await waitFor(async () => (await backend.pendingExchanges()).exchanges.length === 0)
  await ui.render()
  await Bun.sleep(Number(process.env.OPENCODE_PROBE_HOLD_MS ?? "10000"))
} finally {
  ui.close()
  backend.close()
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for UI state")
}

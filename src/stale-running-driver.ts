import { connectBackendSimulation, connectSimulation, type OpenedExchange } from "./client/index.js"
import { isRunning } from "./flows/index.js"

const ui = await connectSimulation({ url: requiredEnv("OPENCODE_SIMULATION_UI_WS") })
const backend = await connectBackendSimulation({ url: requiredEnv("OPENCODE_SIMULATION_BACKEND_WS") })
const requestOpened = deferred()
const releaseResponse = deferred()
const responseFinished = deferred()

await backend.attach(async (request: OpenedExchange) => {
  if (isTitleRequest(request)) {
    await backend.chunk(request.id, [{ type: "textDelta", text: "Stale running reproduction" }])
    await backend.finish(request.id, "stop")
    return
  }
  requestOpened.resolve()
  await backend.chunk(request.id, [{ type: "textDelta", text: "The provider turn is finishing while events are disconnected." }])
  await releaseResponse.promise
  await backend.finish(request.id, "stop")
  responseFinished.resolve()
})

try {
  await waitFor("prompt editor", async () => (await ui.render()).focused.editor)
  await ui.typeText("Reproduce stale running status across an event-stream reconnect")
  await ui.pressEnter()
  await requestOpened.promise
  await waitFor("running TUI", async () => isRunning(await ui.render()))

  await ui.eventPause()
  releaseResponse.resolve()
  await responseFinished.promise
  await waitFor("provider drain", async () => (await backend.pendingExchanges()).exchanges.length === 0)
  await Bun.sleep(300)

  await ui.eventResume()
  await waitFor("event reconnect", async () => (await ui.eventState()).state === "connected")
  await Bun.sleep(1_000)

  const state = await ui.render()
  if (!isRunning(state)) throw new Error("stale running status was not reproduced")
  console.log("REPRODUCED: backend provider work is idle while the TUI still displays running.")
  await Bun.sleep(Number(process.env.OPENCODE_PROBE_HOLD_MS ?? "10000"))
} finally {
  ui.close()
  backend.close()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

function isTitleRequest(request: OpenedExchange) {
  if (typeof request.body !== "object" || request.body === null || !("messages" in request.body)) return false
  const messages = request.body.messages
  if (!Array.isArray(messages)) return false
  const first = messages[0]
  if (typeof first !== "object" || first === null || !("content" in first)) return false
  return typeof first.content === "string" && first.content.includes("You are a title generator")
}

async function waitFor(label: string, check: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

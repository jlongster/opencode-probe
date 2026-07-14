const serviceMode = process.env.OPENCODE_DRIVE_SCRIPTED === "1"
const role = serviceMode
  ? process.argv.at(-2) === "serve" && process.argv.at(-1) === "--service"
    ? "service"
    : "client"
  : "legacy"
if (role === "service" && process.env.OPENCODE_TEST_HOME)
  await Promise.all([
    Bun.write(`${process.env.OPENCODE_TEST_HOME}/service.pid`, String(process.pid)),
    Bun.write(`${process.env.OPENCODE_TEST_HOME}/service-argv.json`, JSON.stringify(process.argv.slice(2))),
  ])

const screen = { value: `Fake OpenCode${role === "client" ? ` ${process.env.OPENCODE_DRIVE}` : ""}` }
const drive = await resolveDrive()
const endpoints = drive.endpoints
if (drive.recording && role !== "service")
  await Bun.write(
    drive.recording.timeline,
    `${JSON.stringify({ type: "header", version: 1, cols: 100, rows: 40, encoding: "base64" })}\n${JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("Fake OpenCode").toString("base64") })}\n`,
  )
if (process.env.OPENCODE_TEST_HOME && role !== "service") {
  await Bun.write(
    `${process.env.OPENCODE_TEST_HOME}/child.pid`,
    String(process.pid),
  )
  const launches = `${process.env.OPENCODE_TEST_HOME}/launches.txt`
  await appendFile(launches, "launch\n")
  await Bun.write(
    `${process.env.OPENCODE_TEST_HOME}/renderer.txt`,
    process.env.OPENCODE_DRIVE_RENDERER ?? "missing",
  )
  await Bun.write(
    `${process.env.OPENCODE_TEST_HOME}/child-cwd.txt`,
    process.cwd(),
  )
  const seeded = `${process.cwd()}/src/seeded.ts`
  if (await Bun.file(seeded).exists())
    await Bun.write(
      `${process.env.OPENCODE_TEST_HOME}/seeded-at-launch.txt`,
      await Bun.file(seeded).text(),
    )
}

const ui = role === "service" || process.argv.includes("no-ui") ? undefined : Bun.serve({
  hostname: "127.0.0.1",
  port: Number(new URL(endpoints.ui).port),
  fetch(request, server) {
    if (server.upgrade(request)) return
    return new Response("drive websocket", { status: 426 })
  },
  websocket: {
    message(socket, input) {
      const request = JSON.parse(String(input)) as {
        readonly id?: number
        readonly method: string
        readonly params?: unknown
      }
      const result = frontend(request.method, request.params)
      if (request.id !== undefined)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
    },
  },
})

const backend = role === "client" ? undefined : Bun.serve({
  hostname: "127.0.0.1",
  port: Number(new URL(endpoints.backend).port),
  fetch(request, server) {
    if (server.upgrade(request)) return
    return new Response("drive websocket", { status: 426 })
  },
  websocket: {
    async message(socket, input) {
      const request = JSON.parse(String(input)) as {
        readonly id?: number
        readonly method: string
        readonly params?: unknown
      }
      if (request.method === "llm.chunk" && process.env.OPENCODE_TEST_HOME) {
        await Bun.write(
          `${process.env.OPENCODE_TEST_HOME}/mock-response.json`,
          JSON.stringify(request.params),
        )
      }
      if (request.method.startsWith("llm.") && process.env.OPENCODE_TEST_HOME) {
        const events = `${process.env.OPENCODE_TEST_HOME}/backend-events.jsonl`
        await appendFile(
          events,
          `${JSON.stringify({ method: request.method, params: request.params })}\n`,
        )
      }
      const result =
        request.method === "llm.attach" ? { attached: true } : { ok: true }
      if (request.id !== undefined)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
      if (request.method === "llm.attach") {
        const requestDelay = Number(process.argv[3])
        if (Number.isFinite(requestDelay)) await Bun.sleep(requestDelay)
        if (process.argv.includes("title-requests"))
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "llm.request",
              params: {
                id: "ex_title",
                url: "https://api.openai.com/v1/chat/completions",
                body: {
                  messages: [
                    {
                      role: "system",
                      content: "You are a title generator. You output ONLY a thread title.",
                    },
                  ],
                },
              },
            }),
          )
        if (process.argv.includes("latest-title-requests"))
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "llm.request",
              params: {
                id: "ex_title",
                url: "https://api.openai.com/v1/chat/completions",
                body: {
                  messages: [
                    {
                      role: "user",
                      content: "Generate a title for this conversation:\n",
                    },
                    {
                      role: "user",
                      content: "Show a compact status report for the viewport resize demo.",
                    },
                  ],
                },
              },
            }),
          )
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "llm.request",
            params: {
              id: "ex_mock",
              url: "https://api.openai.com/v1/chat/completions",
              body: {},
            },
          }),
        )
      }
    },
  },
})

if (process.argv.includes("write-stdio")) {
  console.log(`fake opencode ${role} stdout`)
  console.error(`fake opencode ${role} stderr`)
}

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve)
  if (process.argv.includes("ignore-sigterm"))
    process.on("SIGTERM", () => undefined)
  else process.once("SIGTERM", resolve)
  const lifetime = role === "service" ? Number.NaN : Number(process.argv[2])
  if (Number.isFinite(lifetime)) setTimeout(resolve, lifetime)
})
await Promise.all([ui?.stop(true), backend?.stop(true)])

function frontend(method: string, params: unknown) {
  if (method === "ui.screenshot") {
    const name = isRecord(params) && typeof params.name === "string"
      ? params.name
      : `screenshot-${crypto.randomUUID()}`
    return `${process.env.OPENCODE_DRIVE_MEDIA_DIR}/${name}.png`
  }
  if (method === "ui.recording.finish") {
    if (!drive.recording) throw new Error("recording is not enabled")
    return drive.recording.timeline
  }
  if (method === "ui.matches" && isRecord(params) && typeof params.text === "string")
    return screen.value.includes(params.text)
  if (
    method === "ui.type" &&
    isRecord(params) &&
    typeof params.text === "string"
  )
    screen.value += `\n${params.text}`
  if (method === "ui.enter") screen.value += "\n[enter]"
  if (method === "trace.list" || method === "trace.export")
    return { records: [] }
  if (method === "trace.clear") return { cleared: true }
  return {
    screen: screen.value,
    focused: { renderable: 1, editor: true },
    elements: [
      {
        id: "prompt",
        num: 1,
        x: 0,
        y: 0,
        width: 80,
        height: 1,
        focusable: true,
        focused: true,
        clickable: true,
        editor: true,
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveDrive() {
  if (process.env.DRIVE_REGISTRY_DIR && process.env.OPENCODE_DRIVE !== "1") {
    const manifest = (await Bun.file(
      `${process.env.DRIVE_REGISTRY_DIR}/${process.env.OPENCODE_DRIVE}.json`,
    ).json()) as {
      readonly endpoints: { readonly ui: string; readonly backend: string }
      readonly recording?: { readonly timeline: string }
    }
    return manifest
  }
  return {
    endpoints: {
      ui: "ws://127.0.0.1:40900",
      backend: "ws://127.0.0.1:40950",
    },
    recording: { timeline: "/tmp/opencode-drive-fake/recording.jsonl" },
  }
}
import { appendFile } from "node:fs/promises"

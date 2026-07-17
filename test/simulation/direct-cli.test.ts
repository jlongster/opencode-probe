import { expect, test } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const state = {
  focused: { renderable: 1, editor: true },
  elements: [],
}

test.sequential("CLI drives an externally owned OpenCode endpoint on the default port", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-drive-direct-test-"))
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 40900,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("external OpenCode simulation endpoint", {
        status: 426,
      })
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message)) as {
          readonly id: number
          readonly method: string
        }
        if (request.method === "simulation.handshake") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "method not found" },
            }),
          )
          return
        }
        requests.push(request)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: request.method === "ui.screenshot" ? "/tmp/home.png" : state,
          }),
        )
      },
    },
  })

  try {
    const first = await sendState(root)
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual(state)

    const second = await sendState(root)
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout)).toEqual(state)

    const screenshot = await send(root, ["--command.ui.screenshot", '{"name":"home"}'])
    expect(screenshot.status).toBe(0)
    expect(screenshot.stdout.trim()).toBe("/tmp/home.png")

    expect(requests).toEqual([
      { jsonrpc: "2.0", id: 1, method: "ui.state" },
      { jsonrpc: "2.0", id: 1, method: "ui.state" },
      { jsonrpc: "2.0", id: 1, method: "ui.screenshot", params: { name: "home" } },
    ])
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

async function sendState(root: string) {
  return send(root, ["--command.ui.state"])
}

async function send(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("src/cli/index.ts"), "send", ...args], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DRIVE_REGISTRY_DIR: join(root, "registry"),
      TMPDIR: root,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr }
}

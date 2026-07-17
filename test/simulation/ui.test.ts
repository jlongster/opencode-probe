import { describe, expect, test } from "vitest"
import { Frontend, SimulationClient, SimulationError, connectSimulation } from "../../src/client/index.js"
import { sendError, sendResult, startTransportPeer } from "./transport-peer.js"

const state: Frontend.State = {
  focused: { renderable: 1, editor: true },
  elements: [],
}

describe("OpenCode UI simulation transport", () => {
  test("preserves every public call's exact JSON-RPC frame", async () => {
    const screenshots: string[] = []
    const peer = startTransportPeer(({ request, socket }) => {
      if (request.method === "ui.matches") {
        sendResult(socket, request, true)
        return
      }
      if (request.method === "ui.screenshot") {
        const params = request.params as { readonly name?: string } | undefined
        if (params?.name === "fail") {
          sendError(socket, request, "screenshot failed")
          return
        }
        sendResult(socket, request, `/tmp/${params?.name ?? "screenshot"}.png`)
        return
      }
      if (request.method === "ui.recording.finish") {
        sendResult(socket, request, "/tmp/recording.jsonl")
        return
      }
      sendResult(socket, request, state)
    })
    const client = await connectSimulation({
      url: peer.url,
      onScreenshot: (path) => screenshots.push(path),
    })

    try {
      expect(client).toBeInstanceOf(SimulationClient)
      expect(client.url).toBe(peer.url)
      expect(await client.state()).toEqual(state)
      expect(await client.matches("needle")).toBe(true)
      expect(await client.screenshot()).toBe("/tmp/screenshot.png")
      expect(await client.screenshot("home")).toBe("/tmp/home.png")
      expect(await client.finishRecording()).toBe("/tmp/recording.jsonl")
      expect(await client.typeText("hello")).toEqual(state)
      expect(await client.pressKey("x")).toEqual(state)
      expect(await client.pressKey("x", { ctrl: true, shift: false })).toEqual(state)
      expect(await client.pressKey("escape")).toEqual(state)
      expect(await client.pressEnter()).toEqual(state)
      expect(await client.pressArrow("left")).toEqual(state)
      expect(await client.focus(7)).toEqual(state)
      expect(await client.click(7, 3, 2)).toEqual(state)
      expect(await client.resize({ cols: 120, rows: 40 })).toEqual(state)

      const error = await client.screenshot("fail").catch((error) => error)
      expect(error).toBeInstanceOf(SimulationError)
      expect(error).toMatchObject({
        message: "screenshot failed",
        method: "ui.screenshot",
      })
      expect(screenshots).toEqual(["/tmp/screenshot.png", "/tmp/home.png"])

      expect(peer.received.map(({ request }) => request)).toEqual([
        { jsonrpc: "2.0", id: 1, method: "ui.state" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "ui.matches",
          params: { text: "needle" },
        },
        { jsonrpc: "2.0", id: 3, method: "ui.screenshot" },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "ui.screenshot",
          params: { name: "home" },
        },
        { jsonrpc: "2.0", id: 5, method: "ui.recording.finish" },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "ui.type",
          params: { text: "hello" },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "ui.press",
          params: { key: "x" },
        },
        {
          jsonrpc: "2.0",
          id: 8,
          method: "ui.press",
          params: { key: "x", modifiers: { ctrl: true, shift: false } },
        },
        {
          jsonrpc: "2.0",
          id: 9,
          method: "ui.press",
          params: { key: "escape" },
        },
        { jsonrpc: "2.0", id: 10, method: "ui.enter" },
        {
          jsonrpc: "2.0",
          id: 11,
          method: "ui.arrow",
          params: { direction: "left" },
        },
        {
          jsonrpc: "2.0",
          id: 12,
          method: "ui.focus",
          params: { target: 7 },
        },
        {
          jsonrpc: "2.0",
          id: 13,
          method: "ui.click",
          params: { target: 7, x: 3, y: 2 },
        },
        {
          jsonrpc: "2.0",
          id: 14,
          method: "ui.resize",
          params: { cols: 120, rows: 40 },
        },
        {
          jsonrpc: "2.0",
          id: 15,
          method: "ui.screenshot",
          params: { name: "fail" },
        },
      ])

      for (const { request } of peer.received) expect(Frontend.decodeRequest(request)).toEqual(request)
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("rejects schema-invalid UI requests", () => {
    expect(() => Frontend.decodeRequest({ jsonrpc: "2.0", method: "ui.type", params: {} })).toThrow()
    expect(() =>
      Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.arrow",
        params: { direction: "diagonal" },
      }),
    ).toThrow()
    expect(() =>
      Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.press",
        params: { key: "x", modifiers: { ctrl: "true" } },
      }),
    ).toThrow()
  })
})

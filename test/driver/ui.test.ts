import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as OpenCodeUi from "../../src/driver/ui.js"
import * as SimulationConnector from "../../src/simulation/connector.js"
import { sendError, sendResult, startTransportPeer } from "../simulation/transport-peer.js"

const editor = {
  id: "prompt",
  num: 3,
  x: 2,
  y: 4,
  width: 20,
  height: 6,
  focusable: true,
  focused: true,
  clickable: true,
  editor: true,
}

const state = {
  focused: { renderable: 3, editor: true },
  elements: [editor],
}

describe("OpenCodeUi", () => {
  it.live("captures a normalized terminal frame", () => {
    const frame = {
      cols: 2,
      rows: 1,
      cursor: [0, 0] as const,
      lines: [{ spans: [{ text: "ok", fg: [255, 255, 255, 255] as const, bg: [0, 0, 0, 255] as const, attributes: 0, width: 2 }] }],
    }
    const peer = startTransportPeer(({ request, socket }) => sendResult(socket, request, frame))

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const connection = yield* SimulationConnector.ui(peer.url)
      expect(yield* OpenCodeUi.make(connection).capture()).toEqual(frame)
      expect(peer.received.map(({ request }) => request)).toEqual([
        { jsonrpc: "2.0", id: 1, method: "ui.capture" },
      ])
    })
  })

  it.live("wraps generated UI RPCs with user-level operations", () => {
    let matchCalls = 0
    const peer = startTransportPeer(({ request, socket }) => {
      if (request.method === "ui.matches") {
        matchCalls++
        sendResult(socket, request, matchCalls > 1)
        return
      }
      if (request.method === "ui.screenshot") {
        sendResult(socket, request, "/tmp/home.png")
        return
      }
      sendResult(socket, request, state)
    })

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const connection = yield* SimulationConnector.ui(peer.url)
      const ui = OpenCodeUi.make(connection)

      expect(yield* ui.submit("hello")).toEqual(state)
      expect(yield* ui.press("escape", { ctrl: true })).toEqual(state)
      expect(yield* ui.click(3)).toEqual(state)
      expect(yield* ui.screenshot("home")).toBe("/tmp/home.png")
      expect(yield* ui.waitFor("ready", { timeout: 1_000, interval: 1 })).toEqual(state)
      expect(yield* ui.getElement({ editor: true })).toEqual(editor)

      expect(peer.received.map(({ request }) => request)).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "ui.type",
          params: { text: "hello" },
        },
        { jsonrpc: "2.0", id: 2, method: "ui.enter" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "ui.press",
          params: { key: "escape", modifiers: { ctrl: true } },
        },
        { jsonrpc: "2.0", id: 4, method: "ui.state" },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "ui.click",
          params: { target: 3, x: 10, y: 3 },
        },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "ui.screenshot",
          params: { name: "home" },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "ui.matches",
          params: { text: "ready" },
        },
        {
          jsonrpc: "2.0",
          id: 8,
          method: "ui.matches",
          params: { text: "ready" },
        },
        { jsonrpc: "2.0", id: 9, method: "ui.state" },
        { jsonrpc: "2.0", id: 10, method: "ui.state" },
      ])
    })
  })

  it.live("reports ambiguous elements as typed UI failures", () => {
    const peer = startTransportPeer(({ request, socket }) =>
      sendResult(socket, request, {
        ...state,
        elements: [editor, { ...editor, num: 4 }],
      }),
    )

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const connection = yield* SimulationConnector.ui(peer.url)
      const error = yield* OpenCodeUi.make(connection).getElement({ editor: true }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(OpenCodeUi.UiElementAmbiguousError)
      expect(error).toMatchObject({
        count: 2,
        message: "ui.getElement matched 2 elements",
      })
    })
  })

  it.live("interrupts timed-out polling and remains usable", () => {
    const peer = startTransportPeer(({ request, socket }) => {
      if (request.method === "ui.matches") return
      sendResult(socket, request, state)
    })

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const connection = yield* SimulationConnector.ui(peer.url)
      const ui = OpenCodeUi.make(connection)
      const error = yield* ui.waitFor("never", { timeout: 20, interval: 100 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(OpenCodeUi.UiTimeoutError)
      expect(error).toMatchObject({
        operation: "waitFor",
        milliseconds: 20,
      })
      expect(yield* ui.state()).toEqual(state)
      expect(peer.received.map(({ request }) => request)).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "ui.matches",
          params: { text: "never" },
        },
        { jsonrpc: "2.0", id: 2, method: "ui.state" },
      ])
    })
  })

  it.live("does not retry RPC failures while polling", () => {
    const peer = startTransportPeer(({ request, socket }) => sendError(socket, request, "match failed"))

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const connection = yield* SimulationConnector.ui(peer.url)
      const error = yield* OpenCodeUi.make(connection)
        .waitFor("ready", { timeout: 1_000, interval: 1 })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "SimulationRequestError",
        method: "ui.matches",
        message: "match failed",
      })
      expect(peer.received).toHaveLength(1)
    })
  })
})

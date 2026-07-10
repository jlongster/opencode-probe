import { connectSimulation, Frontend } from "../client/index.js"
import type { DriveCommand } from "./types.js"

export const commandInfo = {
  "ui.type": { value: true, description: "Type text using JSON params" },
  "ui.press": { value: true, description: "Press a key using JSON params" },
  "ui.enter": { value: false, description: "Press Enter" },
  "ui.arrow": {
    value: true,
    description: "Press an arrow key using JSON params",
  },
  "ui.focus": {
    value: true,
    description: "Focus an element using JSON params",
  },
  "ui.click": { value: true, description: "Click using JSON params" },
  "ui.resize": {
    value: true,
    description: "Resize terminal viewport using JSON params",
  },
  "ui.screenshot": {
    value: false,
    description: "Take a screenshot and return its path",
  },
  "ui.state": {
    value: false,
    description: "Return focus, elements, and available UI actions",
  },
  "ui.matches": {
    value: true,
    description: "Check for literal screen text using JSON params",
  },
  "ui.recording.finish": {
    value: false,
    description: "Finish recording and return the timeline path",
  },
} as const

export function commandAcceptsValue(operation: string) {
  if (operation === "ui.type") return commandInfo[operation].value
  if (operation === "ui.press") return commandInfo[operation].value
  if (operation === "ui.enter") return commandInfo[operation].value
  if (operation === "ui.arrow") return commandInfo[operation].value
  if (operation === "ui.focus") return commandInfo[operation].value
  if (operation === "ui.click") return commandInfo[operation].value
  if (operation === "ui.resize") return commandInfo[operation].value
  if (operation === "ui.screenshot") return commandInfo[operation].value
  if (operation === "ui.state") return commandInfo[operation].value
  if (operation === "ui.matches") return commandInfo[operation].value
  if (operation === "ui.recording.finish") return commandInfo[operation].value
  throw new Error(`unknown drive command "${operation}"`)
}

export function commandNames() {
  return Object.keys(commandInfo).sort()
}

export async function executeCommands(
  endpoint: string,
  commands: ReadonlyArray<DriveCommand>,
) {
  const ui = await connectSimulation({ url: endpoint })
  const results: Array<{ readonly command: string; readonly result: unknown }> =
    []
  try {
    for (const command of commands)
      results.push({
        command: command.operation,
        result: await execute(command, ui),
      })
    return { results }
  } catch (error) {
    throw new CommandBatchError(results, error)
  } finally {
    ui.close()
  }
}

export class CommandBatchError extends Error {
  constructor(
    readonly results: ReadonlyArray<{
      readonly command: string
      readonly result: unknown
    }>,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = "CommandBatchError"
  }
}

async function execute(
  command: DriveCommand,
  ui: Awaited<ReturnType<typeof connectSimulation>>,
) {
  switch (command.operation) {
    case "ui.type": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.type",
        params: json(required(command)),
      })
      if (request.method !== "ui.type")
        throw new Error("invalid ui.type params")
      return ui.typeText(request.params.text)
    }
    case "ui.press": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.press",
        params: json(required(command)),
      })
      if (request.method !== "ui.press")
        throw new Error("invalid ui.press params")
      return ui.pressKey(request.params.key, request.params.modifiers)
    }
    case "ui.enter":
      return ui.pressEnter()
    case "ui.arrow": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.arrow",
        params: json(required(command)),
      })
      if (request.method !== "ui.arrow")
        throw new Error("invalid ui.arrow params")
      return ui.pressArrow(request.params.direction)
    }
    case "ui.focus": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.focus",
        params: json(required(command)),
      })
      if (request.method !== "ui.focus")
        throw new Error("invalid ui.focus params")
      return ui.focus(request.params.target)
    }
    case "ui.click": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.click",
        params: json(required(command)),
      })
      if (request.method !== "ui.click")
        throw new Error("invalid ui.click params")
      return ui.click(request.params.target, request.params.x, request.params.y)
    }
    case "ui.resize": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.resize",
        params: json(required(command)),
      })
      if (request.method !== "ui.resize")
        throw new Error("invalid ui.resize params")
      return ui.resize(request.params)
    }
    case "ui.screenshot":
      return ui.screenshot()
    case "ui.state":
      return ui.state()
    case "ui.matches": {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method: "ui.matches",
        params: json(required(command)),
      })
      if (request.method !== "ui.matches")
        throw new Error("invalid ui.matches params")
      return ui.matches(request.params.text)
    }
    case "ui.recording.finish":
      return ui.finishRecording()
  }
  throw new Error(`unknown drive command "${command.operation}"`)
}

function required(command: DriveCommand) {
  if (command.value === undefined)
    throw new Error(`${command.operation} requires a value`)
  return command.value
}

function json(value: string): unknown {
  return JSON.parse(value)
}

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { connectBackendSimulation, connectSimulation } from "../client/index.js"
import type {
  BackendSimulationClient,
  SimulationClient,
} from "../client/index.js"

export interface ScriptContext {
  readonly ui: SimulationClient
  readonly backend: BackendSimulationClient
  readonly artifacts: string
  readonly signal: AbortSignal
}

export type DriveScript = (context: ScriptContext) => void | Promise<void>

export interface ScriptSetupContext {
  readonly directory: string
}

export type DriveScriptSetup = (
  context: ScriptSetupContext,
) => void | Promise<void>

export interface LoadedDriveScript {
  readonly run: DriveScript
  readonly setup?: DriveScriptSetup
}

export function defineScript(script: DriveScript) {
  return script
}

export async function loadScript(file: string): Promise<LoadedDriveScript> {
  const module: { readonly default?: unknown; readonly setup?: unknown } =
    await import(pathToFileURL(resolve(file)).href)
  if (!isDriveScript(module.default))
    throw new Error("script must default-export a function")
  if (module.setup !== undefined && !isDriveScriptSetup(module.setup))
    throw new Error("script setup export must be a function")
  return {
    run: module.default,
    ...(module.setup === undefined ? {} : { setup: module.setup }),
  }
}

export async function runScript(
  script: DriveScript,
  artifacts: string,
  endpoints: { readonly ui: string; readonly backend: string },
  signal: AbortSignal,
  onScreenshot?: (path: string) => void,
) {
  const ui = await connectSimulation({ url: endpoints.ui, onScreenshot })
  const backend = await connectBackendSimulation({
    url: endpoints.backend,
  }).catch((error) => {
    ui.close()
    throw error
  })
  const abort = () => {
    ui.close()
    backend.close()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    await waitForEditor(ui, signal)
    await Promise.race([
      script({ ui, backend, artifacts, signal }),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("script restarted")),
          { once: true },
        )
      }),
    ])
  } finally {
    signal.removeEventListener("abort", abort)
    ui.close()
    backend.close()
  }
}

async function waitForEditor(ui: SimulationClient, signal: AbortSignal) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if ((await ui.state()).focused.editor) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for the prompt editor")
}

function isDriveScript(value: unknown): value is DriveScript {
  return typeof value === "function"
}

function isDriveScriptSetup(value: unknown): value is DriveScriptSetup {
  return typeof value === "function"
}

import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensureMediaDirectory } from "./media.js"
import type { DriveScriptSetup } from "./script.js"

export interface LaunchOptions {
  readonly name: string
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly scripted?: boolean
  readonly visible?: boolean
  readonly record?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly setup?: DriveScriptSetup
}

export async function launchInstance(options: LaunchOptions) {
  const artifacts = resolve(
    join(tmpdir(), "opencode-drive", `run-${crypto.randomUUID().slice(0, 6)}`),
  )
  const logs = join(artifacts, "logs")
  const endpoints = {
    ui: `ws://127.0.0.1:${await freePort()}`,
    backend: `ws://127.0.0.1:${await freePort()}`,
  }
  const drive = join(artifacts, "drive")
  const media = await ensureMediaDirectory()
  await Promise.all([
    mkdir(logs, { recursive: true }),
    mkdir(drive, { recursive: true }),
    mkdir(join(artifacts, "home", ".cache"), { recursive: true }),
    mkdir(join(artifacts, "home", ".config"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "share"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "state"), { recursive: true }),
  ])
  let recording = options.record ? recordingPaths(media) : undefined
  const writeDriveManifest = () =>
    Bun.write(
      join(drive, `${options.name}.json`),
      `${JSON.stringify(
        {
          endpoints,
          ...(recording ? { recording: { timeline: recording.timeline } } : {}),
        },
        undefined,
        2,
      )}\n`,
    )
  await writeDriveManifest()
  const files = join(artifacts, "files")
  await Promise.all([
    mkdir(join(files, ".git"), { recursive: true }),
    mkdir(join(files, ".opencode"), { recursive: true }),
    mkdir(join(files, "src"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(
      join(files, ".opencode", "opencode.jsonc"),
      `${JSON.stringify(
        {
          model: "simulation/gpt-sim-model",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          providers: {
            simulation: {
              name: "Simulation",
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { baseURL: "https://api.openai.com/v1" },
              request: { body: { apiKey: "sim-key" } },
              models: {
                "gpt-sim-model": {
                  name: "Simulated Model",
                  capabilities: {
                    tools: true,
                    input: ["text"],
                    output: ["text"],
                  },
                  limit: { context: 128000, output: 16000 },
                },
              },
            },
          },
        },
        undefined,
        2,
      )}\n`,
    ),
    Bun.write(
      join(files, "src", "garden.js"),
      'export function greet(name) {\n  return `Hello, ${name}.`\n}\n',
    ),
  ])
  await options.setup?.({ directory: files })
  const environment = cleanEnv({
    ...process.env,
    ...options.env,
    OPENCODE_SIMULATE: "1",
    DRIVE_REGISTRY_DIR: drive,
    OPENCODE_DRIVE: options.name,
    OPENCODE_DRIVE_RENDERER: options.visible ? "visible" : "headless",
    OPENCODE_CONFIG_DIR: join(files, ".opencode"),
    OPENCODE_DB: ":memory:",
    OPENCODE_LOG_LEVEL: !options.visible
      ? "INFO"
      : process.env.OPENCODE_LOG_LEVEL,
    OPENCODE_TEST_HOME: artifacts,
    XDG_CACHE_HOME: join(artifacts, "home", ".cache"),
    XDG_CONFIG_HOME: join(artifacts, "home", ".config"),
    XDG_DATA_HOME: logs,
    XDG_STATE_HOME: join(artifacts, "home", ".local", "state"),
  })
  const command = options.dev
    ? await prepareDev(files, options.dev)
    : options.command?.length
      ? [...options.command]
      : ["opencode2"]
  const spawn = () =>
    Bun.spawn(command, {
      cwd: files,
      env: environment,
      stdin: options.visible ? "inherit" : "ignore",
      stdout: !options.visible
        ? Bun.file(join(logs, "opencode.stdout.log"))
        : "inherit",
      stderr: !options.visible
        ? Bun.file(join(logs, "opencode.stderr.log"))
        : "inherit",
    })
  let child = spawn()
  let stopping: Promise<void> | undefined
  let restarting: Promise<void> | undefined
  return {
    artifacts,
    logs,
    endpoints,
    get recording() {
      return recording
    },
    get child() {
      return child
    },
    async waitForDrive(
      requirement: "ui" | "backend" | "both" = "both",
      timeout = 60_000,
    ) {
      const urls =
        requirement === "both"
          ? [endpoints.ui, endpoints.backend]
          : [endpoints[requirement]]
      await Promise.all(
        urls.map((url) => waitForWebSocket(url, child.exited, timeout)),
      )
    },
    async restart() {
      if (restarting) return restarting
      restarting = (async () => {
        await terminate(child)
        recording = options.record ? recordingPaths(media) : undefined
        await writeDriveManifest()
        child = spawn()
        await Promise.all([
          waitForWebSocket(endpoints.ui, child.exited, 60_000),
          waitForWebSocket(endpoints.backend, child.exited, 60_000),
        ])
      })().finally(() => {
        restarting = undefined
      })
      return restarting
    },
    async wait() {
      while (true) {
        const current = child
        const status = await current.exited
        if (restarting) {
          await restarting
          continue
        }
        if (current !== child) continue
        return status
      }
    },
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (restarting) await restarting.catch(() => undefined)
        await terminate(child)
        await stopService(join(artifacts, "home", ".local", "state"))
      })()
      return stopping
    },
  }
}

function recordingPaths(directory: string) {
  const id = crypto.randomUUID()
  return {
    timeline: join(directory, `recording-${id}.jsonl`),
    video: join(directory, `recording-${id}.mp4`),
  }
}

async function terminate(child: Bun.Subprocess) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([child.exited, Bun.sleep(1_000)])
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

async function prepareDev(cwd: string, directory: string) {
  const root = resolve(directory)
  const entrypoint = join(root, "packages", "cli", "src", "index.ts")
  if (!(await Bun.file(entrypoint).exists()))
    throw new Error(`OpenCode development entrypoint not found: ${entrypoint}`)
  const solidPackage = join(
    root,
    "packages",
    "tui",
    "node_modules",
    "@opentui",
    "solid",
    "package.json",
  )
  if (!(await Bun.file(solidPackage).exists())) {
    throw new Error(
      `OpenCode development dependency not found: ${solidPackage}; run bun install in ${root}`,
    )
  }
  const info: unknown = await Bun.file(solidPackage).json()
  if (!isPackageInfo(info))
    throw new Error(`Invalid @opentui/solid package metadata: ${solidPackage}`)
  await Bun.write(
    join(cwd, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: { "@opentui/solid": info.version },
      },
      undefined,
      2,
    )}\n`,
  )
  const install = Bun.spawn([process.execPath, "install"], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const status = await install.exited
  if (status !== 0)
    throw new Error(`bun install failed in ${cwd} with status ${status}`)
  return [
    process.execPath,
    "--conditions=browser",
    "--preload=@opentui/solid/preload",
    entrypoint,
  ]
}

async function freePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
  const port = server.port
  await server.stop(true)
  return port
}

async function stopService(state: string) {
  const files = [
    join(state, "opencode", "service-local.json"),
    join(state, "opencode", "service.json"),
  ]
  const info = await Promise.all(
    files.map((file) =>
      Bun.file(file)
        .json()
        .catch(() => undefined),
    ),
  )
  await Promise.all(
    info.map(async (value) => {
      if (!isServiceInfo(value)) return
      try {
        process.kill(value.pid, "SIGTERM")
      } catch {
        return
      }
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline && alive(value.pid)) await Bun.sleep(25)
      if (alive(value.pid)) process.kill(value.pid, "SIGKILL")
    }),
  )
}

function isServiceInfo(value: unknown): value is { readonly pid: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number"
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isPackageInfo(value: unknown): value is { readonly version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  )
}

async function waitForWebSocket(
  url: string,
  exited: Promise<number>,
  timeout: number,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const connected = await Promise.race([
      open(url)
        .then((socket) => {
          socket.terminate()
          return true
        })
        .catch(() => false),
      exited.then((code) => {
        throw new Error(
          `OpenCode exited with status ${code} before ${url} became ready`,
        )
      }),
    ])
    if (connected) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for drive endpoint ${url}`)
}

function open(url: string) {
  return new Promise<WebSocket>((resolveSocket, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener("open", () => resolveSocket(socket), {
      once: true,
    })
    socket.addEventListener(
      "error",
      () => reject(new Error(`cannot connect to ${url}`)),
      { once: true },
    )
  })
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

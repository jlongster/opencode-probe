import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensureMediaDirectory } from "./media.js"
import { createScriptFileSystem } from "../script/filesystem.js"
import type { JsonObject, ScriptSetup } from "../script/types.js"

export interface LaunchOptions {
  readonly artifacts: string
  readonly name: string
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly scripted?: boolean
  readonly visible?: boolean
  readonly record?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly setup?: ScriptSetup
}

export function artifactDirectory() {
  return resolve(join(tmpdir(), "opencode-drive"))
}

export async function initializeInstance() {
  const artifacts = resolve(
    join(artifactDirectory(), `run-${crypto.randomUUID().slice(0, 6)}`),
  )
  const logs = join(artifacts, "logs")
  const drive = join(artifacts, "drive")
  await Promise.all([
    mkdir(logs, { recursive: true }),
    mkdir(drive, { recursive: true }),
    mkdir(join(artifacts, "home", ".cache"), { recursive: true }),
    mkdir(join(artifacts, "home", ".config"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "share"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "state"), { recursive: true }),
  ])
  const files = join(artifacts, "files")
  const defaultConfig = await Bun.file(new URL("./default-config.jsonc", import.meta.url)).text()
  await Promise.all([
    mkdir(join(files, ".git"), { recursive: true }),
    mkdir(join(files, ".opencode"), { recursive: true }),
    mkdir(join(files, "src"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(files, ".opencode", "opencode.jsonc"), defaultConfig),
    Bun.write(
      join(files, "src", "garden.js"),
      "export function greet(name) {\n  return `Hello, ${name}.`\n}\n",
    ),
  ])
  return artifacts
}

export async function launchInstance(options: LaunchOptions) {
  const artifacts = resolve(options.artifacts)
  const logs = join(artifacts, "logs")
  const drive = join(artifacts, "drive")
  const endpoints = {
    ui: `ws://127.0.0.1:${await freePort()}`,
    backend: `ws://127.0.0.1:${await freePort()}`,
  }
  const media = await ensureMediaDirectory()
  const files = join(artifacts, "files")
  const configPath = join(files, ".opencode", "opencode.jsonc")
  let recording = options.record ? recordingPaths(media) : undefined
  const writeDriveManifest = (
    driveName = options.name,
    driveEndpoints = endpoints,
    driveRecording = recording,
  ) =>
    Bun.write(
      join(drive, `${driveName}.json`),
      `${JSON.stringify(
        {
          endpoints: driveEndpoints,
          ...(driveRecording ? { recording: { timeline: driveRecording.timeline } } : {}),
        },
        undefined,
        2,
      )}\n`,
    )
  if (options.setup) {
    const configFile = Bun.file(configPath)
    const config: JsonObject = await (await configFile.exists()
      ? configFile
      : Bun.file(new URL("./default-config.jsonc", import.meta.url))
    ).json()
    await options.setup({ fs: createScriptFileSystem(files), config })
    await Bun.write(configPath, `${JSON.stringify(config, undefined, 2)}\n`)
  }
  const environment = cleanEnv({
    ...process.env,
    ...options.env,
    OPENCODE_SIMULATE: "1",
    OPENCODE_DRIVE_SCRIPTED: options.scripted ? "1" : undefined,
    DRIVE_REGISTRY_DIR: drive,
    OPENCODE_DRIVE_RENDERER: options.visible ? "visible" : "headless",
    OPENCODE_DRIVE_MEDIA_DIR: media,
    OPENCODE_CONFIG_DIR: join(files, ".opencode"),
    OPENCODE_DB: ":memory:",
    OPENCODE_LOG_LEVEL: !options.visible ? "DEBUG" : process.env.OPENCODE_LOG_LEVEL,
    OPENCODE_TEST_HOME: artifacts,
    XDG_CACHE_HOME: join(artifacts, "home", ".cache"),
    XDG_CONFIG_HOME: join(artifacts, "home", ".config"),
    XDG_DATA_HOME: logs,
    XDG_STATE_HOME: join(artifacts, "home", ".local", "state"),
  })
  const command = options.dev
    ? await prepareDev(artifacts, options.dev)
    : options.command?.length
      ? [...options.command]
      : ["opencode2"]
  const serviceName = processDriveName(options.name, "service")
  const spawn = (
    driveName = options.name,
    appCommand: ReadonlyArray<string> = command,
    logName = "opencode",
  ) =>
    Bun.spawn([...appCommand], {
      cwd: files,
      env: { ...environment, OPENCODE_DRIVE: driveName },
      stdin: options.visible ? "inherit" : "ignore",
      stdout: !options.visible ? Bun.file(join(logs, `${logName}.stdout.log`)) : "inherit",
      stderr: !options.visible ? Bun.file(join(logs, `${logName}.stderr.log`)) : "inherit",
    })
  let child: ReturnType<typeof spawn> | undefined
  const clients = new Map<string, Bun.Subprocess>()
  const launching = new Set<string>()
  let serverChild: Bun.Subprocess | undefined
  let serverStarted = false
  let serverStarting = false
  let serverStopping = false
  if (!options.scripted) {
    await writeDriveManifest()
    child = spawn()
  }
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
      if (!child) throw new Error("no OpenCode process has been launched")
      return child
    },
    async launchServer() {
      if (!options.scripted) throw new Error("server.launch is only available in scripted mode")
      if (serverStarted || serverStarting || serverStopping)
        throw new Error("the script server has already been launched")
      serverStarting = true
      try {
        await writeDriveManifest(serviceName, {
          ui: `ws://127.0.0.1:${await freePort()}`,
          backend: endpoints.backend,
        }, undefined)
        serverChild = spawn(
          serviceName,
          [...command, "serve", "--service"],
          "service",
        )
        child = serverChild
        await waitForWebSocket(
          endpoints.backend,
          serverChild.exited,
          60_000,
        ).catch(async (error) => {
          await terminate(serverChild!)
          serverChild = undefined
          throw error
        })
        serverStarted = true
        return { endpoints: { backend: endpoints.backend } }
      } finally {
        serverStarting = false
      }
    },
    async killServer() {
      if (!options.scripted) throw new Error("server.kill is only available in scripted mode")
      if (!serverStarted || serverStarting || serverStopping)
        throw new Error("the script server is not running")
      serverStopping = true
      try {
        await terminate(serverChild!)
        serverChild = undefined
        serverStarted = false
      } finally {
        serverStopping = false
      }
    },
    async launchClient(
      clientName: string,
      clientOptions: { readonly record?: boolean } = {},
    ) {
      if (!options.scripted) throw new Error("clients.launch is only available in scripted mode")
      if (!serverStarted) throw new Error("launch the script server before launching clients")
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clientName))
        throw new Error(`invalid client name: ${clientName}`)
      if (clients.has(clientName) || launching.has(clientName))
        throw new Error(`client "${clientName}" is already running`)
      if (options.visible && clients.size + launching.size > 0)
        throw new Error("multiple clients require headless scripted mode")
      const primary = clients.size === 0 && launching.size === 0
      launching.add(clientName)
      try {
        const clientEndpoints = {
          ui: primary ? endpoints.ui : `ws://127.0.0.1:${await freePort()}`,
          backend: endpoints.backend,
        }
        const driveName = processDriveName(options.name, `client-${clientName}`)
        const clientRecording = clientOptions.record
          ? recordingPaths(media)
          : primary
            ? recording
            : undefined
        await writeDriveManifest(driveName, clientEndpoints, clientRecording)
        const launched = spawn(driveName, command, `client-${clientName}`)
        clients.set(clientName, launched)
        void launched.exited.then(() => {
          if (clients.get(clientName) === launched) clients.delete(clientName)
        })
        if (primary) child = launched
        await waitForWebSocket(clientEndpoints.ui, launched.exited, 60_000)
        return {
          endpoints: clientEndpoints,
          child: launched,
          recording: clientRecording,
          kill: async () => {
            if (clients.get(clientName) === launched) clients.delete(clientName)
            await terminate(launched)
          },
        }
      } catch (error) {
        const launched = clients.get(clientName)
        clients.delete(clientName)
        if (launched) await terminate(launched)
        throw error
      } finally {
        launching.delete(clientName)
      }
    },
    async waitForDrive(requirement: "ui" | "backend" | "both" = "both", timeout = 60_000) {
      const urls =
        requirement === "both" ? [endpoints.ui, endpoints.backend] : [endpoints[requirement]]
      const exited =
        options.scripted && requirement === "backend"
          ? new Promise<number>(() => undefined)
          : this.child.exited
      await Promise.all(urls.map((url) => waitForWebSocket(url, exited, timeout)))
    },
    async restart() {
      if (restarting) return restarting
      restarting = (async () => {
        if (options.scripted) {
          await Promise.all([...clients.values()].map(terminate))
          clients.clear()
          if (serverStarted) {
            await terminate(serverChild!)
            serverChild = undefined
            serverStarted = false
            child = undefined
          }
        } else {
          await terminate(this.child)
        }
        recording = options.record ? recordingPaths(media) : undefined
        if (!options.scripted) {
          await writeDriveManifest()
          child = spawn()
          await Promise.all([
            waitForWebSocket(endpoints.ui, child.exited, 60_000),
            waitForWebSocket(endpoints.backend, child.exited, 60_000),
          ])
        }
      })().finally(() => {
        restarting = undefined
      })
      return restarting
    },
    async wait() {
      while (true) {
        const current = this.child
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
        await Promise.all([...clients.values()].map(terminate))
        if (!options.scripted) await terminate(this.child)
        if (options.scripted && serverStarted) await terminate(serverChild!)
        await stopService(join(artifacts, "home", ".local", "state"))
      })()
      return stopping
    },
  }
}

function processDriveName(instance: string, role: string) {
  const suffix = crypto.randomUUID().slice(0, 8)
  return `${instance.slice(0, 36)}-${role.slice(0, 17)}-${suffix}`
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

async function prepareDev(artifacts: string, directory: string) {
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
  const manifestPath = join(artifacts, "package.json")
  const manifest: unknown = await Bun.file(manifestPath)
    .json()
    .catch(() => ({}))
  const existing = isDependencyManifest(manifest) ? manifest : {}
  await Bun.write(
    manifestPath,
    `${JSON.stringify(
      {
        ...existing,
        private: true,
        dependencies: {
          ...existing.dependencies,
          "@opentui/solid": info.version,
        },
      },
      undefined,
      2,
    )}\n`,
  )
  const install = Bun.spawn([process.execPath, "install"], {
    cwd: artifacts,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const status = await install.exited
  if (status !== 0) throw new Error(`bun install failed in ${artifacts} with status ${status}`)
  return [process.execPath, "--conditions=browser", "--preload=@opentui/solid/preload", entrypoint]
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
    join(state, "opencode", "server.json"),
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
    typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number"
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

function isDependencyManifest(
  value: unknown,
): value is { readonly dependencies?: Readonly<Record<string, string>> } {
  if (typeof value !== "object" || value === null) return false
  if (!("dependencies" in value) || value.dependencies === undefined) return true
  return typeof value.dependencies === "object" && value.dependencies !== null
}

async function waitForWebSocket(url: string, exited: Promise<number>, timeout: number) {
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
        throw new Error(`OpenCode exited with status ${code} before ${url} became ready`)
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
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), {
      once: true,
    })
  })
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

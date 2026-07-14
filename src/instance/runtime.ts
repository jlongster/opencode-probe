import { join, resolve } from "node:path"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Scope from "effect/Scope"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ensureMediaDirectory } from "./media.js"
import { prepareInstanceProject } from "./instance.js"
import * as Process from "./process.js"
import { isProcessAlive, isValidName } from "./registry.js"
import type { RecordingPaths } from "../recording/finalize.js"
import { stripGitEnvironment } from "../script/project.js"
import type { ScriptProject, ScriptSetup, UiViewport } from "../script/types.js"

export class OpenCodeInstanceError extends Schema.TaggedErrorClass<OpenCodeInstanceError>()(
  "OpenCodeInstanceError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface Options {
  readonly artifacts: string
  readonly name: string
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly scripted?: boolean
  readonly visible?: boolean
  readonly record?: boolean
  readonly viewport?: UiViewport
  readonly env?: Readonly<Record<string, string>>
  readonly project?: ScriptProject
  readonly setup?: ScriptSetup
  readonly log?: (message: string) => void
}

export interface Client {
  readonly endpoint: string
  readonly process: Process.Running
  readonly recording?: RecordingPaths
  readonly close: Effect.Effect<void, OpenCodeInstanceError>
}

export interface Instance {
  readonly artifacts: string
  readonly logs: string
  readonly endpoints: {
    readonly ui: string
    readonly backend: string
  }
  readonly recording: Effect.Effect<RecordingPaths | undefined>
  readonly primary: Effect.Effect<Process.Running, OpenCodeInstanceError>
  readonly launchServer: Effect.Effect<
    { readonly endpoint: string },
    OpenCodeInstanceError
  >
  readonly killServer: Effect.Effect<void, OpenCodeInstanceError>
  readonly launchClient: (
    name: string,
    options?: { readonly record?: boolean; readonly viewport?: UiViewport },
  ) => Effect.Effect<Client, OpenCodeInstanceError>
  readonly waitForDrive: (
    requirement?: "ui" | "backend" | "both",
    timeout?: number,
  ) => Effect.Effect<void, OpenCodeInstanceError>
  readonly restart: Effect.Effect<void, OpenCodeInstanceError>
  readonly wait: Effect.Effect<number, OpenCodeInstanceError>
  readonly stop: Effect.Effect<void, OpenCodeInstanceError>
}

interface StateFields {
  readonly recording?: RecordingPaths
  readonly server?: Process.Running
  readonly pendingServer?: Process.Running
  readonly primary?: Process.Running
  readonly clients: ReadonlyMap<string, Process.Running>
  readonly pendingClients: ReadonlyMap<string, Process.Running>
}

type State = Data.TaggedEnum<{
  readonly Running: StateFields
  readonly Stopping: StateFields
  readonly Stopped: StateFields
}>

const State = Data.taggedEnum<State>()

export const make = Effect.fn("OpenCodeInstance.make")(function* (
  options: Options,
) {
  const artifacts = resolve(options.artifacts)
  const logs = join(artifacts, "logs")
  const drive = join(artifacts, "drive")
  const files = join(artifacts, "files")
  const media = yield* Effect.tryPromise({
    try: () => ensureMediaDirectory(),
    catch: (cause) => instanceError("prepare media", cause),
  })
  const endpoints = {
    ui: `ws://127.0.0.1:${yield* freePort}`,
    backend: `ws://127.0.0.1:${yield* freePort}`,
  }
  if (options.project !== undefined || options.setup !== undefined)
    yield* Effect.tryPromise({
      try: () =>
        prepareInstanceProject({
          artifacts,
          project: options.project,
          setup: options.setup,
        }),
      catch: (cause) => instanceError("prepare project", cause),
    })
  const environment = stripGitEnvironment({
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
  const command = options.dev !== undefined
    ? yield* prepareDev(artifacts, options.dev)
    : options.command?.length
      ? [...options.command]
      : ["opencode2"]
  const initialRecording = options.record ? recordingPaths(media) : undefined
  const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fileSystem = yield* FileSystem.FileSystem
  const state = yield* Ref.make<State>(State.Running({
    recording: initialRecording,
    clients: new Map(),
    pendingClients: new Map(),
  }))
  const lock = yield* Semaphore.make(1)
  const instanceScope = yield* Scope.Scope

  const writeManifest = Effect.fn("OpenCodeInstance.writeManifest")(function* (
    name: string,
    manifestEndpoints: { readonly ui: string; readonly backend: string },
    recording?: RecordingPaths,
    viewport?: UiViewport,
  ) {
    yield* Effect.tryPromise({
      try: () =>
        Bun.write(
          join(drive, `${name}.json`),
          `${JSON.stringify(
            {
              endpoints: manifestEndpoints,
              ...(viewport ? { viewport } : {}),
              ...(recording
                ? { recording: { timeline: recording.timeline } }
                : {}),
            },
            undefined,
            2,
          )}\n`,
        ),
      catch: (cause) => instanceError("write manifest", cause),
    })
  })

  const spawn = Effect.fn("OpenCodeInstance.spawn")(function* (
    driveName: string,
    appCommand: ReadonlyArray<string>,
    logName: string,
  ) {
    options.log?.(`launching ${logName}`)
    return yield* Process.spawn(appCommand, {
      cwd: files,
      env: { ...environment, OPENCODE_DRIVE: driveName },
      stdin: options.visible ? "inherit" : "ignore",
      stdout: options.visible ? "inherit" : { path: join(logs, `${logName}.stdout.log`) },
      stderr: options.visible ? "inherit" : { path: join(logs, `${logName}.stderr.log`) },
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        processSpawner,
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Scope.provide(instanceScope),
      Effect.mapError((cause) => instanceError(`launch ${logName}`, cause)),
    )
  })

  const launchDefault = Effect.fn("OpenCodeInstance.launchDefault")(function* (
    recording: RecordingPaths | undefined,
  ) {
    yield* writeManifest(options.name, endpoints, recording, options.viewport)
    options.log?.("launching OpenCode")
    return yield* spawn(options.name, command, "opencode")
  })

  if (!options.scripted) {
    const primary = yield* launchDefault(initialRecording)
    yield* Ref.update(state, (current) => ({ ...current, primary }))
  }

  const launchServer = Effect.gen(function* () {
    const server = yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (!options.scripted)
          return yield* Effect.fail(instanceError("launch server", "server launch requires scripted mode"))
        if (current._tag !== "Running")
          return yield* Effect.fail(instanceError("launch server", "the instance is stopping"))
        if (current.server !== undefined || current.pendingServer !== undefined)
          return yield* Effect.fail(instanceError("launch server", "the script server has already been launched"))
        const name = processDriveName(options.name, "service")
        yield* writeManifest(name, {
          ui: `ws://127.0.0.1:${yield* freePort}`,
          backend: endpoints.backend,
        })
        options.log?.("launching script server")
        const server = yield* spawn(name, [...command, "serve", "--service"], "service")
        yield* Ref.update(state, (value) => ({ ...value, pendingServer: server }))
        return server
      }),
    )
    const removePending = lock.withPermit(
      Ref.update(state, (value) =>
        value.pendingServer === server
          ? { ...value, pendingServer: undefined }
          : value,
      ),
    )
    yield* waitForWebSocket(endpoints.backend, server, 60_000).pipe(
      Effect.onError(() =>
        removePending.pipe(
          Effect.andThen(server.terminate),
          Effect.ignore,
        ),
      ),
      Effect.mapError((cause) => instanceError("wait for server", cause)),
    )
    const committed = yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current._tag !== "Running" || current.pendingServer !== server)
          return false
        yield* Ref.set(state, {
          ...current,
          pendingServer: undefined,
          server,
          primary: server,
        })
        return true
      }),
    )
    if (!committed) {
      yield* server.terminate.pipe(Effect.ignore)
      return yield* Effect.fail(instanceError("launch server", "the instance is stopping"))
    }
    yield* server.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(
        Ref.update(state, (value) =>
          value.server === server ? { ...value, server: undefined } : value,
        ),
      ),
      Effect.forkIn(instanceScope),
    )
    options.log?.("script server ready")
    return { endpoint: endpoints.backend }
  })

  const killServer = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (!options.scripted)
        return yield* Effect.fail(instanceError("kill server", "server kill requires scripted mode"))
      if (current.server === undefined)
        return yield* Effect.fail(instanceError("kill server", "the script server is not running"))
      options.log?.("stopping script server")
      yield* current.server.terminate.pipe(
        Effect.mapError((cause) => instanceError("kill server", cause)),
      )
      yield* Ref.update(state, (value) => ({
        ...value,
        server: undefined,
        primary: value.primary === current.server ? undefined : value.primary,
      }))
      return undefined
    }),
  )

  const launchClient = Effect.fn("OpenCodeInstance.launchClient")(function* (
    name: string,
    clientOptions: { readonly record?: boolean; readonly viewport?: UiViewport } = {},
  ) {
    const pending = yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (!options.scripted)
          return yield* Effect.fail(instanceError("launch client", "client launch requires scripted mode"))
        if (current._tag !== "Running")
          return yield* Effect.fail(instanceError("launch client", "the instance is stopping"))
        if (current.server === undefined)
          return yield* Effect.fail(instanceError("launch client", "launch the script server before launching clients"))
        if (!isValidName(name))
          return yield* Effect.fail(instanceError("launch client", `invalid client name: ${name}`))
        if (current.clients.has(name) || current.pendingClients.has(name))
          return yield* Effect.fail(instanceError("launch client", `client "${name}" is already running`))
        if (options.visible && current.clients.size + current.pendingClients.size > 0)
          return yield* Effect.fail(instanceError("launch client", "multiple clients require headless scripted mode"))
        const primary = current.clients.size + current.pendingClients.size === 0
        const clientEndpoints = {
          ui: primary ? endpoints.ui : `ws://127.0.0.1:${yield* freePort}`,
          backend: endpoints.backend,
        }
        const driveName = processDriveName(options.name, `client-${name}`)
        const recording = clientOptions.record
          ? recordingPaths(media)
          : primary
            ? current.recording
            : undefined
        yield* writeManifest(
          driveName,
          clientEndpoints,
          recording,
          clientOptions.viewport ?? options.viewport,
        )
        options.log?.(`launching client ${name}`)
        const client = yield* spawn(driveName, command, `client-${name}`)
        yield* Ref.update(state, (value) => ({
          ...value,
          pendingClients: new Map(value.pendingClients).set(name, client),
        }))
        return { client, clientEndpoints, primary, recording }
      }),
    )
    const { client, clientEndpoints, primary, recording } = pending
    const removePending = lock.withPermit(
      Ref.update(state, (value) => {
        if (value.pendingClients.get(name) !== client) return value
        const pendingClients = new Map(value.pendingClients)
        pendingClients.delete(name)
        return { ...value, pendingClients }
      }),
    )
    yield* waitForWebSocket(clientEndpoints.ui, client, 60_000).pipe(
      Effect.onError(() =>
        removePending.pipe(
          Effect.andThen(client.terminate),
          Effect.ignore,
        ),
      ),
      Effect.mapError((cause) => instanceError("wait for client", cause)),
    )
    const committed = yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (
          current._tag !== "Running" ||
          current.pendingClients.get(name) !== client
        )
          return false
        const pendingClients = new Map(current.pendingClients)
        pendingClients.delete(name)
        yield* Ref.set(state, {
          ...current,
          primary: primary ? client : current.primary,
          clients: new Map(current.clients).set(name, client),
          pendingClients,
        })
        return true
      }),
    )
    if (!committed) {
      yield* client.terminate.pipe(Effect.ignore)
      return yield* Effect.fail(instanceError("launch client", "the instance is stopping"))
    }
    yield* client.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(
        Ref.update(state, (value) => {
          if (value.clients.get(name) !== client) return value
          const clients = new Map(value.clients)
          clients.delete(name)
          return { ...value, clients }
        }),
      ),
      Effect.forkIn(instanceScope),
    )
    options.log?.(`client ${name} ready`)
    const close = Effect.gen(function* () {
      yield* Ref.update(state, (value) => {
        if (value.clients.get(name) !== client) return value
        const clients = new Map(value.clients)
        clients.delete(name)
        return { ...value, clients }
      })
      yield* client.terminate.pipe(
        Effect.mapError((cause) => instanceError("close client", cause)),
      )
    })
    return {
      endpoint: clientEndpoints.ui,
      process: client,
      recording,
      close,
    } satisfies Client
  })

  const waitForDrive = Effect.fn("OpenCodeInstance.waitForDrive")(function* (
    requirement: "ui" | "backend" | "both" = "both",
    timeout = 60_000,
  ) {
    const current = yield* Ref.get(state)
    const process = current.primary
    if (process === undefined)
      return yield* Effect.fail(instanceError("wait for drive", "no OpenCode process has been launched"))
    const urls = requirement === "both"
      ? [endpoints.ui, endpoints.backend]
      : [endpoints[requirement]]
    yield* Effect.forEach(urls, (url) => waitForWebSocket(url, process, timeout), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.mapError((cause) => instanceError("wait for drive", cause)))
    return undefined
  })

  const restart = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current._tag !== "Running")
        return yield* Effect.fail(instanceError("restart", "the instance is stopping"))
      options.log?.("restarting OpenCode")
      const processes = new Set([
        ...current.clients.values(),
        ...current.pendingClients.values(),
      ])
      if (current.server !== undefined) processes.add(current.server)
      if (current.pendingServer !== undefined) processes.add(current.pendingServer)
      if (!options.scripted && current.primary !== undefined)
        processes.add(current.primary)
      const exits = yield* Effect.forEach(processes, (process) =>
        Effect.exit(process.terminate), {
        concurrency: "unbounded",
      })
      const combined = Exit.asVoidAll(exits)
      if (Exit.isFailure(combined))
        return yield* Effect.failCause(combined.cause).pipe(
          Effect.mapError((cause) => instanceError("restart", cause)),
        )
      const recording = options.record ? recordingPaths(media) : undefined
      yield* Ref.set(state, State.Running({
        recording,
        clients: new Map(),
        pendingClients: new Map(),
      }))
      if (!options.scripted) {
        const primary = yield* launchDefault(recording)
        yield* Ref.update(state, (value) => ({ ...value, primary }))
        yield* waitForDrive("both")
        options.log?.("OpenCode ready")
      }
      return undefined
    }),
  )

  const wait: Effect.Effect<number, OpenCodeInstanceError> = Effect.suspend(() =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current.primary === undefined)
        return yield* Effect.fail(instanceError("wait", "no OpenCode process has been launched"))
      const active = current.primary
      const status = yield* active.exitCode.pipe(
        Effect.mapError((cause) => instanceError("wait", cause)),
      )
      const next = yield* Ref.get(state)
      if (next.primary !== active && next._tag === "Running") return yield* wait
      return status
    }),
  )

  const stop = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current._tag === "Stopped") return undefined
      yield* Ref.set(state, State.Stopping(current))
      options.log?.("stopping OpenCode")
      const processes = new Set(current.clients.values())
      for (const process of current.pendingClients.values())
        processes.add(process)
      if (current.server !== undefined) processes.add(current.server)
      if (current.pendingServer !== undefined) processes.add(current.pendingServer)
      if (!options.scripted && current.primary !== undefined)
        processes.add(current.primary)
      const exits = yield* Effect.forEach(processes, (process) =>
        Effect.exit(process.terminate), {
        concurrency: "unbounded",
      })
      const serviceExit = yield* Effect.exit(
        stopService(join(artifacts, "home", ".local", "state")),
      )
      yield* Ref.set(state, State.Stopped({
        recording: current.recording,
        clients: new Map(),
        pendingClients: new Map(),
      }))
      const combined = Exit.asVoidAll([...exits, serviceExit])
      if (Exit.isFailure(combined))
        return yield* Effect.failCause(combined.cause).pipe(
          Effect.mapError((cause) => instanceError("stop", cause)),
        )
      return undefined
    }),
  )
  yield* Effect.addFinalizer(() =>
    stop.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("OpenCode instance cleanup failed", cause),
      ),
    ),
  )

  return {
    artifacts,
    logs,
    endpoints,
    recording: Ref.get(state).pipe(Effect.map((current) => current.recording)),
    primary: Ref.get(state).pipe(
      Effect.flatMap((current) =>
        current.primary === undefined
          ? Effect.fail(instanceError("primary", "no OpenCode process has been launched"))
          : Effect.succeed(current.primary),
      ),
    ),
    launchServer,
    killServer,
    launchClient,
    waitForDrive,
    restart,
    wait,
    stop,
  } satisfies Instance
})

const freePort = Effect.tryPromise({
  try: async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    })
    const port = server.port
    await server.stop(true)
    return port
  },
  catch: (cause) => instanceError("allocate port", cause),
})

const prepareDev = Effect.fn("OpenCodeInstance.prepareDev")(function* (
  artifacts: string,
  directory: string,
) {
  const root = resolve(directory)
  const entrypoint = join(root, "packages", "cli", "src", "index.ts")
  const solidPackage = join(
    root,
    "packages",
    "tui",
    "node_modules",
    "@opentui",
    "solid",
    "package.json",
  )
  yield* Effect.tryPromise({
    try: async () => {
      if (!(await Bun.file(entrypoint).exists()))
        throw new Error(`OpenCode development entrypoint not found: ${entrypoint}`)
      if (!(await Bun.file(solidPackage).exists()))
        throw new Error(
          `OpenCode development dependency not found: ${solidPackage}; run bun install in ${root}`,
        )
      const value: unknown = await Bun.file(solidPackage).json()
      if (!isPackageInfo(value))
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
              "@opentui/solid": value.version,
            },
          },
          undefined,
          2,
        )}\n`,
      )
      return value
    },
    catch: (cause) => instanceError("prepare development checkout", cause),
  })
  const installed = yield* Process.run([process.execPath, "install"], {
    cwd: artifacts,
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.mapError((cause) => instanceError("install development dependencies", cause)))
  if (installed.status !== 0)
    return yield* Effect.fail(
      instanceError("install development dependencies", `bun install failed with status ${installed.status}`),
    )
  return [
    process.execPath,
    "--conditions=browser",
    "--preload=@opentui/solid/preload",
    entrypoint,
  ]
})

const stopService = Effect.fn("OpenCodeInstance.stopService")(function* (
  state: string,
) {
  const files = [
    join(state, "opencode", "server.json"),
    join(state, "opencode", "service-local.json"),
    join(state, "opencode", "service.json"),
  ]
  const info = yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        files.map((file) =>
          Bun.file(file)
            .json()
            .catch(() => undefined),
        ),
      ),
    catch: (cause) => instanceError("read service state", cause),
  })
  yield* Effect.forEach(info, (value) => {
    if (!isServiceInfo(value)) return Effect.void
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        try {
          process.kill(value.pid, "SIGTERM")
        } catch {
          return
        }
      })
      yield* Effect.suspend(() =>
        isProcessAlive(value.pid) ? Effect.fail(undefined) : Effect.void,
      ).pipe(
        Effect.retry(
          Schedule.spaced(25).pipe(
            Schedule.upTo({ times: 39 }),
          ),
        ),
        Effect.catch(() => Effect.void),
      )
      if (isProcessAlive(value.pid))
        yield* Effect.sync(() => process.kill(value.pid, "SIGKILL"))
    })
  }, { concurrency: "unbounded", discard: true })
})

const waitForWebSocket = Effect.fn("OpenCodeInstance.waitForWebSocket")(
  (url: string, process: Process.Running, timeout: number) =>
    Effect.raceFirst(
      open(url).pipe(Effect.retry(Schedule.spaced(50))),
      process.exitCode.pipe(
        Effect.flatMap((status) =>
          Effect.fail(
            instanceError(
              "wait for endpoint",
              `OpenCode exited with status ${status} before ${url} became ready`,
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            instanceError("wait for endpoint", `timed out waiting for drive endpoint ${url}`),
          ),
      }),
    ),
)

const open = (url: string) =>
  Effect.callback<void, OpenCodeInstanceError>((resume) => {
    const socket = new WebSocket(url)
    const onOpen = () => {
      cleanup()
      socket.terminate()
      resume(Effect.void)
    }
    const onError = () => {
      cleanup()
      socket.terminate()
      resume(Effect.fail(instanceError("connect", `cannot connect to ${url}`)))
    }
    const cleanup = () => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    return Effect.sync(() => {
      cleanup()
      socket.terminate()
    })
  })

function processDriveName(instance: string, role: string) {
  const suffix = crypto.randomUUID().slice(0, 8)
  return `${instance.slice(0, 36)}-${role.slice(0, 17)}-${suffix}`
}

function recordingPaths(directory: string): RecordingPaths {
  const id = crypto.randomUUID()
  return {
    timeline: join(directory, `recording-${id}.jsonl`),
    video: join(directory, `recording-${id}.mp4`),
  }
}

function instanceError(operation: string, cause: unknown) {
  if (cause instanceof OpenCodeInstanceError) return cause
  return new OpenCodeInstanceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
}

function isServiceInfo(value: unknown): value is { readonly pid: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number"
  )
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

export * as OpenCodeInstance from "./runtime.js"

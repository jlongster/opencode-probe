import { initializeInstance, launchInstance } from "../instance/instance.js"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { connectSimulation } from "../client/index.js"
import { exportRecording } from "../recording/index.js"
import { connectMockBackend } from "./mock-backend.js"
import { createResponseSettings } from "./response-generator.js"
import { loadScript, runScript } from "./script.js"
import type { ScriptDefinition } from "../script/types.js"
import { prepareScriptTooling } from "../script/tooling.js"
import { listenControl } from "../instance/control.js"
import { configureLogFile, logError, logReadyPaths, logSuccess } from "../log.js"
import {
  controlPath,
  markReady,
  markStarting,
  initializeManifest,
  register,
  registryDirectory,
  resolveInstance,
  unregister,
} from "../instance/registry.js"
import type { StartOptions } from "./types.js"

export async function start(options: StartOptions) {
  const initialized = await initializeManifest(options.name, process.cwd(), initializeInstance, {
    temporary: true,
  })
  configureLogFile(initialized.artifacts)
  logSuccess(`starting ${options.name}`)
  logSuccess(`using artifacts ${initialized.artifacts}`)
  if (!options.visible && !options.script && !options.daemon)
    return startDetached(options, initialized.artifacts)
  const scriptPath = options.script
  const scriptTooling = scriptPath
    ? await (async () => {
        logSuccess(`preparing script ${scriptPath}`)
        return prepareScriptTooling(initialized.artifacts, scriptPath)
      })()
    : undefined
  const script = scriptTooling
    ? await (async () => {
        logSuccess(`loading script ${scriptTooling.file}`)
        return loadScript(scriptTooling.file)
      })().catch(async (error) => {
        await scriptTooling.links.remove()
        throw error
      })
    : undefined
  if (script && "launch" in script && options.record) {
    await scriptTooling?.links.remove()
    throw new Error("--record is not supported when launch is manual")
  }
  const responses = createResponseSettings()
  logSuccess("launching instance")
  const instance = await launchInstance({
    artifacts: initialized.artifacts,
    name: options.name,
    command: options.command,
    dev: options.dev,
    scripted: options.script !== undefined,
    visible: options.visible,
    record: options.record,
    viewport: script?.viewport,
    setup: script?.setup,
    log: logSuccess,
  }).catch(async (error) => {
    await scriptTooling?.links.remove()
    throw error
  })
  await register({
    version: 1,
    name: options.name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    artifacts: instance.artifacts,
    visible: options.visible,
    status: "starting",
    endpoints: instance.endpoints,
    control: controlPath(options.name),
  }).catch(async (error) => {
    await instance.stop()
    await scriptTooling?.links.remove()
    throw error
  })
  let completed = false
  let current: ReturnType<typeof run> | undefined
  let restarting: Promise<string | undefined> | undefined
  let stopping = false
  const screenshots: string[] = []
  const recordings: string[] = []
  let driveReady = false
  let recording: Promise<string | undefined> | undefined
  const finishCurrentRecording = (onProgress?: (percent: number) => void) => {
    if (
      !options.record ||
      options.visible ||
      !driveReady ||
      options.script !== undefined
    )
      return Promise.resolve(undefined)
    recording ??= finishRecording(instance, onProgress)
    return recording
  }
  const interrupt = () => {
    stopping = true
    current?.abort.abort(new Error("opencode-drive interrupted"))
    void finishCurrentRecording()
      .catch((error) =>
        logError(`failed to export recording: ${error}`),
      )
      .finally(() => instance.stop())
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  const stopInstance = async (onProgress?: (percent: number) => void) => {
    try {
      const output = await finishCurrentRecording(onProgress)
      return {
        ...(output ? { recording: output } : {}),
        screenshots: [...screenshots],
      }
    } finally {
      stopping = true
      current?.abort.abort(new Error("opencode-drive stopped"))
      await instance.stop()
    }
  }
  const completeScript = async () => {
    completed = true
    const result = await stopInstance()
    for (const screenshot of result.screenshots) console.log(screenshot)
  }
  let closeControl: (() => Promise<void>) | undefined
  let failure: unknown
  try {
    closeControl = await listenControl(controlPath(options.name), {
      restart: () => {
        if (restarting) return restarting
        restarting = (async () => {
          await markStarting(options.name, process.pid)
          const output = await finishCurrentRecording()
          const previous = current
          const restartReason = new Error("script restarted")
          previous?.abort.abort(restartReason)
          await previous?.promise.catch((error) => {
            if (error !== restartReason) throw error
          })
          driveReady = false
          await instance.restart()
          recording = undefined
          current = run(
            options,
            instance,
            responses,
            script,
            (path) => screenshots.push(path),
            (path) => recordings.push(path),
          )
          await current.ready
          driveReady = true
          await markReady(options.name, process.pid)
          await logReadyPaths(instance.artifacts)
          return output
        })().finally(() => {
          restarting = undefined
        })
        return restarting
      },
      stop: stopInstance,
      responses: async (input) => {
        if (options.script)
          throw new Error("responses are unavailable when --script owns the simulation backend")
        return responses.update(input)
      },
    })
    current = run(
      options,
      instance,
      responses,
      script,
      (path) => screenshots.push(path),
      (path) => recordings.push(path),
    )
    await current.ready
    driveReady = true
    logSuccess(`ready ${options.name}`)
    await markReady(options.name, process.pid)
    await logReadyPaths(instance.artifacts)
    if (options.visible) {
      while (true) {
        const active: NonNullable<typeof current> = current
        let result:
          | { readonly script: true }
          | { readonly script: false; readonly status: number }
        try {
          result = options.script
            ? await Promise.race([
                active.promise.then(() => ({ script: true as const })),
                instance.wait().then((status) => ({ script: false as const, status })),
              ])
            : { script: false as const, status: await instance.wait() }
        } catch (error) {
          if (stopping) return
          if (restarting || active !== current) {
            await restarting
            continue
          }
          throw error
        }
        if (restarting || active !== current) {
          await restarting
          continue
        }
        if (result.script) {
          await completeScript()
        }
        const status = result.script ? await instance.wait() : result.status
        if (status !== 0 && !stopping) process.exitCode = status
        return
      }
    }
    while (true) {
      const active: NonNullable<typeof current> = current
      try {
        await active.promise
      } catch (error) {
        if (stopping) break
        if (restarting || active !== current) {
          await restarting
          continue
        }
        throw error
      }
      if (stopping) break
      if (restarting) {
        await restarting
        continue
      }
      if (active !== current) continue
      if (options.script) {
        await completeScript()
        break
      }
      completed = true
      break
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    current?.abort.abort(new Error("opencode-drive stopped"))
    let cleanupFailure: unknown
    const recordingPath = await finishCurrentRecording().catch((error) => {
      logError(`failed to export recording: ${error}`)
      return undefined
    })
    await closeControl?.().catch((error) => {
      cleanupFailure ??= error
      logError(`failed to close control socket: ${error}`)
    })
    await instance.stop().catch((error) => {
      cleanupFailure ??= error
      logError(`failed to stop OpenCode: ${error}`)
    })
    await unregister(options.name, process.pid).catch((error) => {
      cleanupFailure ??= error
      logError(`failed to unregister ${options.name}: ${error}`)
    })
    await scriptTooling?.links.remove().catch((error) => {
      cleanupFailure ??= error
      logError(`failed to remove script tooling: ${error}`)
    })
    if (options.script && !options.visible) report(completed ? "completed" : undefined)
    if (options.script && recordingPath) logSuccess(`recording ${recordingPath}`)
    if (options.script)
      for (const output of recordings)
        logSuccess(`recording ${output}`)
    if (options.script && failure !== undefined)
      setTimeout(() => process.exit(1), 0)
    if (failure === undefined && cleanupFailure !== undefined) process.exitCode = 1
  }
}

async function finishRecording(
  instance: Awaited<ReturnType<typeof launchInstance>>,
  onProgress?: (percent: number) => void,
) {
  const expected = instance.recording
  if (!expected) throw new Error("recording was not enabled for this instance")
  let timeline: string
  if (instance.child.exitCode !== null) {
    timeline = expected.timeline
  } else {
    const ui = await connectSimulation({
      url: instance.endpoints.ui,
      timeout: 60_000,
    })
    try {
      timeline = await ui.finishRecording()
    } finally {
      ui.close()
    }
  }
  if (timeline !== expected.timeline)
    throw new Error(`OpenCode returned an unexpected recording path: ${timeline}`)
  if (!(await Bun.file(timeline).exists()))
    throw new Error(`OpenCode recording timeline was not created: ${timeline}`)
  await exportRecording(timeline, expected.video, { onProgress })
  return expected.video
}

async function startDetached(options: StartOptions, artifacts: string) {
  const existing = await resolveInstance(options.name, { ready: false }).catch(() => undefined)
  if (existing) throw new Error(`drive instance "${options.name}" is already running`)
  const ownerLog = join(registryDirectory(), `${options.name}.log`)
  await mkdir(registryDirectory(), { recursive: true })
  await rm(ownerLog, { force: true })
  logSuccess(`launching detached owner for ${options.name}`)
  const child = Bun.spawn(
    [
      process.execPath,
      process.argv[1]!,
      "start",
      "--daemon",
      "--name",
      options.name,
      ...(options.script ? ["--script", options.script] : []),
      ...(options.dev ? ["--dev", options.dev] : []),
      ...(options.record ? ["--record"] : []),
      ...(options.command.length ? ["--", ...options.command] : []),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_DRIVE_LOG: configureLogFile(artifacts) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(ownerLog),
    },
  )
  child.unref()
  logSuccess(`waiting for ${options.name} to become ready`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const manifest = await resolveInstance(options.name).catch(() => undefined)
    if (manifest?.pid === child.pid) {
      logSuccess(`ready ${options.name}`)
      await logReadyPaths(manifest.artifacts)
      return
    }
    if (child.exitCode !== null)
      throw new Error(`detached instance exited with status ${child.exitCode}; see ${ownerLog}`)
    await Bun.sleep(50)
  }
  await terminateOwner(child)
  throw new Error(`timed out starting drive instance "${options.name}"; see ${ownerLog}`)
}

async function terminateOwner(child: Bun.Subprocess) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  const deadline = Date.now() + 1_000
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

function run(
  options: StartOptions,
  instance: Awaited<ReturnType<typeof launchInstance>>,
  responses: ReturnType<typeof createResponseSettings>,
  driveScript: ScriptDefinition | undefined,
  onScreenshot: (path: string) => void,
  onRecording: (path: string) => void,
) {
  const abort = new AbortController()
  const readiness = Promise.withResolvers<void>()
  let markedReady = false
  const ready = () => {
    if (markedReady) return
    markedReady = true
    readiness.resolve()
  }
  const promise = (async () => {
    if (!driveScript) {
      logSuccess("waiting for OpenCode")
      await instance.waitForDrive("both")
      logSuccess("OpenCode ready")
    }
    if (driveScript) {
      logSuccess("running script")
      await runScript(
        driveScript,
        instance.artifacts,
        () => instance.launchServer(),
        () => instance.killServer(),
        (name, clientOptions) => instance.launchClient(name, clientOptions),
        abort.signal,
        onScreenshot,
        onRecording,
        ready,
      )
      ready()
      logSuccess("script completed")
      return
    }
    const child = instance.child
    const mock = await connectMockBackend(instance.endpoints.backend, responses)
    ready()
    abort.signal.addEventListener("abort", () => mock.close(), {
      once: true,
    })
    const status = await Promise.race([
      child.exited,
      new Promise<number>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(0), {
          once: true,
        }),
      ),
    ])
    mock.close()
    if (status !== 0 && !abort.signal.aborted) process.exitCode = status
  })().catch((error) => {
    if (!markedReady) readiness.reject(error)
    throw error
  })
  void promise.catch(() => undefined)
  return {
    abort,
    ready: readiness.promise,
    promise,
  }
}

function report(status?: string) {
  if (status) logSuccess(status)
}

import { launchInstance } from "./instance.js"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { connectSimulation } from "../client/index.js"
import { exportRecording } from "../recording/index.js"
import { connectMockBackend } from "./mock-backend.js"
import { createResponseSettings } from "./response-generator.js"
import { loadScript, runScript } from "./script.js"
import type { DriveScript } from "./script.js"
import { listenControl } from "./control.js"
import {
  controlPath,
  markReady,
  markStarting,
  register,
  registryDirectory,
  resolveInstance,
  unregister,
} from "./registry.js"
import type { StartOptions } from "./types.js"

export async function start(options: StartOptions) {
  if (!options.visible && !options.script && !options.daemon)
    return startDetached(options)
  const script = options.script ? await loadScript(options.script) : undefined
  const responses = createResponseSettings()
  const instance = await launchInstance({
    name: options.name,
    command: options.command,
    dev: options.dev,
    scripted: options.script !== undefined,
    visible: options.visible,
    record: options.record,
    setup: script?.setup,
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
    throw error
  })
  let completed = false
  let current: ReturnType<typeof run> | undefined
  let restarting: Promise<string | undefined> | undefined
  let stopping = false
  const screenshots: string[] = []
  let driveReady = false
  let recording: Promise<string | undefined> | undefined
  const finishCurrentRecording = (onProgress?: (percent: number) => void) => {
    if (!options.record || options.visible || !driveReady)
      return Promise.resolve(undefined)
    recording ??= finishRecording(instance, onProgress)
    return recording
  }
  const interrupt = () => {
    stopping = true
    current?.abort.abort(new Error("opencode-drive interrupted"))
    void finishCurrentRecording()
      .catch((error) =>
        process.stderr.write(`opencode-drive: failed to export recording: ${error}\n`),
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
  try {
    closeControl = await listenControl(controlPath(options.name), {
      restart: () => {
        if (restarting) return restarting
        restarting = (async () => {
          await markStarting(options.name, process.pid)
          const output = await finishCurrentRecording()
          const previous = current
          previous?.abort.abort(new Error("script restarted"))
          await previous?.promise.catch(() => undefined)
          driveReady = false
          await instance.restart()
          recording = undefined
          current = run(options, instance, responses, script?.run, (path) =>
            screenshots.push(path),
          )
          await current.ready
          driveReady = true
          await markReady(options.name, process.pid)
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
    current = run(options, instance, responses, script?.run, (path) =>
      screenshots.push(path),
    )
    await current.ready
    driveReady = true
    await markReady(options.name, process.pid)
    if (options.visible) {
      const result = options.script
        ? await Promise.race([
            current.promise.then(() => ({ script: true as const })),
            instance.wait().then((status) => ({ script: false as const, status })),
          ])
        : { script: false as const, status: await instance.wait() }
      if (result.script) {
        await completeScript()
      }
      const status = result.script ? await instance.wait() : result.status
      if (status !== 0 && !stopping) process.exitCode = status
      return
    }
    while (true) {
      const active: NonNullable<typeof current> = current
      await active.promise
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
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    current?.abort.abort(new Error("opencode-drive stopped"))
    const recordingPath = await finishCurrentRecording().catch((error) => {
      process.stderr.write(`opencode-drive: failed to export recording: ${error}\n`)
      return undefined
    })
    await closeControl?.()
    await instance.stop()
    await unregister(options.name, process.pid)
    if (options.script && !options.visible)
      report(instance, completed ? "completed" : undefined)
    if (options.script && recordingPath)
      console.error(`opencode-drive: recording ${recordingPath}`)
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
    const ui = await connectSimulation({ url: instance.endpoints.ui, timeout: 60_000 })
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

async function startDetached(options: StartOptions) {
  const existing = await resolveInstance(options.name, { ready: false }).catch(() => undefined)
  if (existing)
    throw new Error(`drive instance "${options.name}" is already running`)
  const ownerLog = join(registryDirectory(), `${options.name}.log`)
  await mkdir(registryDirectory(), { recursive: true })
  await rm(ownerLog, { force: true })
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
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(ownerLog),
    },
  )
  child.unref()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const manifest = await resolveInstance(options.name).catch(() => undefined)
    if (manifest?.pid === child.pid) {
      report({
        artifacts: manifest.artifacts,
        logs: `${manifest.artifacts}/logs`,
      })
      return
    }
    if (child.exitCode !== null)
      throw new Error(
        `detached instance exited with status ${child.exitCode}; see ${ownerLog}`,
      )
    await Bun.sleep(50)
  }
  await terminateOwner(child)
  throw new Error(
    `timed out starting drive instance "${options.name}"; see ${ownerLog}`,
  )
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
  driveScript: DriveScript | undefined,
  onScreenshot: (path: string) => void,
) {
  const abort = new AbortController()
  const child = instance.child
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  return {
    abort,
    ready: readiness,
    promise: (async () => {
      await instance.waitForDrive("both")
      if (driveScript) {
        const script = runScript(
          driveScript,
          instance.artifacts,
          instance.endpoints,
          abort.signal,
          onScreenshot,
        )
        ready()
        if (options.visible) {
          await script
          return
        }
        const result = await Promise.race([
          script.then(() => ({ script: true as const })),
          child.exited.then((status) => ({ script: false as const, status })),
        ])
        if (!result.script) {
          abort.abort(new Error(`OpenCode exited with status ${result.status}`))
          await script.catch(() => undefined)
          if (result.status !== 0) process.exitCode = result.status
        }
        return
      }
      const mock = await connectMockBackend(instance.endpoints.backend, responses)
      ready()
      abort.signal.addEventListener("abort", () => mock.close(), { once: true })
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
    })(),
  }
}

function report(
  instance: { readonly artifacts: string; readonly logs: string },
  status?: string,
) {
  if (status) console.error(`opencode-drive: ${status}`)
  console.error(`opencode-drive: artifacts ${instance.artifacts}`)
}

import { decodeTimeline } from "./decode.js"
import { createTerminalParser, type TerminalParserFactory } from "./terminal.js"
import type { SampledFrame, TimelineHeader } from "./types.js"

export interface ReplayOptions {
  fps?: number
  signal?: AbortSignal
  startAtMs?: number
  durationMs?: number
}

interface InternalReplayOptions extends ReplayOptions {
  terminalFactory?: TerminalParserFactory
}

function sampleInterval(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be a positive finite number")
  return 1000 / fps
}

export async function replayRecording(path: string, options: ReplayOptions = {}): Promise<SampledFrame[]> {
  return replay(path, options)
}

export async function replay(path: string, options: InternalReplayOptions = {}): Promise<SampledFrame[]> {
  options.signal?.throwIfAborted()
  const interval = sampleInterval(options.fps ?? 60)
  if (options.startAtMs !== undefined && (!Number.isFinite(options.startAtMs) || options.startAtMs < 0))
    throw new Error("startAtMs must be a non-negative finite number")
  if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs < 0))
    throw new Error("durationMs must be a non-negative finite number")
  const records = decodeTimeline(path)[Symbol.asyncIterator]()
  const first = await records.next()
  options.signal?.throwIfAborted()
  if (first.done || first.value.type !== "header") throw new Error("Recording timeline is missing its header")
  const header: TimelineHeader = first.value
  const terminal = await (options.terminalFactory ?? createTerminalParser)(header.cols, header.rows)
  options.signal?.throwIfAborted()
  const frames: SampledFrame[] = []
  const startAt = options.startAtMs ?? 0
  const endAt = options.durationMs === undefined ? Number.POSITIVE_INFINITY : startAt + options.durationMs
  let nextSample = startAt
  let finalAt = 0
  let snapshot = terminal.snapshot()

  for (;;) {
    const next = await records.next()
    options.signal?.throwIfAborted()
    if (next.done) break
    const event = next.value
    if (event.type === "header") throw new Error("Recording timeline contains a second header")
    if (event.at_ms > endAt) {
      finalAt = endAt
      break
    }
    while (nextSample < event.at_ms && nextSample <= endAt) {
      frames.push({ atMs: nextSample, frame: snapshot })
      nextSample += interval
    }
    if (event.type === "output") terminal.write(Buffer.from(event.data, "base64"))
    else terminal.resize(event.cols, event.rows)
    snapshot = terminal.snapshot()
    finalAt = event.at_ms
  }
  terminal.finish()
  snapshot = terminal.snapshot()

  const targetFinal = options.durationMs === undefined ? Math.max(startAt, finalAt) : endAt
  while (nextSample <= targetFinal) {
    frames.push({ atMs: nextSample, frame: snapshot })
    nextSample += interval
  }
  const final = frames.at(-1)
  if (final && Math.abs(final.atMs - targetFinal) < 0.000_001) {
    frames[frames.length - 1] = { ...final, atMs: targetFinal }
  } else {
    frames.push({ atMs: targetFinal, frame: snapshot })
  }
  if (options.startAtMs !== undefined) {
    return frames.map((sample) => ({ ...sample, atMs: sample.atMs - startAt }))
  }
  const firstVisible = frames.findIndex((sample) =>
    sample.frame.lines.some((line) => line.spans.some((span) => span.text.trim().length > 0)),
  )
  if (firstVisible < 0) {
    const final = frames.at(-1)
    return final ? [{ ...final, atMs: 0 }] : []
  }
  const start = frames[firstVisible]!.atMs
  return frames.slice(firstVisible).map((sample) => ({ ...sample, atMs: sample.atMs - start }))
}

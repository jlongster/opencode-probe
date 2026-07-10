import { decodeTimeline } from "./decode.js"
import { createTerminalParser, type TerminalParserFactory } from "./terminal.js"
import type { SampledFrame, TimelineHeader } from "./types.js"

export interface ReplayOptions {
  fps?: number
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
  const interval = sampleInterval(options.fps ?? 20)
  const records = decodeTimeline(path)[Symbol.asyncIterator]()
  const first = await records.next()
  if (first.done || first.value.type !== "header") throw new Error("Recording timeline is missing its header")
  const header: TimelineHeader = first.value
  const terminal = await (options.terminalFactory ?? createTerminalParser)(header.cols, header.rows)
  const frames: SampledFrame[] = []
  let nextSample = 0
  let finalAt = 0

  for (;;) {
    const next = await records.next()
    if (next.done) break
    const event = next.value
    if (event.type === "header") throw new Error("Recording timeline contains a second header")
    while (nextSample < event.at_ms) {
      frames.push({ atMs: nextSample, frame: terminal.snapshot() })
      nextSample += interval
    }
    if (event.type === "output") terminal.write(Buffer.from(event.data, "base64"))
    else terminal.resize(event.cols, event.rows)
    finalAt = event.at_ms
  }
  terminal.finish()

  while (nextSample <= finalAt) {
    frames.push({ atMs: nextSample, frame: terminal.snapshot() })
    nextSample += interval
  }
  if (frames.length === 0 || frames.at(-1)!.atMs !== finalAt) {
    frames.push({ atMs: finalAt, frame: terminal.snapshot() })
  }
  return frames
}

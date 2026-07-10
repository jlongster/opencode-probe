import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join } from "node:path"
import { replayRecording, type ReplayOptions } from "./replay.js"
import { renderFrame } from "./render.js"

export interface ExportRecordingOptions extends ReplayOptions {
  ffmpegPath?: string
  onProgress?: (percent: number) => void
}

export interface ExportRecordingResult {
  frames: number
  durationMs: number
  width: number
  height: number
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
    })
  })
}

async function linkOrCopy(source: string, destination: string) {
  try {
    await link(source, destination)
  } catch {
    await copyFile(source, destination)
  }
}

export async function exportRecording(
  timelinePath: string,
  outputPath: string,
  options: ExportRecordingOptions = {},
): Promise<ExportRecordingResult> {
  const frames = await replayRecording(timelinePath, options)
  const final = frames.at(-1)!
  const cols = Math.max(...frames.map((sample) => sample.frame.cols))
  const rows = Math.max(...frames.map((sample) => sample.frame.rows))
  const extension = extname(outputPath).toLowerCase()
  const progress = progressReporter(options.onProgress)
  await mkdir(dirname(outputPath), { recursive: true })

  if (extension === ".png") {
    await writeFile(outputPath, renderFrame(final.frame, { cols, rows }))
    progress(100)
  } else if (extension === ".mp4") {
    const directory = await mkdtemp(join(tmpdir(), "opencode-drive-recording-"))
    try {
      const unique = new Map<string, string>()
      for (const [index, sample] of frames.entries()) {
        const hash = createHash("sha256").update(JSON.stringify(sample.frame)).digest("hex")
        let rendered = unique.get(hash)
        if (!rendered) {
          rendered = join(directory, `unique-${hash}.png`)
          await writeFile(rendered, renderFrame(sample.frame, { cols, rows }))
          unique.set(hash, rendered)
        }
        await linkOrCopy(rendered, join(directory, `frame-${String(index).padStart(8, "0")}.png`))
        progress(((index + 1) / frames.length) * 90)
      }
      await run(options.ffmpegPath ?? "ffmpeg", [
        "-y",
        "-framerate",
        String(options.fps ?? 20),
        "-i",
        join(directory, "frame-%08d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-t",
        String(Math.max(final.atMs, 1000 / (options.fps ?? 20)) / 1000),
        outputPath,
      ])
      progress(100)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } else {
    throw new Error(`Unsupported recording output extension: ${extension || "(none)"}`)
  }

  return {
    frames: frames.length,
    durationMs: final.atMs,
    width: cols * 10,
    height: rows * 20,
  }
}

function progressReporter(onProgress?: (percent: number) => void) {
  let reported = 0
  return (percent: number) => {
    const target = Math.min(100, Math.floor(percent / 10) * 10)
    while (reported < target) {
      reported += 10
      onProgress?.(reported)
    }
  }
}

import { createHash } from "node:crypto"
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runFfmpeg } from "./ffmpeg.js"

export interface ImageFrame {
  readonly atMs: number
  readonly key: string
  readonly render: () => Buffer | Promise<Buffer>
}

export interface EncodeOptions {
  readonly ffmpegPath?: string
  readonly fps?: number
  readonly onProgress?: (percent: number) => void
  readonly signal?: AbortSignal
}

export async function encodeFrames(
  frames: ReadonlyArray<ImageFrame>,
  output: string,
  options: EncodeOptions = {},
) {
  const final = frames.at(-1)
  if (!final) throw new Error("recording has no frames")
  const fps = options.fps ?? 60
  await mkdir(dirname(output), { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), "opencode-drive-recording-"))
  const progress = progressReporter(options.onProgress)
  try {
    const unique = new Map<string, string>()
    for (const [index, frame] of frames.entries()) {
      options.signal?.throwIfAborted()
      const hash = createHash("sha256").update(frame.key).digest("hex")
      let rendered = unique.get(hash)
      if (!rendered) {
        rendered = join(directory, `unique-${hash}.png`)
        await writeFile(rendered, await frame.render(), { signal: options.signal })
        unique.set(hash, rendered)
      }
      await linkOrCopy(rendered, join(directory, `frame-${String(index).padStart(8, "0")}.png`))
      progress(((index + 1) / frames.length) * 90)
    }
    const concat = join(directory, "frames.ffconcat")
    const entries = frames.flatMap((frame, index) => {
      const next = frames[index + 1]
      const file = `file frame-${String(index).padStart(8, "0")}.png`
      return next ? [file, `duration ${(next.atMs - frame.atMs) / 1000}`] : [file]
    })
    await writeFile(concat, `ffconcat version 1.0\n${entries.join("\n")}\n`, {
      signal: options.signal,
    })
    await runFfmpeg(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-y",
        "-r",
        String(fps),
        "-safe",
        "0",
        "-f",
        "concat",
        "-i",
        concat,
        "-c:v",
        "libx264",
        "-crf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-fps_mode",
        "vfr",
        output,
      ],
      options.signal,
    )
    progress(100)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function linkOrCopy(source: string, destination: string) {
  try {
    await link(source, destination)
  } catch {
    await copyFile(source, destination)
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

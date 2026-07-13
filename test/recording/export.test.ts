import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { exportRecording, renderFrame } from "../../src/recording/index.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("exports the final frame as a PNG and creates its parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drive-export-test-"))
  directories.push(directory)
  const timeline = join(directory, "timeline.jsonl")
  await writeFile(
    timeline,
    `${JSON.stringify({ type: "header", version: 1, cols: 4, rows: 2, encoding: "base64" })}\n` +
      `${JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("hi").toString("base64") })}\n`,
  )
  const output = join(directory, "nested", "frame.png")
  const result = await exportRecording(timeline, output)
  expect(result).toEqual({ frames: 1, durationMs: 0, width: 40, height: 40 })
  expect((await readFile(output)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect((await stat(output)).size).toBeGreaterThan(100)
})

test("exports resized recordings on a stable maximum-size canvas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drive-export-resize-test-"))
  directories.push(directory)
  const timeline = join(directory, "timeline.jsonl")
  await writeFile(
    timeline,
    [
      JSON.stringify({ type: "header", version: 1, cols: 8, rows: 4, encoding: "base64" }),
      JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("wide").toString("base64") }),
      JSON.stringify({ type: "resize", at_ms: 100, cols: 4, rows: 2 }),
      JSON.stringify({ type: "output", at_ms: 100, data: Buffer.from("small").toString("base64") }),
      "",
    ].join("\n"),
  )
  const output = join(directory, "frame.png")
  const result = await exportRecording(timeline, output)
  const data = await readFile(output)

  expect(result).toEqual({ frames: 3, durationMs: 100, width: 80, height: 80 })
  expect(data.readUInt32BE(16)).toBe(80)
  expect(data.readUInt32BE(20)).toBe(80)
})

test("centers capture glyphs vertically in their cells", async () => {
  const image = await loadImage(
    renderFrame({
      cols: 2,
      rows: 1,
      cursor: { row: 0, col: 0, visible: false },
      lines: [
        { spans: [{ text: "Mg", width: 2, fg: 0xffffff, bg: 0x080808, attributes: 0 }] },
      ],
    }),
  )
  const canvas = createCanvas(20, 20)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, 20, 20).data
  const inkRows = Array.from({ length: 20 }, (_, row) => row).filter((row) =>
    Array.from({ length: 20 }, (_, column) => (row * 20 + column) * 4).some(
      (offset) =>
        pixels[offset] !== 8 || pixels[offset + 1] !== 8 || pixels[offset + 2] !== 8,
    ),
  )

  expect((inkRows[0]! + inkRows.at(-1)!) / 2).toBe(10.5)
})

test("accepts valid capture font overrides", async () => {
  const font = import.meta.resolve(
    "@fontsource/commit-mono/files/commit-mono-latin-400-normal.woff2",
  )
  const child = renderImport({ OPENCODE_DRIVE_FONT: fileURLToPath(font) })
  expect(await child.exited).toBe(0)
})

test("rejects invalid capture font overrides", async () => {
  const child = renderImport({ OPENCODE_DRIVE_FONT: "/missing/capture-font.woff2" })
  const stderr = new Response(child.stderr).text()
  expect(await child.exited).toBe(1)
  expect(await stderr).toContain("Failed to register capture font: /missing/capture-font.woff2")
})

if (Bun.which("ffmpeg")) {
  test("exports sampled frames as an H.264 MP4 when ffmpeg is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drive-export-ffmpeg-test-"))
    directories.push(directory)
    const timeline = join(directory, "timeline.jsonl")
    await writeFile(
      timeline,
      [
        JSON.stringify({ type: "header", version: 1, cols: 4, rows: 2, encoding: "base64" }),
        JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("A").toString("base64") }),
        JSON.stringify({ type: "output", at_ms: 250, data: Buffer.from("B").toString("base64") }),
        "",
      ].join("\n"),
    )
    const output = join(directory, "video.mp4")
    const progress: number[] = []
    const result = await exportRecording(timeline, output, {
      onProgress: (percent) => progress.push(percent),
    })
    const data = await readFile(output)
    expect(result.frames).toBe(6)
    expect(result.durationMs).toBe(250)
    expect(data.subarray(4, 8).toString()).toBe("ftyp")
    expect(data.length).toBeGreaterThan(500)
    expect(progress).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  })
}

function renderImport(env: Record<string, string>) {
  return Bun.spawn([process.execPath, "-e", 'await import("./src/recording/render.ts")'], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  })
}

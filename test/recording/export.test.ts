import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportRecording } from "../../src/recording/index.js"

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

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  controlPath,
  listInstances,
  manifestPath,
  register,
  unregister,
} from "../../src/cli/registry.js"
import {
  createResponseSettings,
  generateResponse,
} from "../../src/cli/response-generator.js"
import { splitText } from "../../src/cli/mock-backend.js"

const roots: string[] = []
const instances: Array<{ root: string; name: string }> = []

afterEach(async () => {
  await Promise.all(
    instances.splice(0).map(async ({ root, name }) => {
      await spawn(["stop", "--name", name], root).exited
    }),
  )
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("opencode-drive", () => {
  test("starts, drives, lists logs, restarts, and stops a named detached instance", async () => {
    const root = await temporary()
    const name = "detached-test"
    const started = spawn(
      [
        "start",
        "--name",
        name,
        "--record",
        "--",
        process.execPath,
        fixture("fake-opencode.ts"),
      ],
      root,
    )
    const [startStatus, startError] = await Promise.all([
      started.exited,
      new Response(started.stderr).text(),
    ])
    expect(startStatus).toBe(0)
    expect(startError).toContain("opencode-drive: artifacts ")
    expect(startError).not.toContain(`opencode-drive: ${name}`)
    instances.push({ root, name })

    const manifest = await Bun.file(
      join(root, "registry", `${name}.json`),
    ).json()
    roots.push(manifest.artifacts)
    expect(manifest.visible).toBe(false)
    expect(manifest.endpoints.ui).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(manifest.endpoints.backend).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)

    const state = spawn(["send", "--command.ui.state"], root)
    expect(await state.exited).toBe(0)
    expect(
      JSON.parse(await new Response(state.stdout).text()).focused.editor,
    ).toBe(true)

    const screenshot = spawn(["screenshot", "--name", name], root)
    expect(await screenshot.exited).toBe(0)
    const screenshotPath = (await new Response(screenshot.stdout).text()).trim()
    expect(
      screenshotPath.startsWith(
        `${join(root, "output")}/screenshot-`,
      ),
    ).toBe(true)
    expect(screenshotPath.endsWith(".png")).toBe(true)

    const defaults = spawn(["responses"], root)
    expect(await defaults.exited).toBe(0)
    expect(await new Response(defaults.stdout).text()).toBe(
      "Types: text,reasoning,diff,tool\nTools: write,apply_patch\n",
    )

    const configured = spawn(
      [
        "responses",
        "--types",
        "reasoning,tool,reasoning",
        "--tools",
        "read,grep,read",
      ],
      root,
    )
    expect(await configured.exited).toBe(0)
    expect(await new Response(configured.stdout).text()).toBe(
      "Types: reasoning,tool\nTools: read,grep\n",
    )

    const invalid = spawn(["responses", "--types", "unknown"], root)
    expect(await invalid.exited).toBe(1)
    expect(await new Response(invalid.stderr).text()).toContain(
      "unknown response types: unknown",
    )

    const listed = spawn(["logs"], root)
    expect(await listed.exited).toBe(0)
    expect(await new Response(listed.stdout).text()).toBe(
      `${join(manifest.artifacts, "logs", "opencode", "log", "opencode*.log")}\n`,
    )

    const restarted = spawn(["restart"], root)
    expect(await restarted.exited).toBe(0)
    const restartedRecording = (await new Response(restarted.stdout).text()).trim()
    expect(restartedRecording).toMatch(/\/output\/recording-.*\.mp4$/)
    expect(await Bun.file(restartedRecording).exists()).toBe(true)
    await waitForLines(join(manifest.artifacts, "launches.txt"), 2)
    const persisted = spawn(["responses"], root)
    expect(await persisted.exited).toBe(0)
    expect(await new Response(persisted.stdout).text()).toBe(
      "Types: reasoning,tool\nTools: read,grep\n",
    )
    expect(
      await spawn(["send", "--name", name, "--command.ui.state"], root).exited,
    ).toBe(0)

    const stopped = spawn(["stop"], root)
    const [stoppedStatus, stoppedOutput, stoppedError] = await Promise.all([
      stopped.exited,
      new Response(stopped.stdout).text(),
      new Response(stopped.stderr).text(),
    ])
    expect(stoppedStatus).toBe(0)
    expect(stoppedOutput).toBe("")
    const stoppedRecording = stoppedError.match(
      /Video successfully created: (.+\.mp4)/,
    )?.[1]
    expect(stoppedRecording).toBeDefined()
    expect(stoppedRecording).toMatch(/\/output\/recording-.*\.mp4$/)
    expect(await Bun.file(stoppedRecording!).exists()).toBe(true)
    expect(stoppedError).toContain("Rendering video: 10%")
    expect(stoppedError).toContain("Rendering video: 100%")
    expect(stoppedError).toContain(
      `Video successfully created: ${stoppedRecording}`,
    )
    expect(
      await Bun.file(join(root, "registry", `${name}.json`)).exists(),
    ).toBe(false)
    instances.splice(
      instances.findIndex((item) => item.name === name),
      1,
    )
  }, 60_000)

  test("exports a completed timeline after the OpenCode child exits", async () => {
    const root = await temporary()
    const name = "exited-recording-test"
    const started = spawn(
      ["start", "--name", name, "--record", "--", process.execPath, fixture("fake-opencode.ts"), "500"],
      root,
    )
    const [status, stderr] = await Promise.all([started.exited, new Response(started.stderr).text()])
    expect(status).toBe(0)
    const artifacts = stderr.match(/opencode-drive: artifacts (.+)/)?.[1]
    expect(artifacts).toBeDefined()
    roots.push(artifacts!)

    const deadline = Date.now() + 10_000
    while (await Bun.file(join(root, "registry", `${name}.json`)).exists()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for exited instance cleanup")
      await Bun.sleep(25)
    }
    const files = await readdir(join(root, "output"))
    const video = files.find((file) => file.endsWith(".mp4"))
    expect(video).toBeDefined()
    expect((await Bun.file(join(root, "output", video!)).size)).toBeGreaterThan(500)
  }, 15_000)

  test("does not record unless start receives --record", async () => {
    const root = await temporary()
    const name = "no-recording-test"
    expect(
      await spawn(
        ["start", "--name", name, "--", process.execPath, fixture("fake-opencode.ts")],
        root,
      ).exited,
    ).toBe(0)
    instances.push({ root, name })
    const manifest = await Bun.file(join(root, "registry", `${name}.json`)).json()
    roots.push(manifest.artifacts)
    const drive = await Bun.file(join(manifest.artifacts, "drive", `${name}.json`)).json()
    expect(drive.recording).toBeUndefined()

    const stopped = spawn(["stop", "--name", name], root)
    expect(await stopped.exited).toBe(0)
    expect(await new Response(stopped.stdout).text()).toBe("success\n")
    expect(await readdir(join(root, "output"))).toEqual([])
    instances.pop()
  })

  test("rejects duplicate names", async () => {
    const root = await temporary()
    const name = "duplicate-test"
    const args = [
      "start",
      "--name",
      name,
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ]
    expect(await spawn(args, root).exited).toBe(0)
    instances.push({ root, name })
    const duplicate = spawn(args, root)
    const [status, stderr] = await Promise.all([
      duplicate.exited,
      new Response(duplicate.stderr).text(),
    ])
    expect(status).toBe(1)
    expect(stderr).toContain(`drive instance "${name}" is already running`)
  })

  test("only the owning detached launcher reports concurrent startup success", async () => {
    const root = await temporary()
    const name = "concurrent-start"
    const args = [
      "start",
      "--name",
      name,
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ]
    const children = [spawn(args, root), spawn(args, root)]
    expect((await Promise.all(children.map((child) => child.exited))).sort()).toEqual([
      0, 1,
    ])
    const manifest = await Bun.file(
      join(root, "registry", `${name}.json`),
    ).json()
    roots.push(manifest.artifacts)
    instances.push({ root, name })
  })

  test("registers only one concurrent owner for a name", async () => {
    const root = await temporary()
    await withRegistry(root, async () => {
      const results = await Promise.allSettled([
        register(testManifest("racing", process.pid)),
        register(testManifest("racing", process.pid)),
      ])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      )
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(
        1,
      )
    })
  })

  test("does not let a stale owner remove its replacement", async () => {
    const root = await temporary()
    await withRegistry(root, async () => {
      const stalePid = 2_000_000_000
      await register(testManifest("replacement", stalePid))
      await register(testManifest("replacement", process.pid))
      await unregister("replacement", stalePid)
      expect((await Bun.file(manifestPath("replacement")).json()).pid).toBe(
        process.pid,
      )
    })
  })

  test("refuses to drive an instance that is still starting", async () => {
    const root = await temporary()
    await withRegistry(root, () =>
      register(testManifest("starting", process.pid, "starting")),
    )
    const child = spawn(
      ["send", "--name", "starting", "--command.ui.state"],
      root,
    )
    const [status, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect(status).toBe(1)
    expect(stderr).toContain('drive instance "starting" is still starting')
  })

  test("lists sorted active instances and prunes stale state", async () => {
    const root = await temporary()
    await withRegistry(root, async () => {
      await register(testManifest("zeta", process.pid))
      await register(testManifest("alpha", process.pid))
      await register(testManifest("stale", 2_000_000_000))
      await Bun.write(controlPath("orphan"), "")
      expect((await listInstances()).map((manifest) => manifest.name)).toEqual([
        "alpha",
        "zeta",
      ])
      expect(await Bun.file(manifestPath("stale")).exists()).toBe(false)
      expect(await Bun.file(controlPath("stale")).exists()).toBe(false)
      expect(await Bun.file(controlPath("orphan")).exists()).toBe(false)
    })
    const listed = spawn(["list"], root)
    expect(await listed.exited).toBe(0)
    expect(await new Response(listed.stdout).text()).toBe(
      `alpha: ${join(root, "registry", "alpha.json")}\nzeta: ${join(root, "registry", "zeta.json")}\n`,
    )
  })

  test("reports optional-name discovery errors", async () => {
    const root = await temporary()
    const missing = spawn(["logs"], root)
    expect(await missing.exited).toBe(1)
    expect(await new Response(missing.stderr).text()).toContain(
      "no drive instances are running",
    )
  })

  test("runs multiple named instances concurrently", async () => {
    const root = await temporary()
    for (const name of ["first", "second"]) {
      expect(
        await spawn(
          [
            "start",
            "--name",
            name,
            "--",
            process.execPath,
            fixture("fake-opencode.ts"),
          ],
          root,
        ).exited,
      ).toBe(0)
      instances.push({ root, name })
    }
    const first = await Bun.file(join(root, "registry", "first.json")).json()
    const second = await Bun.file(join(root, "registry", "second.json")).json()
    roots.push(first.artifacts, second.artifacts)
    expect(first.endpoints.ui).not.toBe(second.endpoints.ui)
    expect(
      await spawn(["send", "--name", "first", "--command.ui.state"], root)
        .exited,
    ).toBe(0)
    expect(
      await spawn(["send", "--name", "second", "--command.ui.state"], root)
        .exited,
    ).toBe(0)

    const ambiguous = spawn(["logs"], root)
    const [status, stderr] = await Promise.all([
      ambiguous.exited,
      new Response(ambiguous.stderr).text(),
    ])
    expect(status).toBe(1)
    expect(stderr).toContain(
      "multiple drive instances are running; pass --name (first, second)",
    )
    const listed = spawn(["list"], root)
    expect(await listed.exited).toBe(0)
    expect(await new Response(listed.stdout).text()).toBe(
      `first: ${join(root, "registry", "first.json")}\nsecond: ${join(root, "registry", "second.json")}\n`,
    )
  })

  test("surfaces the owner log when detached startup fails", async () => {
    const root = await temporary()
    const name = "failed-start"
    const child = spawn(
      ["start", "--name", name, "--", process.execPath, "-e", "process.exit(7)"],
      root,
    )
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status).toBe(1)
    expect(stderr).toContain(`see ${join(root, "registry", `${name}.log`)}`)
    expect(
      await Bun.file(join(root, "registry", `${name}.log`)).text(),
    ).toContain("OpenCode exited with status 7")
  })

  test("keeps visible instances in the foreground", async () => {
    const root = await temporary()
    const name = "visible-test"
    const running = spawn(
      [
        "start",
        "--visible",
        "--name",
        name,
        "--",
        process.execPath,
        fixture("fake-opencode.ts"),
        "500",
      ],
      root,
    )
    expect(await running.exited).toBe(0)
    expect(
      await Bun.file(join(root, "registry", `${name}.json`)).exists(),
    ).toBe(false)
  })

  test("blocks and stops the instance after a script completes", async () => {
    const root = await temporary()
    const name = "script-test"
    const child = spawn(
      [
        "start",
        "--name",
        name,
        "--script",
        fixture("script.ts"),
        "--",
        process.execPath,
        fixture("fake-opencode.ts"),
      ],
      root,
    )
    const started = Date.now()
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    const artifacts = artifactPath(stderr)
    roots.push(artifacts)
    expect(await Bun.file(join(artifacts, "script-result.json")).exists()).toBe(
      true,
    )
    expect(
      await Bun.file(join(artifacts, "seeded-at-launch.txt")).text(),
    ).toBe("export const seeded = true\n")
    expect(await Bun.file(join(artifacts, "child-cwd.txt")).text()).toBe(
      join(artifacts, "files"),
    )
    const pid = Number(await Bun.file(join(artifacts, "child.pid")).text())
    expect(running(pid)).toBe(false)
    expect(
      await Bun.file(join(root, "registry", `${name}.json`)).exists(),
    ).toBe(false)
  })

  test("stops a visible instance after a script completes", async () => {
    const root = await temporary()
    const name = "visible-script-test"
    const child = spawn(
      [
        "start",
        "--visible",
        "--name",
        name,
        "--script",
        fixture("script.ts"),
        "--",
        process.execPath,
        fixture("fake-opencode.ts"),
      ],
      root,
    )
    expect(await child.exited).toBe(0)
    expect(
      await Bun.file(join(root, "registry", `${name}.json`)).exists(),
    ).toBe(false)
  })

  test("stops a hanging script after the OpenCode child exits", async () => {
    const root = await temporary()
    const name = "exited-script-test"
    const child = spawn(
      [
        "start",
        "--name",
        name,
        "--script",
        fixture("hanging-script.ts"),
        "--",
        process.execPath,
        fixture("fake-opencode.ts"),
        "500",
      ],
      root,
    )
    expect(await child.exited).toBe(0)
    expect(
      await Bun.file(join(root, "registry", `${name}.json`)).exists(),
    ).toBe(false)
  })

  test("rejects removed LLM commands", async () => {
    const root = await temporary()
    expect(await spawn(["send", "--command.llm.pending"], root).exited).toBe(1)
  })

  test("generates configured tool calls from offered schemas", () => {
    const settings = createResponseSettings()
    settings.update({ types: ["tool"], tools: ["read"] })
    const tools = [
      {
        type: "function",
        function: {
          name: "shell",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              offset: { type: "integer" },
              limit: { type: "integer" },
            },
            required: ["path", "offset", "limit"],
          },
        },
      },
    ]
    const response = generateResponse(settings.current(), {
      id: "ex_1",
      url: "https://api.openai.com/v1/chat/completions",
      body: { tools },
    })
    expect(response.finish).toBe("tool-calls")
    expect(response.items).toEqual([
      {
        type: "toolCall",
        index: 0,
        id: expect.stringMatching(/^call_[a-f0-9]{16}$/),
        name: "read",
        input: {
          path: ".opencode/opencode.jsonc",
          offset: 1,
          limit: 120,
        },
      },
    ])

    settings.update({ types: ["tool"], tools: ["shell", "read"] })
    const multiple = generateResponse(settings.current(), {
      id: "ex_2",
      url: "https://api.openai.com/v1/chat/completions",
      body: { tools },
    })
    expect(multiple.items).toHaveLength(2)
    expect(multiple.items).toMatchObject([
      { type: "toolCall", index: 0, name: "shell" },
      { type: "toolCall", index: 1, name: "read" },
    ])
  })

  test("generates patches and finishes tool continuations with text", () => {
    const settings = createResponseSettings()
    settings.update({ types: ["diff"], tools: ["apply_patch"] })
    const body = {
      tools: [
        {
          type: "function",
          function: {
            name: "apply_patch",
            parameters: {
              type: "object",
              properties: { patchText: { type: "string" } },
              required: ["patchText"],
            },
          },
        },
      ],
    }
    const response = generateResponse(settings.current(), {
      id: "ex_1",
      url: "https://api.openai.com/v1/chat/completions",
      body,
    })
    expect(response.finish).toBe("tool-calls")
    expect(response.items[0]).toMatchObject({
      type: "toolCall",
      name: "apply_patch",
      input: {
        patchText: expect.stringMatching(
          /\n-export function greet\([^)]+\)[\s\S]+\n\+export function greet\(/,
        ),
      },
    })

    const continuation = generateResponse(settings.current(), {
      id: "ex_2",
      url: "https://api.openai.com/v1/chat/completions",
      body: { ...body, messages: [{ role: "tool", content: "done" }] },
    })
    expect(continuation.finish).toBe("stop")
    expect(continuation.items[0]).toMatchObject({ type: "textDelta" })

    const laterTurn = generateResponse(settings.current(), {
      id: "ex_later",
      url: "https://api.openai.com/v1/chat/completions",
      body: {
        ...body,
        messages: [
          { role: "tool", content: "done" },
          { role: "assistant", content: "Finished." },
          { role: "user", content: "Make another change." },
        ],
      },
    })
    expect(laterTurn.finish).toBe("tool-calls")

    settings.update({ types: ["diff"], tools: ["edit", "write"] })
    const write = generateResponse(settings.current(), {
      id: "ex_3",
      url: "https://api.openai.com/v1/chat/completions",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "edit",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  oldString: { type: "string" },
                  newString: { type: "string" },
                },
                required: ["path", "oldString", "newString"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "write",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
          },
        ],
      },
    })
    expect(write.items[0]).toMatchObject({
      type: "toolCall",
      name: "write",
      input: {
        path: "src/garden.js",
        content: expect.stringContaining("export function greet"),
      },
    })
  })

  test("splits generated prose into small streaming chunks", () => {
    const text = "Mushrooms gather quietly while flowers map the path home."
    const chunks = splitText(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.trim().split(/\s+/).length <= 3)).toBe(
      true,
    )
  })
})

function spawn(args: ReadonlyArray<string>, root: string) {
  return Bun.spawn([process.execPath, resolve("src/cli/index.ts"), ...args], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DRIVE_REGISTRY_DIR: join(root, "registry"),
      OPENCODE_DRIVE_MEDIA_DIR: join(root, "output"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

function fixture(name: string) {
  return resolve("test", "fixtures", name)
}

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "opencode-drive-test-"))
  roots.push(root)
  return root
}

async function waitForLines(file: string, count: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const lines = await Bun.file(file)
      .text()
      .then((text) => text.trim().split("\n").length)
      .catch(() => 0)
    if (lines >= count) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${count} lines in ${file}`)
}

async function waitForMissing(file: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await Bun.file(file).exists())) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${file} removal`)
}

function artifactPath(stderr: string) {
  const line = stderr
    .split("\n")
    .find((value) => value.startsWith("opencode-drive: artifacts "))
  if (!line) throw new Error("artifact path was not reported")
  return line.slice("opencode-drive: artifacts ".length)
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function testManifest(
  name: string,
  pid: number,
  status: "starting" | "ready" = "ready",
) {
  return {
    version: 1 as const,
    name,
    pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    artifacts: join(tmpdir(), name),
    visible: false,
    status,
    endpoints: {
      ui: "ws://127.0.0.1:1",
      backend: "ws://127.0.0.1:2",
    },
    control: join(tmpdir(), `${name}.sock`),
  }
}

async function withRegistry<T>(root: string, task: () => Promise<T>) {
  const previous = process.env.DRIVE_REGISTRY_DIR
  process.env.DRIVE_REGISTRY_DIR = join(root, "registry")
  try {
    return await task()
  } finally {
    if (previous === undefined) delete process.env.DRIVE_REGISTRY_DIR
    else process.env.DRIVE_REGISTRY_DIR = previous
  }
}

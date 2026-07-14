import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createScriptFileSystem } from "../script/filesystem.js"
import {
  commitScriptProject,
  hasGitMetadata,
  initializeScriptProject,
} from "../script/project.js"
import type {
  JsonObject,
  ScriptProject,
  ScriptSetup,
} from "../script/types.js"

export function artifactDirectory() {
  return resolve(join(tmpdir(), "opencode-drive"))
}

export async function initializeInstance(name?: string) {
  const artifacts = resolve(
    join(artifactDirectory(), `run-${crypto.randomUUID().slice(0, 6)}`),
  )
  const logs = join(artifacts, "logs")
  const drive = join(artifacts, "drive")
  await Promise.all([
    mkdir(logs, { recursive: true }),
    mkdir(drive, { recursive: true }),
    mkdir(join(artifacts, "home", ".cache"), { recursive: true }),
    mkdir(join(artifacts, "home", ".config"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "share"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "state"), { recursive: true }),
  ])
  const files = join(artifacts, "files")
  const defaultConfig = await Bun.file(
    new URL("./default-config.jsonc", import.meta.url),
  ).text()
  await Promise.all([
    mkdir(join(files, ".git"), { recursive: true }),
    mkdir(join(files, ".opencode"), { recursive: true }),
    mkdir(join(files, "src"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(files, ".opencode", "opencode.jsonc"), defaultConfig),
    Bun.write(
      join(files, "src", "garden.js"),
      "export function greet(name) {\n  return `Hello, ${name}.`\n}\n",
    ),
    ...(name ? [Bun.write(join(drive, "name"), `${name}\n`)] : []),
  ])
  return artifacts
}

export async function prepareInstanceProject(options: {
  readonly artifacts: string
  readonly project?: ScriptProject
  readonly setup?: ScriptSetup
}) {
  const files = join(resolve(options.artifacts), "files")
  const configPath = join(files, ".opencode", "opencode.jsonc")
  if (options.project) await initializeScriptProject(files, options.project)
  if (options.setup) {
    const protectGit =
      Boolean(options.project?.git) || (await hasGitMetadata(files))
    const configFile = Bun.file(configPath)
    const config: JsonObject = await (await configFile.exists()
      ? configFile
      : Bun.file(new URL("./default-config.jsonc", import.meta.url))
    ).json()
    await options.setup({
      fs: createScriptFileSystem(files, { git: protectGit }),
      config,
    })
    await Bun.write(configPath, `${JSON.stringify(config, undefined, 2)}\n`)
  }
  if (options.project?.git) await commitScriptProject(files)
}

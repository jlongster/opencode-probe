#!/usr/bin/env bun
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import packageJson from "../../package.json" with { type: "json" }
import { api } from "./api.js"
import { extractCommands } from "./parse.js"
import { list } from "./list.js"
import { logs } from "./logs.js"
import { restart } from "./restart.js"
import { responses } from "./responses.js"
import { send } from "./send.js"
import { start } from "./start.js"
import { stop } from "./stop.js"
import type { DriveCommand, SendOptions, StartOptions } from "./types.js"

const extracted = extract()
const startName = Flag.string("name").pipe(
  Flag.withDefault("default"),
  Flag.withDescription("Instance name"),
)
const name = Flag.string("name").pipe(
  Flag.optional,
  Flag.withDescription("Instance name (inferred when exactly one is running)"),
)

const startCommand = Command.make(
  "start",
  {
    name: startName,
    daemon: Flag.boolean("daemon").pipe(
      Flag.withDescription("Run as detached instance owner"),
    ),
    script: Flag.string("script").pipe(
      Flag.optional,
      Flag.withDescription("JavaScript or TypeScript automation module"),
    ),
    visible: Flag.boolean("visible").pipe(
      Flag.withDescription("Show OpenCode in the terminal"),
    ),
    dev: Flag.string("dev").pipe(
      Flag.optional,
      Flag.withDescription("Path to an OpenCode development checkout"),
    ),
    state: Flag.string("state").pipe(
      Flag.optional,
      Flag.withDescription("Simulation snapshot containing files/"),
    ),
  },
  (config) =>
    execute(() =>
      start(toStartOptions(config, extracted.commands, extracted.app)),
    ),
).pipe(
  Command.withDescription("Launch a local simulated OpenCode instance"),
  Command.withExamples([
    {
      command: "opencode-drive start",
      description: "Launch headless OpenCode on the default ports",
    },
    {
      command: "opencode-drive start --visible",
      description: "Launch visible OpenCode on the default ports",
    },
    {
      command: "opencode-drive start --script ./drive.ts",
      description: "Launch headless OpenCode and run a script",
    },
  ]),
)

const sendCommand = Command.make("send", { name }, (config) =>
  execute(() =>
    send(
      toSendOptions(
        Option.getOrUndefined(config.name),
        extracted.commands,
        extracted.app,
      ),
    ),
  ),
).pipe(
  Command.withDescription("Send UI commands to OpenCode on the default port"),
  Command.withExamples([
    {
      command:
        'opencode-drive send --command.ui.type \'{"text":"hello"}\' --command.ui.state',
      description: "Execute an ordered UI command batch",
    },
  ]),
)

const apiCommand = Command.make("api", {}, () => execute(api)).pipe(
  Command.withDescription("Print the OpenCode drive UI protocol"),
)

const restartCommand = Command.make("restart", { name }, (config) =>
  execute(() => restart(Option.getOrUndefined(config.name))),
).pipe(
  Command.withDescription(
    "Restart a named OpenCode instance and rerun its script",
  ),
)

const stopCommand = Command.make("stop", { name }, (config) =>
  execute(() => stop(Option.getOrUndefined(config.name))),
).pipe(Command.withDescription("Stop a named OpenCode instance"))

const logsCommand = Command.make("logs", { name }, (config) =>
  execute(() => logs(Option.getOrUndefined(config.name))),
).pipe(Command.withDescription("List log files for a named OpenCode instance"))

const listCommand = Command.make("list", {}, () => execute(list)).pipe(
  Command.withDescription("List active OpenCode instances"),
)

const responsesCommand = Command.make(
  "responses",
  {
    name,
    types: Flag.string("types").pipe(
      Flag.optional,
      Flag.withDescription("Comma-delimited response types"),
    ),
    tools: Flag.string("tools").pipe(
      Flag.optional,
      Flag.withDescription("Comma-delimited tool names, or * for all tools"),
    ),
  },
  (config) =>
    execute(() =>
      responses({
        name: Option.getOrUndefined(config.name),
        types: Option.getOrUndefined(config.types),
        tools: Option.getOrUndefined(config.tools),
      }),
    ),
).pipe(Command.withDescription("Configure simulated LLM response generation"))

const root = Command.make("opencode-drive").pipe(
  Command.withDescription("Drive real and simulated OpenCode instances"),
  Command.withSubcommands([
    startCommand,
    sendCommand,
    listCommand,
    responsesCommand,
    logsCommand,
    restartCommand,
    stopCommand,
    apiCommand,
  ]),
)

Command.runWith(root, { version: packageJson.version })(extracted.args).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)

function toStartOptions(
  config: {
    readonly script: Option.Option<string>
    readonly name: string
    readonly daemon: boolean
    readonly visible: boolean
    readonly dev: Option.Option<string>
    readonly state: Option.Option<string>
  },
  commands: ReadonlyArray<DriveCommand>,
  app: ReadonlyArray<string>,
): StartOptions {
  if (commands.length > 0)
    throw new Error("start does not accept command flags; use send or --script")
  const options = {
    kind: "start" as const,
    name: config.name,
    daemon: config.daemon,
    script: Option.getOrUndefined(config.script),
    visible: config.visible,
    dev: Option.getOrUndefined(config.dev),
    state: Option.getOrUndefined(config.state),
    command: app,
  }
  if (options.dev !== undefined && app.length > 0)
    throw new Error("--dev cannot be combined with a command after --")
  return options
}

function toSendOptions(
  name: string | undefined,
  commands: ReadonlyArray<DriveCommand>,
  app: ReadonlyArray<string>,
): SendOptions {
  if (app.length > 0) throw new Error("send does not accept a command after --")
  return { kind: "send", name, commands }
}

function execute(task: () => Promise<void>) {
  return Effect.tryPromise({ try: task, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        )
        process.exitCode = 1
      }),
    ),
  )
}

function extract() {
  try {
    return extractCommands(process.argv.slice(2))
  } catch (error) {
    console.error(
      `opencode-drive: ${error instanceof Error ? error.message : String(error)}`,
    )
    return process.exit(1)
  }
}

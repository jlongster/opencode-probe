---
name: opencode-drive
description: Use when an agent needs to drive OpenCode with an Effect program or interact with an isolated instance
---

# OpenCode Drive

Use `opencode-drive` to launch an isolated OpenCode instance and control its TUI and simulated LLM.

Default to a one-shot Effect program. Use `defineScript` for named, visible,
restartable, or manual-launch workflows; it is also Effect-only. Use live
commands only for interactive development against a persistent or visible
instance.

## OpenCode Source Default

Unless the user explicitly names V1 or another ref, target OpenCode's canonical
`v2` branch. Keep the reusable OpenCode checkout on local branch `v2`, tracking
`origin/v2`, and refresh it before a run that requires current source. Do not
silently substitute `dev`, `main`, or an old capture revision. If the intended
generation is genuinely ambiguous, ask one concise clarifying question.

For an exact historical comparison, use the source revision recorded by that
capture set in a detached worktree. Otherwise reproduce catalog states against
current `v2` first. If protocol drift prevents replay, report that incompatibility
before falling back to the recorded revision.

When the user asks to inspect or critique a screen, finish by calling
`ui.screenshot(...)`, inspect the PNG, and upload it to the conversation. A raw
frame artifact alone is not the deliverable.

## Catalog State IDs

Browse and copy OpenCode terminal state IDs from:

```text
https://catalog.kitlangton.dev
```

Replayable flow states expose canonical `<flow-id>/<state-id>` addresses, for example:

```text
patch-success-lifecycle/permission-prompt
```

Reproduce one from an `opencode-drive` source checkout:

```bash
bun run catalog:reproduce -- patch-success-lifecycle/permission-prompt \
  --opencode /path/to/opencode \
  --output /tmp/permission-prompt.frame.json
```

The command executes the registered recipe only through that checkpoint and writes an `opencode-terminal-frame-v1` artifact. Only flows in `apps/catalog/scenarios/index.ts` are replayable. Browse-only flows and screen cards copy standalone capture IDs instead; do not invent a flow prefix. Use current OpenCode `v2` unless the task explicitly requires the source revision shown by the selected capture set.

To compare a committed local OpenCode branch against current v2 across every catalog state:

```bash
bun run catalog:capture -- \
  --opencode /path/to/opencode \
  --revision origin/v2 \
  --revision HEAD
```

Add repeated `--theme` flags to capture the same commit pair under multiple themes. Capture resolves detached immutable worktrees, retains earlier sets, and sorts sets by commit time. Uncommitted changes are excluded by design.

## Effect Programs

Write `drive.ts` as a default-exported, fully provided Effect, then run it directly:

```ts
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use(
  {
    project: {
      git: true,
      files: {
        "src/value.ts": "export const value = 1\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(Llm.text("The value is 1."))
      yield* ui.submit("Read src/value.ts")
      yield* ui.waitFor("The value is 1.")
      yield* ui.screenshot("result")
    }),
)
```

```bash
opencode-drive run ./drive.ts
```

`run` type-checks the module before importing it and requires its default export to be an `Effect<unknown, unknown, never>`. It accepts exactly one module path; it does not accept `--command.*` flags or application arguments after `--`.

`OpenCodeDriver.use` is the normal lifecycle boundary. It creates an isolated project, starts the server and primary TUI, races the program against backend failure, settles queued LLM work, closes all TUIs, exports recordings, and removes the artifact directory unless `keepArtifacts: true` is set. Settlement failures fail the program.

Use `OpenCodeDriver.make` only when explicit settlement is necessary. It requires a scope, and the program must call `driver.settle()` before leaving that scope.

### Deterministic Project DSL

Declare the project, semantic OpenCode configuration, and TUI configuration in `OpenCodeDriver.use` options:

```ts
export default OpenCodeDriver.use(
  {
    project: {
      git: true,
      files: { "README.md": "# Fixture\n" },
    },
    config: {
      autoupdate: false,
      username: "Drive",
    },
    tuiConfig: {
      theme: "system",
      scroll_speed: 1,
    },
    setup: ({ fs, config, tuiConfig }) =>
      Effect.gen(function* () {
        yield* fs.writeFile("src/setup.ts", "export const ready = true\n")
        config.username = "Setup wins"
        tuiConfig.scroll_speed = 2
      }),
  },
  ({ ui }) => ui.screenshot("home"),
)
```

The DSL is applied in this order:

1. `project.files` is written into the isolated project.
2. `config` and `tuiConfig` are deeply merged over `.opencode/opencode.jsonc` and `.opencode/tui.jsonc` fixture values. Objects merge recursively; arrays and scalar values replace existing values.
3. `setup` runs and may write project files or mutate the merged `config` and `tuiConfig` objects. Its mutations take final precedence.
4. Drive writes both configs as stable, formatted JSON. With `project.git: true`, it creates a repository and commits the complete pre-launch state with fixed Git identity and timestamps.

`fs.writeFile` is rooted inside the simulated project and creates parent directories. `project.git: true` refuses to replace existing Git metadata; omit it when prepared fixtures already include a repository.

### UI And LLM

UI operations are Effects:

- `ui.submit(text)` types and presses Enter.
- `ui.state()`, `ui.capture()`, and `ui.matches(text)` inspect the terminal.
- `ui.waitFor(textOrPredicate, options?)` polls until a match.
- `ui.getElement(query, options?)`, `ui.focus(...)`, and `ui.click(...)` target interactive elements.
- `ui.screenshot(name?)` exports an image and returns its absolute path.
- `ui.resize({ cols, rows })`, `ui.press(...)`, and `ui.arrow(...)` control the TUI.

Build deterministic simulated responses with the `Llm` namespace and schedule them through the driver's `llm` controller:

```ts
yield* llm.queue(
  Llm.reasoning("Checking the fixture"),
  Llm.pause(20),
  Llm.text("The value is 1.", { delay: 2, chunkSize: 15 }),
)
```

`llm.queue(...)` declares the next response without waiting. `llm.send(...)`
waits for the next request and completes its response. For ongoing responses,
the handler passed to `llm.serve` returns an Effect `Stream`; registering the
handler is an Effect. Available outputs include `text`, `reasoning`, `pause`,
`toolCall`, `raw`, `finish`, and `disconnect`; a normal response gets
`finish("stop")` when no terminal output is supplied.

```ts
import { Stream } from "effect"
import { Llm } from "opencode-drive"

yield* llm.serve((_request, index) =>
  Stream.make(Llm.text(`Response ${index + 1}`)),
)
```

Use the capability names literally: `opencode` is the generated OpenCode SDK,
`tui` is the primary frontend process, `ui` is `tui.ui`, and `tuis` launches
additional frontend processes.

Additional TUIs share the server and LLM controller:

```ts
const secondary = yield* tuis.launch({
  viewport: { cols: 120, rows: 40 },
  recording: true,
})
yield* secondary.ui.screenshot("secondary")
```

### Reports And Paths

`OpenCodeDriver` exports a branded `AbsolutePath` schema and a compact `RunReport` containing the artifact root, retention, recording paths, and endpoint compatibility. It also exports `decodeAbsolutePath` and `decodeRunReport` for validating unknown values.

`driver.settle()` returns the report with its recording paths. Use `OpenCodeDriver.useReport(options, run)` when a safe lifecycle program also needs the report alongside its result.

Drive prefers protocol negotiation and reports explicit legacy fallback. Set `opencode.compatibility` to `"required"` when protocol skew must fail before the program runs. Additional built-in tool adapters remain follow-ups.

### Simulated Shell Execution

Use `tools` to replace shell execution without changing the model-visible tool
schema. The handler receives typed input, a zero-based call index, and an Effect
progress function. Foreground handler Effects are interrupted when OpenCode
interrupts the session, the transport disconnects, or Drive shuts down; use
Effect finalizers for cancellation cleanup. Detached background shell handlers
continue after their launch response and are interrupted when Drive shuts down.
Unregistered tools remain real.

```ts
import { Effect } from "effect"
import { Tool } from "opencode-drive"

const tools = (registry: Tool.Registry) => {
  registry.handle("shell", ({ input, index, progress }) =>
    Effect.gen(function* () {
      yield* progress(`Running ${input.command}\n`)
      if (index === 0)
        return yield* new Tool.Failure({ message: "Controlled failure" })
      return { output: "Controlled success\n", exit: 0 }
    }),
  )
}

export default OpenCodeDriver.use({ tools }, (driver) => program(driver))
```

The same `tools` callback is accepted by `defineScript`. Supported adapters are
`shell`, `webfetch`, and `websearch`; unregistered tools remain real.
Each progress value replaces the visible tool output, so send accumulated text
when earlier lines should remain visible.

## Effect Scripts

Use `defineScript` with `start --script` when the workflow must have a stable
instance name, be visible, rerun on `restart`, or explicitly launch and kill
its server and TUIs. `setup` and `run` return Effects. Operations on `fs`,
`ui`, `llm`, `server`, and `tuis` also return Effects; there is no
Promise API or compatibility shim.

```ts
import { Effect } from "effect"
import { defineScript, Llm } from "opencode-drive"

export default defineScript({
  config: { autoupdate: false },
  tuiConfig: { theme: "system" },
  project: {
    git: true,
    files: { "src/value.ts": "export const value = 1\n" },
  },
  run: ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(Llm.text("The value is 1."))
      yield* ui.submit("Read src/value.ts")
      yield* ui.waitFor("The value is 1.")
    }),
})
```

Always type-check a script before starting it:

```bash
opencode-drive check ./drive.ts
opencode-drive start --name demo --script ./drive.ts
```

For a new script, run `opencode-drive script init ./drive.ts` once. It creates a
canonical Effect-native starter and refuses to overwrite an existing file.
`check` adds focused migration guidance when it finds Promise-style script
callbacks.

The script DSL applies `project`, `config`, `tuiConfig`, and `setup` with the same deterministic ordering described above. Automatic scripts run again after `opencode-drive restart --name demo`.

Use `launch: "manual"` only when the workflow must control server and TUI restarts itself. In manual mode `tui` and `ui` are `null`; run `server.launch()` before `tuis.launch(name)`. Only one server may run at a time, `server.kill()` permits relaunch, and a closed TUI name may be reused.

```ts
export default defineScript({
  launch: "manual",
  run: ({ server, tuis }) =>
    Effect.gen(function* () {
      yield* server.launch()
      const alice = yield* tuis.launch("alice", { recording: true })
      yield* alice.ui.screenshot("alice")
      yield* alice.close()
    }),
})
```

Cancellation uses Effect interruption. Interrupting the script or an
operation's fiber interrupts in-flight work and runs scoped finalizers; do not
introduce `AbortSignal` or Promise cancellation wrappers.

## Prepare An Instance

Use `init` only when files must be copied into an isolated home or project before a named live or scripted instance starts:

```bash
artifacts=$(opencode-drive init --name demo)
cp -R ./fixtures/home/. "$artifacts/"
cp -R ./fixtures/project/. "$artifacts/files/"
opencode-drive start --name demo --dev ~/projects/opencode
```

The simulated project is under `$artifacts/files`. A later `start --name demo` reuses the prepared artifacts; otherwise `start` initializes them automatically.

Drive uses an in-memory OpenCode database by default. For a script that restarts
the OpenCode service and must recover the same sessions, set
`OPENCODE_DRIVE_DB` to a file-backed path. Relative paths resolve inside the
isolated run's OpenCode data directory:

```bash
OPENCODE_DRIVE_DB=restart.sqlite \
  opencode-drive start --name restart-demo --script ./restart.ts
```

## Live Interaction

Use live commands to inspect or iterate on a persistent instance. Headless `start` requires a unique `--name`; visible instances may omit it. Headless `start` detaches after the instance is ready, so do not add `&`. Always stop the instance when finished.

```bash
opencode-drive start --name demo

opencode-drive send --name demo \
  --command.ui.type '{"text":"Explain this project"}' \
  --command.ui.enter

opencode-drive send --name demo --command.ui.state
opencode-drive send --name demo --command.ui.capture
opencode-drive send --name demo --command.ui.screenshot
opencode-drive stop --name demo
```

`send` executes command flags from left to right. JSON-valued commands take one JSON argument. Supported commands are:

- `--command.ui.type '{"text":"..."}'`
- `--command.ui.press '{"key":"p","modifiers":{"ctrl":true}}'`
- `--command.ui.enter`
- `--command.ui.arrow '{"direction":"down"}'`
- `--command.ui.focus '{"target":12}'`
- `--command.ui.click '{"target":12,"x":4,"y":1}'`
- `--command.ui.resize '{"cols":120,"rows":40}'`
- `--command.ui.screenshot` or `--command.ui.screenshot '{"name":"home"}'`
- `--command.ui.state`
- `--command.ui.capture`
- `--command.ui.matches '{"text":"OpenCode"}'`
- `--command.ui.recording.finish`

Start with `--record` to record a headless live instance. `stop` finishes the recording, exports the MP4, performs owner cleanup, and prints the path.

```bash
opencode-drive start --name demo --record
opencode-drive stop --name demo
```

`dir` prints a live instance's artifact directory, and `list` lists active instances:

```bash
opencode-drive dir --name demo
opencode-drive list
```

## Prune

`prune` removes inactive artifact directories. To remove one instance's artifacts, pass the instance name supplied to `init` or `start`, not the generated `run-*` artifact directory name:

```bash
opencode-drive prune --name demo

# Force removal of all artifact directories, including active ones.
opencode-drive prune --force
```

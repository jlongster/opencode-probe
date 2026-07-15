# opencode-drive

This project gives your agents control over OpenCode:

- Run it during development and let your agents see and poke at the running instance
- Allow your agents to run it in headless mode and drive it to test things

## Requirements

OpenCode Drive requires [Bun](https://bun.sh/) 1.3.14 or newer. MP4 recording export also requires `ffmpeg` on `PATH`.

Install dependencies with:

```sh
bun install
```

## Skill

```sh
npx skills add anomalyco/opencode-drive --agent opencode --skill opencode-drive
```

## Effect programs

The primary way to automate OpenCode is a default-exported, fully provided
Effect. Drive type-checks the module contract before importing it, validates the
export at runtime, and runs it in the CLI's Effect runtime:

```ts
// drive.ts
import { OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use({}, ({ ui }) =>
  ui.screenshot("home"),
)
```

```sh
opencode-drive run ./drive.ts
```

`run` accepts exactly one module path. It rejects `--command.*` flags, other
command flags, and application arguments after `--`. Backend and UI behavior
belongs in the Effect program.

`OpenCodeDriver.use` is the safe default. It owns the scope, observes backend
failure, settles queued LLM work, closes every client, and exports recordings
whether the program succeeds or fails:

```ts
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use(
  {
    project: {
      git: true,
      files: { "src/value.ts": "export const value = 1\n" },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(Llm.text("The value is 1."))
      yield* ui.submit("Read src/value.ts")
      yield* ui.waitFor("The value is 1.")
    }),
)
```

Additional clients share the same server and LLM controller:

```ts
import { Effect } from "effect"
import { OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use({}, (oc) =>
  Effect.gen(function* () {
    const secondary = yield* oc.clients.make({
      viewport: { cols: 120, rows: 40 },
    })
    yield* oc.ui.screenshot("primary")
    yield* secondary.ui.screenshot("secondary")
  }),
)
```

Enable recording per client. Settlement finishes each timeline and exports its
video automatically:

```ts
import { Effect } from "effect"
import { OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use(
  { client: { recording: true } },
  (oc) =>
    Effect.gen(function* () {
      yield* oc.ui.screenshot("recorded-home")
      yield* Effect.log(`recording will be exported to ${oc.recording?.path}`)
    }),
)
```

Settlement errors are program failures. For example, output after a terminal
LLM event fails the run while `use` still closes clients and attempts recording
export:

```ts
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use({}, ({ ui, llm }) =>
  Effect.gen(function* () {
    yield* llm.queue(Llm.finish(), Llm.text("too late"))
    yield* ui.submit("trigger a response")
  }),
)
```

Use `OpenCodeDriver.make` only when the program needs explicit terminal
settlement. It requires a scope, and `driver.settle()` must run before leaving
that scope:

```ts
import { Effect } from "effect"
import { OpenCodeDriver } from "opencode-drive"

export default Effect.scoped(
  Effect.gen(function* () {
    const driver = yield* OpenCodeDriver.make()
    yield* driver.ui.screenshot("home")
    yield* driver.settle()
  }),
)
```

Use `opencode-drive check ./legacy-script.ts` and `start --script` for the
Promise `defineScript` adapter described below.

## OpenCode development

Run this:

```sh
OPENCODE_DRIVE=1 bun run dev
```

If you installed the skill file, OpenCode will be able to see and interact with the running instance.

## Using with agents

Install the skill file above and ask the agent to test various flows with the app. Start with `--record` when you want a video; `opencode-drive stop` then exports the complete session and prints its path.

Screenshots and videos are written to `<system temp>/opencode-drive/output` with unique filenames. Set `OPENCODE_DRIVE_MEDIA_DIR` to use a different directory.

Captured frames use the official full Commit Mono v1.143 faces at 16px with a bundled Noto Sans Symbols 2 fallback in a fixed 10x20 cell grid. Set `OPENCODE_DRIVE_FONT` to a comma-separated list of font files (for example regular, bold, italic, and bold-italic faces) to use a different primary capture font without changing the symbol fallback or cell geometry.

## UI development

If you are doing UI development in OpenCode, you might want to run it in a simulated mode. This allows `opencode-drive` to drive it and always put it into a state that you want to see.

Run it in visible mode:

```sh
opencode-drive start --visible --dev ~/projects/opencode
```

Initialize first when you need to customize the isolated environment before OpenCode starts:

```sh
artifacts=$(opencode-drive init --name demo)
cp -R ./fixtures/home/. "$artifacts/"
cp -R ./fixtures/project/. "$artifacts/files/"
opencode-drive start --name demo --visible --dev ~/projects/opencode
```

`start` reuses the prepared artifacts for that name. If `init` was not run, `start` initializes them automatically.

Remove artifact directories left by sessions that are no longer active:

```sh
opencode-drive prune
```

Prune one inactive instance's artifacts by instance name, or force removal of all artifact directories:

```sh
opencode-drive prune --name demo
opencode-drive prune --force
```

While developing, you can run `opencode-drive restart` to restart only the UI (the server will persist as a separate process). Do this with agents, and they will always restart and get the UI where you want it to be automatically.

View the [skills file](https://github.com/anomalyco/opencode-drive/blob/main/skills/opencode-drive/SKILL.md) for more details about the CLI.

## Promise script API

Scripted runs use one fully typed definition:

```ts
import { defineScript } from "opencode-drive"

export default defineScript({
  config: {
    autoupdate: false,
  },
  tui: {
    theme: "system",
  },
  project: {
    git: true,
    files: {
      "src/example.ts": "export const value = 1\n",
    },
  },
  setup({ config, tui }) {
    config.username = "Drive"
    tui.scroll_speed = 1
  },
  async run({ ui, llm }) {
    await ui.submit("Read src/example.ts")
    await llm.send(llm.text("The value is 1."))
    await ui.waitFor("The value is 1.")
  },
})
```

`project.files` seeds the isolated project before `setup` runs. With
`project.git: true`, Drive creates a fresh repository and commits the complete
pre-launch state, including files written in `setup`. A prepared repository is
never replaced; omit `project.git` when an `init` step supplies Git history.
Declared `config` and `tui` values are deeply merged over fixture
`.opencode/opencode.jsonc` and `.opencode/tui.jsonc` files. Arrays replace
instead of merging, and mutations made in `setup` take final precedence.

Type-check every new or edited script before running it:

```sh
opencode-drive check ./drive.ts
```

Drive temporarily exposes its script API and `tsgo` beside the script while
checking, then removes only the links it created. `wait(milliseconds)` is
available for unconditional delays.

Set `launch: "manual"` to launch the shared OpenCode server and every TUI
explicitly:

```ts
import { defineScript } from "opencode-drive"

export default defineScript({
  launch: "manual",
  async run({ ui, server, clients }) {
    // ui is null in manual mode.
    await server.launch()
    const alice = await clients.launch("alice")
    const bob = await clients.launch("bob")
    await alice.submit("Hello from Alice")
    await bob.screenshot("bob-view")
  },
})
```

Only one server may be launched per script. All clients share its LLM backend. Client processes and temporary
script links are cleaned up when the script ends.

`await server.kill()` stops the server so it can be launched again later.
Every client handle also has `await ui.kill()` and its name may be reused after
the TUI exits.

Pass `{ record: true }` to record an individual client:

```ts
const ui = await clients.launch("alice", { record: true })
const video = await ui.kill()
```

`ui.kill()` exports the recording before terminating the TUI. Clients still
running when the script ends are recorded and terminated automatically.

Background title requests receive `OpenCode Drive` by default and do not
consume `llm.queue`, `llm.send`, or `llm.serve` responses. Manual-launch
scripts can customize them before starting the server:

```ts
llm.title((request) => "Custom title")
await server.launch()
```

Use `await llm.send(...)` to wait for and complete the next request,
`llm.queue(...)` to declare future responses upfront, or `llm.serve(async
function* () { ... })` for ongoing streamed responses. The backend connection,
default `finish("stop")`, cancellation, and cleanup are automatic. All public
script types are canonically defined in [`src/script/types.ts`](./src/script/types.ts),
which can be provided directly to an authoring agent.

`llm.text()` streams text in randomized chunks. It defaults to a 2 ms delay and
a target chunk size of 15 characters, varied by plus or minus 5 per chunk:

```ts
llm.text("A deliberately slower response", { delay: 20, chunkSize: 10 })
```

`llm.reasoning()` accepts the same streaming options. Use
`llm.pause(milliseconds)` to add timing between any two outputs.

`llm.toolCall()` emits a complete call atomically by default. Pass the same
streaming options to expose partial JSON input while it is generated:

```ts
llm.toolCall(
  {
    index: 0,
    id: "call_patch",
    name: "patch",
    input: { patchText: "*** Begin Patch\n*** End Patch" },
  },
  { delay: 40, chunkSize: 12 },
)
```

Finish a tool-calling response with `llm.finish("tool-calls")`. Streamed calls
drive OpenCode's normal tool-input start, delta, and end lifecycle; `llm.raw()`
remains available for provider-wire scenarios not covered by these helpers.

## Release validation

Version `0.5.0` is not ready to publish until the driver consolidation is complete. Before publishing a release, run the non-publishing validation command to check, test, and inspect the packed artifact:

```sh
bun run release:validate
```

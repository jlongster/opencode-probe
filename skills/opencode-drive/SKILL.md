---
name: opencode-drive
description: Use when an agent needs to debug and drive an OpenCode TUI instance
---

# OpenCode Drive

Use `opencode-drive` to launch an isolated OpenCode instance and control its TUI through WebSocket commands.

There are two modes:

- Live interaction: start a process, interact with it via the CLI, and take screenshots
- Scripted: start a process and run a script to completion and exit

If the user is wanting to lightly interact with the app with no custom backend behavior, use live interaction. This mode has some default backend interactions.

If the user is wanting to try to more deeply debug the app and try to reproduce something, use scripted. The scripts allow you to write any arbitrary backend interactions.

# Live interaction usage

- Always give headless instances a unique `--name`. Visible instances may omit it.
- A normal headless `start` detaches automatically and returns after the instance is ready.
- Do not add `&`; the long-running owner already runs in the background.
- Configure simulated model responses after startup when needed.
- Send ordered UI commands with `send`.
- Always stop the instance when finished.

```bash
opencode-drive start --name demo

opencode-drive send --name demo \
  --command.ui.type '{"text":"Explain this project"}' \
  --command.ui.enter

opencode-drive stop --name demo
```

## Prepare The Environment

Use `init` when files must be added to the isolated home or project before OpenCode starts. It prints the artifact directory without launching OpenCode. A later `start` with the same name reuses it.

```bash
artifacts=$(opencode-drive init --name demo)
cp -R ./fixtures/home/. "$artifacts/"
cp -R ./fixtures/project/. "$artifacts/files/"
opencode-drive start --name demo --dev ~/projects/opencode
```

The simulated project is under `$artifacts/files`. Running `start` without a prior `init` initializes the artifacts automatically.

## Send UI Commands

- Every `send` opens a connection to the named instance, runs its commands in order, and exits.
- Combine typing and Enter in one command when submitting a prompt.
- JSON-valued commands require one JSON argument.
- Multiple command flags execute from left to right.

Commands:

- `--command.ui.type <json>` types into the focused editor. Arguments: `text` string.
- `--command.ui.press <json>` presses a key. Arguments: `key` string; optional `modifiers` object with boolean `ctrl`, `shift`, `meta`, `super`, or `hyper`.
- `--command.ui.enter` presses Enter. Arguments: none.
- `--command.ui.arrow <json>` presses an arrow key. Arguments: `direction` is `up`, `down`, `left`, or `right`.
- `--command.ui.focus <json>` focuses an element. Arguments: `target` is the numeric element `num` returned by `ui.state`.
- `--command.ui.click <json>` clicks an element. Arguments: numeric `target`, `x`, and `y`; use the element `num` returned by `ui.state` as `target`.
- `--command.ui.state` prints focus and interactive element metadata as JSON. Arguments: none.
- `--command.ui.matches <json>` prints whether literal, case-sensitive text appears on screen. Arguments: `text` string.

```bash
opencode-drive send --name demo \
  --command.ui.type '{"text":"Find the relevant code and explain it"}' \
  --command.ui.enter

opencode-drive send --name demo \
  --command.ui.press '{"key":"p","modifiers":{"ctrl":true}}'

opencode-drive send --name demo \
  --command.ui.arrow '{"direction":"down"}'

opencode-drive send --name demo \
  --command.ui.focus '{"target":12}'

opencode-drive send --name demo \
  --command.ui.click '{"target":12,"x":4,"y":1}'

opencode-drive send --name demo \
  --command.ui.matches '{"text":"OpenCode"}'
```

To read the UI state and see information about interactable elements, use the `ui.state` command:

```bash
opencode-drive send --name demo --command.ui.state
```

## Inspect The UI

- `ui.state` prints focus and interactive element metadata as JSON.
- `ui.matches` checks for literal, case-sensitive screen text.
- `screenshot` prints the generated image path.

```bash
opencode-drive screenshot --name demo
```

## Record The UI

- Start with `--record` to capture a headless instance from its first rendered frame.
- `stop` finishes the recording, exports an MP4, and prints its path.

```bash
opencode-drive start --name demo --record

opencode-drive send --name demo \
  --command.ui.type '{"text":"Show me the current architecture"}' \
  --command.ui.enter

opencode-drive stop --name demo
```

## Configure LLM Responses

- `responses` controls what the LLM responds with
- Only use this if you are wanting to reproduce an exact type of response
- Defaults are `text,reasoning,diff,tool` with `write,apply_patch`.
- Supported types are `text`, `reasoning`, `diff`, and `tool`.
- `--tools` limits generated tool calls to names offered by OpenCode.

```bash
opencode-drive responses --name demo \
  --types text,reasoning,diff,tool \
  --tools write,apply_patch

opencode-drive responses --name demo \
  --types tool \
  --tools read,glob,grep
```

## Logs

- `logs` prints the OpenCode log file for the instance

```bash
opencode-drive logs --name demo
```

## Lifecycle

- `stop` waits for recording export and owner cleanup before returning.
- `prune` removes artifact directories for sessions that are no longer active.

```bash
opencode-drive stop --name demo
opencode-drive prune
```

# Scripted usage

Write a script and pass it with `--script`:

```bash
opencode-drive start --name auto-stop-reproduction --script ./reproduce-stale-exploring-empty.ts
```

After creating or editing a script, always type-check it before starting:

```bash
opencode-drive check ./reproduce-stale-exploring-empty.ts
```

Do not skip this step.

Scripts use one typed definition object. `setup` runs before OpenCode starts,
and `fs.writeFile` always writes inside the simulated project:

```ts
import { defineScript } from "opencode-drive"

export default defineScript({
  async setup({ fs, config }) {
    config.autoupdate = false
    await fs.writeFile("src/example.ts", "export const value = 1\n")
  },

  async run({ ui, llm }) {
    await ui.submit("Open src/example.ts")
    await llm.send(llm.text("The file exports `value`."))
    await ui.waitFor("The file exports `value`.")
  },
})
```

`setup` receives the current OpenCode config object, which starts from the
default drive config unless the prepared instance already has one. When a script
needs custom config, mutate this `config` parameter instead of generating and
writing a new config object from scratch, so the script keeps the default
provider/model settings unless it intentionally changes them.

Note that the simulated model is a GPT model type, and opencode uses the `patch` tool for working with files Do not use a `edit` or `write` tool to edit files.

Use `launch: "manual"` when the script needs to launch the server and every TUI
itself (this is extremely rare, do not use this unless explicitly asked). In this
mode `ui` is typed as `null`; call `server.launch()` exactly
once before launching clients. Each `clients.launch(name)` result provides the
same UI methods as the automatic client:

```ts
import { defineScript } from "opencode-drive"

export default defineScript({
  launch: "manual",
  async run({ ui, server, clients }) {
    await server.launch()
    const first = await clients.launch("first")
    const second = await clients.launch("second")
    await first.submit("Create a session")
    await second.screenshot("second-client")
  },
})
```

Use the exported `wait(milliseconds)` utility for an unconditional delay.
Use `await server.kill()` to stop and later relaunch the shared server. Use
`await ui.kill()` to terminate an individual client; its name can then be
passed to `clients.launch()` again.
Pass `{ record: true }` to `clients.launch(name, options)` to record that
client. `ui.kill()` exports and returns its video path before terminating it;
active recorded clients are exported automatically when the script ends.
Background title requests are answered automatically and do not consume normal
LLM responses. In manual-launch scripts, call `llm.title(handler)` before
`server.launch()` to customize title generation.

`await llm.send(...)` waits for the next request and resolves after OpenCode
acknowledges its complete response. `llm.queue(...)` declares responses in
advance. Chunks may be built with `text`, `reasoning`, `toolCall`, `raw`,
`finish`, and `disconnect`. A normal response receives `finish("stop")`
automatically unless it yields or queues an explicit terminal event.
`llm.text(text, { delay, chunkSize })` defaults to a 2 ms delay and a
15-character target varied by plus or minus 5 per chunk.
`llm.reasoning` accepts the same options, and `llm.pause(milliseconds)` adds a
delay between any two outputs.

Use `llm.serve` for an ongoing typed response generator:

```ts
llm.serve(async function* (request, index) {
  yield llm.reasoning(`Handling request ${index + 1}`)
  yield llm.text(`Received ${request.id}`)
  yield llm.finish("stop")
})
```

The backend connection, response cleanup, cancellation, and recording
completion are automatic. The complete authoring contract is in
`src/script/types.ts`.

You can see some example scripts here:

- https://raw.githubusercontent.com/jlongster/opencode-drive/refs/heads/main/examples/simple.ts
- https://raw.githubusercontent.com/jlongster/opencode-drive/refs/heads/main/examples/serve.ts

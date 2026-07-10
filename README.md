# opencode-drive

This project gives your agents control over OpenCode:

- Run it during development and let your agents see and poke at the running instance
- Allow your agents to run it in headless mode and drive it to test things

## Skill

```sh
npx skills add jlongster/opencode-drive --agent opencode --skill opencode-drive
```

## OpenCode development

Run this:

```sh
OPENCODE_DRIVE=1 bun run dev
```

If you installed the skill file, OpenCode will be able to see and interact with the running instance.

## Using with agents

Install the skill file above and ask the agent to test various flows with the app. Start with `--record` when you want a video; `opencode-drive stop` then exports the complete session and prints its path.

Screenshots and videos are written to `<system temp>/opencode-drive/output` with unique filenames. Set `OPENCODE_DRIVE_MEDIA_DIR` to use a different directory.

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

While developing, you can run `opencode-drive restart` to restart only the UI (the server will persist as a separate process). Do this with agents, and they will always restart and get the UI where you want it to be automatically.

View the [skills file](https://github.com/jlongster/opencode-drive/blob/main/skills/opencode-drive/SKILL.md) for more details about the CLI.

## Script API

Scripted runs use one fully typed definition:

```ts
import { defineScript } from "opencode-drive"

export default defineScript({
  async setup({ fs, config }) {
    config.autoupdate = false
    await fs.writeFile("src/example.ts", "export const value = 1\n")
  },
  async run({ ui, llm }) {
    await ui.submit("Read src/example.ts")
    await llm.send(llm.text("The value is 1."))
    await ui.waitFor("The value is 1.")
  },
})
```

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

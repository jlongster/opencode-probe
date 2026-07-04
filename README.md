# opencode-probe

Model-based and deterministic simulation drivers for the local opencode V2 TUI
and server. The probe controls the real application through simulation-only
WebSocket interfaces while external model and filesystem state remain isolated.

The opencode checkout is expected at `~/projects/opencode-latest`.

## Setup

```bash
cd ~/projects/opencode-probe
bun install
bun run check
```

## Stale Running Reproduction

The reproduction pauses the TUI's real SSE event subscription while the real
backend finishes a provider turn. It then resumes the existing reconnect loop.
The backend reports no active session, but the TUI retains its stale `running`
status.

Run the focused data-layer regression:

```bash
cd ~/projects/opencode-probe
bun run reproduce:stale-running
```

Expected output includes:

```text
Expected: "idle"
Received: "running"

REPRODUCED: reconnect left an inactive session stuck in the running UI state.
```

Run the same sequence through the real visible opencode TUI:

```bash
cd ~/projects/opencode-probe
bun run reproduce:stale-running:visible
```

The final stale-running screen remains visible for ten seconds. Change the hold
duration with:

```bash
cd ~/projects/opencode-probe
OPENCODE_PROBE_HOLD_MS=30000 bun run reproduce:stale-running:visible
```

Relevant files:

- `src/stale-running-driver.ts`: pause, settle, reconnect, and assertion logic.
- `src/reproduce-stale-running-visible.ts`: isolated state and visible launcher.
- `src/reproduce-stale-running.ts`: focused failing-test wrapper.
- `packages/tui/test/cli/tui/data.test.tsx` in opencode: focused regression.

Artifacts are written to `/tmp/opencode-probe-stale-running-visible`.

## Hello Driver

`src/hello-driver.ts` submits `Say hello`, answers every model request with
exactly `hello`, and holds the visible screen for ten seconds.

First run the visible stale reproduction once to create its isolated state, or
prepare equivalent state using the section below. Then run:

```bash
cd ~/projects/opencode-probe && ./bin/opencode-sim \
  --state /tmp/opencode-probe-stale-running-visible/state \
  --anchor /tmp/opencode-probe-hello \
  --renderer visible \
  --driver 'bun /root/projects/opencode-probe/src/hello-driver.ts' \
  -- \
  bun run --conditions=browser --preload=@opentui/solid/preload \
  /root/projects/opencode-latest/packages/cli/src/index.ts \
  --standalone
```

## Generated Campaigns

Run ten deterministic flows with isolated state and a fake renderer:

```bash
cd ~/projects/opencode-probe
bun run campaign --count 10 --seed 42000 --turns 14 --chunk-delay 10
```

Watch the same generated flows in the real terminal renderer:

```bash
cd ~/projects/opencode-probe
bun run campaign \
  --count 10 \
  --seed 42000 \
  --turns 14 \
  --renderer visible \
  --chunk-delay 30 \
  --out /tmp/opencode-probe-visible
```

Campaign options:

- `--count`: number of isolated opencode instances to run.
- `--seed`: first deterministic scenario seed; subsequent cases increment it.
- `--turns`: user turns per scenario.
- `--renderer fake|visible`: headless or real terminal rendering.
- `--chunk-delay`: milliseconds between provider chunks.
- `--step-delay`: optional milliseconds between completed turns.
- `--out`: campaign artifact directory.

The generator covers:

- Plain, chunked, reasoning, Markdown, and raw OpenAI Chat events.
- Empty choices, null content, usage, fragmented tool input, and finish reasons.
- Silent transport disconnects and invalid provider events at several phases.
- Duplicate submission, steering during streaming, and interruption.
- Permission prompts and question answers through the real TUI.
- Nested subagent model exchanges.
- All built-in tools: `read`, `glob`, `grep`, `todowrite`, `shell`, `write`,
  `edit`, `apply_patch`, `webfetch`, `websearch`, `skill`, `subagent`, and
  `question`.

Each flow directory contains `scenario.json`, isolated state, `driver.log`,
`simulation.log`, and `result.json`. Failures additionally write
`result.json.failure.json` with the final screen and pending exchanges.
`summary.json` contains aggregate semantic coverage.

Replay one generated case by rerunning its seed with `--count 1`:

```bash
bun run campaign --count 1 --seed 43402 --turns 14 --chunk-delay 10
```

## Properties

Properties live in `src/flows/properties.ts` and are declared with
`defineProperty(...)`.

Available hooks:

- `afterSubmit`: assert behavior after a prompt is submitted.
- `afterTerminal`: assert behavior after completion, interruption, or provider
  failure.

Built-in properties check that ordinary submissions visibly run, every turn
reaches a terminal outcome with no provider exchange left, and terminal turns
do not leave the TUI in its running state.

Example:

```ts
defineProperty({
  name: "terminal-turn-clears-running",
  afterTerminal: (context) =>
    context.waitFor("terminal turn to stop showing running", async () =>
      !isRunning(await context.ui.render()),
    ),
})
```

## Writing Drivers

Drivers connect to two control surfaces:

- Frontend: inspect rendering, execute user actions, export traces, and control
  the TUI event subscription.
- Backend: observe model requests, stream model chunks, finish or disconnect
  provider bodies, and inspect pending exchanges.

Minimal model handler:

```ts
import { connectBackendSimulation } from "./client/index.js"

const backend = await connectBackendSimulation({
  url: process.env.OPENCODE_SIMULATION_BACKEND_WS,
})

await backend.attach(async (request) => {
  await backend.chunk(request.id, [{ type: "textDelta", text: "hello" }])
  await backend.finish(request.id, "stop")
})
```

Frontend event-stream controls:

```ts
await ui.eventPause()
await ui.eventResume()
const state = await ui.eventState()
```

`event.pause` aborts the current production SSE subscription and blocks its
normal reconnect loop. `event.resume` releases that loop. It does not replace
or emulate the event stream.

Backend provider controls:

```ts
await backend.chunk(exchangeID, items)
await backend.finish(exchangeID, "stop")
await backend.disconnect(exchangeID)
```

`disconnect` abruptly ends the provider body without a finish chunk or SSE
sentinel.

## Prepare State Manually

```bash
STATE=/tmp/opencode-sim-state
rm -rf "$STATE"
mkdir -p "$STATE/project/.config/opencode" "$STATE/project/src"

cat > "$STATE/project/opencode.json" <<'JSON'
{
  "model": "simulation/sim-model",
  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],
  "providers": {
    "simulation": {
      "name": "Simulation",
      "request": { "body": { "apiKey": "sim-key" } },
      "models": {
        "sim-model": {
          "name": "Simulated Model",
          "api": {
            "type": "aisdk",
            "package": "@ai-sdk/openai-compatible",
            "url": "https://api.openai.com/v1"
          },
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16000 }
        }
      }
    }
  }
}
JSON

cp "$STATE/project/opencode.json" "$STATE/project/.config/opencode/opencode.json"
printf 'export const example = true\n' > "$STATE/project/src/example.ts"
```

## Wrapper

`bin/opencode-sim` creates isolated opencode paths, chooses frontend and backend
control ports, starts the driver, and cleans up both processes.

```bash
cd ~/projects/opencode-probe && ./bin/opencode-sim \
  --state /tmp/opencode-sim-state \
  --anchor /tmp/opencode-sim-anchor \
  --renderer visible \
  --driver 'bun /root/projects/opencode-probe/src/hello-driver.ts' \
  -- \
  bun run --conditions=browser --preload=@opentui/solid/preload \
  /root/projects/opencode-latest/packages/cli/src/index.ts \
  --standalone
```

Useful environment variables:

- `OPENCODE_PROBE_HOLD_MS`: visible-driver hold duration.
- `OPENCODE_SIMULATION_LOG`: combined simulation diagnostics path.
- `OPENCODE_SIMULATION_DRIVER_LOG`: driver stdout and stderr path.
- `OPENCODE_SIMULATION_UI_WS`: assigned frontend control URL.
- `OPENCODE_SIMULATION_BACKEND_WS`: assigned backend control URL.

Default logs:

```bash
tail -f /tmp/opencode-simulation.log
cat /tmp/opencode-simulation-driver.log
```

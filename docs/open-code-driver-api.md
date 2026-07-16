# OpenCode Driver API

Status: exploratory implementation, settled call sites only

This document records interface shapes that have been accepted during design. It intentionally omits unresolved alternatives rather than presenting them as competing proposals.

Internal resource ownership and desugaring are documented in [OpenCode Driver Architecture](./open-code-driver-architecture.md).

## Run Effect programs from the CLI

`opencode-drive run <module>` is the primary CLI entrypoint. The module must
default-export an `Effect<_, _, never>`. Before importing the module, Drive
generates and type-checks a contract entrypoint that assigns its default export
to that fully provided Effect type. Drive then imports the module, verifies the
value with `Effect.isEffect`, and yields it directly from the command handler.
There is no nested runtime or detached owner.

```ts
import { OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use({}, ({ ui }) => ui.screenshot("home"))
```

```sh
opencode-drive run ./drive.ts
```

The command accepts no flags and no arguments after `--`. Use the driver API in
the module for simulation control. `opencode-drive check` validates Effect-only
`defineScript` modules, and `start --script` executes them.

## `use` settles one scoped driver

`OpenCodeDriver.use(options, run)` is the safe top-level interface. It acquires the same driver returned by `make`, runs the program, validates queued LLM work, finishes recordings, closes clients, exports videos, and then releases the server and project scope.

`OpenCodeDriver.useReport(options, run)` has the same lifecycle semantics and
returns both the user value and a compact `RunReport`. The report contains
validated artifact and recording paths, retention, and endpoint compatibility.
Set `opencode.compatibility` to `"required"` or `"preferred"`;
the default is `"preferred"`, which negotiates when supported and reports an
explicit legacy profile otherwise.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

const program = OpenCodeDriver.use(
  {
    project: {
      git: true,
      files: {
        "src/example.ts": "export const value = 1\n",
      },
    },
    config: {
      autoupdate: false,
    },
    client: {
      viewport: {
        cols: 96,
        rows: 32,
      },
      recording: false,
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(
        Llm.text("The value is 1."),
      )

      yield* ui.submit("Read src/example.ts")
      yield* ui.waitFor("The value is 1.")
    }),
)

NodeRuntime.runMain(program)
```

`OpenCodeDriver.make(...)` remains the lower-level scoped constructor for programs that need to control settlement explicitly. Call `driver.settle()` before leaving its scope. `settle()` is terminal: it rejects new clients and LLM responses, validates queued work, stops clients, and exports recordings.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const driver = yield* OpenCodeDriver.make(options)
    yield* driver.ui.submit("Hello")
    yield* driver.settle()
  }),
)
```

Capture font size is not part of this interface. The current renderer uses a fixed 16px font in 10-by-20 cells; the terminal catalog's `OPENCODE_DRIVE_FONT_SIZE=14` environment variable is currently ignored.

## The driver has one primary client and optional additional clients

The `client` section configures the primary frontend created by `make`. Its UI is exposed directly as `ui` for the common case.

Additional clients connect to the same server and expose their own UI:

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const oc = yield* OpenCodeDriver.make({
      client: {
        viewport: {
          cols: 96,
          rows: 32,
        },
      },
    })

    const secondary = yield* oc.clients.make({
      viewport: {
        cols: 120,
        rows: 40,
      },
      recording: true,
    })

    yield* oc.ui.submit("Prompt from the primary client")
    yield* secondary.ui.submit("Prompt from the secondary client")
    yield* oc.settle()
  }),
)
```

Client identity is generated internally. Callers do not supply names or labels because those values currently affect only process maps, logs, and filenames.

```text
                     ╭────────────────╮
                     │ OpenCodeDriver ├───────────────────────╮
                     ╰────────┬───────╯                       │
             ╭────────────────╰──────────────────╮            │
             ▼                                   ▼            │
╭────────────────────────╮            ╭────────────────────╮  │
│ Shared OpenCode Server │            │ Shared LLM Control │  │
╰────────────┬───────────╯            ╰────────────────────╯  │
             ╰───────────────────────────────╮                │
             ▼                               ▼                │
    ╭────────────────╮            ╭────────────────────╮      │
    │ Primary Client │◀───────────│ Additional Clients │◀─────╯
    ╰────────┬───────╯            ╰──────────┬─────────╯
             ╰───╮                    ╭──────╯
                 ▼                    ▼
              ╭────╮            ╭───────────╮
              │ ui │            │ client.ui │
              ╰────╯            ╰───────────╯
```

## Common scripts destructure UI and LLM control

Scripts that only need the primary client should normally destructure the driver:

```ts
const driver = yield* OpenCodeDriver.make()
const { ui, llm } = driver

yield* llm.queue(
  Llm.text("Hello from the simulated model."),
)

yield* ui.submit("Hello")
yield* ui.waitFor("Hello from the simulated model.")
yield* driver.settle()
```

Keep the aggregate value only when driver-wide capabilities such as `clients` are needed:

```ts
const oc = yield* OpenCodeDriver.make()
const secondary = yield* oc.clients.make()

yield* oc.ui.screenshot("primary")
yield* secondary.ui.screenshot("secondary")
yield* oc.settle()
```

## LLM response description is separate from live LLM control

`Llm` is a pure data module. `llm` is the live capability that queues, sends, and serves responses.

```ts
yield* llm.queue(
  Llm.reasoning("Inspecting the file"),
  Llm.pause(20),
  Llm.text("The value is 1.", {
    delay: 2,
    chunkSize: 15,
  }),
  Llm.finish("stop"),
)
```

Each constructor returns an ordinary serializable value. Raw values with the same schema remain accepted.

Tool calls remain atomic when options are omitted. Supplying stream options
serializes the input to JSON and emits it incrementally through the simulated
provider, producing OpenCode's normal tool-input lifecycle:

```ts
Llm.toolCall(
  {
    index: 0,
    id: "call_patch",
    name: "patch",
    input: { patchText: "*** Begin Patch\n*** End Patch" },
  },
  { delay: 40, chunkSize: 12 },
)
```

The authoritative schema is a manual union of independently named variants:

```ts
export const Text = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  options: Schema.optionalKey(StreamOptions),
})
export interface Text extends Schema.Schema.Type<typeof Text> {}

export const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  options: Schema.optionalKey(StreamOptions),
})
export interface Reasoning extends Schema.Schema.Type<typeof Reasoning> {}

export const Pause = Schema.Struct({
  type: Schema.Literal("pause"),
  milliseconds: NonNegativeMilliseconds,
})
export interface Pause extends Schema.Schema.Type<typeof Pause> {}

export const Finish = Schema.Struct({
  type: Schema.Literal("finish"),
  reason: Schema.optionalKey(FinishReason),
})
export interface Finish extends Schema.Schema.Type<typeof Finish> {}

export const Output = Schema.Union([
  Text,
  Reasoning,
  Pause,
  Finish,
  ToolCall,
  Raw,
  Disconnect,
])
export type Output = Schema.Schema.Type<typeof Output>
```

Pure constructors delegate to those individual schemas:

```ts
export const text = (
  text: string,
  options?: StreamOptions,
): Text =>
  Text.make({
    type: "text",
    text,
    ...(options ? { options } : {}),
  })
```

No `.cases` interface appears in userland.

## One `queue` call describes one future model response

Multiple outputs in one call are ordered events within one response:

```ts
yield* llm.queue(
  Llm.toolCall({
    index: 0,
    id: "call_permission_capture",
    name: "patch",
    input: {
      patchText,
    },
  }),
  Llm.finish("tool-calls"),
)
```

A second call queues a response for the next model request:

```ts
yield* llm.queue(
  Llm.text("The fixture was updated."),
)
```

Responses without an explicit terminal output finish with `"stop"`. Title requests remain separate and do not consume this queue.

## `defineScript` is Effect-only

`defineScript` does not provide a Promise adapter. Its `setup` and `run`
callbacks return Effects, as do operations on `fs`, `ui`, `llm`, `server`,
and `clients`. Compose script operations in the same runtime with
`yield*` or Effect operators.

### Primary UI

```ts
import { Effect } from "effect"
import { defineScript } from "opencode-drive"

export default defineScript({
  run: ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(llm.text("The value is 1."))
      yield* ui.submit("Read src/example.ts")
      yield* ui.waitFor("The value is 1.")
    }),
})
```

`llm.serve` accepts a handler that returns an Effect `Stream`. The registration
itself is also an Effect:

```ts
import { Stream } from "effect"

yield* llm.serve((_request, index) =>
  Stream.make(llm.text(`Response ${index + 1}`)),
)
```

Predicates passed to `ui.waitFor` may return a boolean or an Effect.

### Additional client

```ts
yield* server.launch()
const alice = yield* clients.launch("alice")
const bob = yield* clients.launch("bob")

yield* alice.submit("Hello from Alice")
yield* bob.screenshot("bob-view")
```

### Client configuration

```ts
export default defineScript({
  viewport: {
    cols: 118,
    rows: 34,
  },
  run: ({ ui }) => ui.screenshot("home").pipe(Effect.asVoid),
})
```

Script cancellation uses Effect interruption. Interrupting the script or an
operation's fiber interrupts in-flight work and runs its scoped finalizers;
there is no `AbortSignal`, Promise cancellation convention, or compatibility
shim.

## Settled interface

- The API is Effect-native.
- `defineScript` accepts only Effect-returning `setup` and `run` callbacks.
- Script capability methods return Effects; `llm.serve` handlers return Streams.
- Cancellation uses Effect interruption, without a Promise compatibility shim.
- `OpenCodeDriver.use(options, run)` is the safe top-level bracket and performs typed settlement.
- `OpenCodeDriver.make(options)` is the primary scoped constructor.
- Programs that call `make` directly call terminal `driver.settle()` before leaving the scope.
- Direct library programs run the same Effect without any export convention.
- The `client` section configures one primary client.
- The primary client's UI is exposed as `ui` and `oc.ui`.
- The common case destructures `{ ui, llm }`.
- `oc.clients.make(options?)` creates additional clients on the same server.
- Additional clients expose their UI as `client.ui`.
- Client identity is generated internally rather than supplied by callers.
- `Llm` exposes pure constructors over manually composed Effect Schemas.
- Raw schema-compatible LLM output objects remain accepted.
- One `llm.queue(...)` call describes one future model response.

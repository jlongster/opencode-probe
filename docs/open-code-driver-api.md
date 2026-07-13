# OpenCode Driver API

Status: exploratory implementation, settled call sites only

This document records interface shapes that have been accepted during design. It intentionally omits unresolved alternatives rather than presenting them as competing proposals.

Internal resource ownership and desugaring are documented in [OpenCode Driver Architecture](./open-code-driver-architecture.md).

## `make` constructs one scoped driver

The primary interface is an ordinary Effect library constructor. It does not require `defineScript`, a default export, dynamic script loading, or Layer construction.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

const program = Effect.scoped(
  Effect.gen(function* () {
    const { ui, llm } = yield* OpenCodeDriver.make({
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
    })

    yield* llm.queue(
      Llm.text("The value is 1."),
    )

    yield* ui.submit("Read src/example.ts")
    yield* ui.waitFor("The value is 1.")
  }),
)

NodeRuntime.runMain(program)
```

`OpenCodeDriver.make(...)` acquires the project, shared OpenCode server, primary frontend client, UI control connection, and shared LLM control. The enclosing Effect scope releases them.

Capture font size is not part of this interface. The current renderer uses a fixed 16px font in 10-by-20 cells; the terminal catalog's `OPENCODE_DRIVE_FONT_SIZE=14` environment variable is currently ignored.

## A Drive script is a default-exported Effect

Ordinary library programs run the Effect directly with their chosen runtime. A file consumed by the Drive CLI default-exports the same fully configured program:

```ts
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

const program = Effect.scoped(
  Effect.gen(function* () {
    const { ui, llm } = yield* OpenCodeDriver.make({
      project: {
        files: {
          "src/example.ts": "export const value = 1\n",
        },
      },
      client: {
        viewport: {
          cols: 96,
          rows: 32,
        },
      },
    })

    yield* llm.queue(
      Llm.text("The value is 1."),
    )

    yield* ui.submit("Read src/example.ts")
    yield* ui.waitFor("The value is 1.")
  }),
)

export default program
```

```shell
opencode-drive run ./capture.ts
```

The runner dynamically imports the module, verifies the default export with `Effect.isEffect`, runs it through the Drive runtime, and maps failure to the process exit status. The program contains its own project, client, and launch configuration; there are no named metadata exports.

The same file can instead execute itself as an ordinary library program:

```ts
NodeRuntime.runMain(program)
```

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
const { ui, llm } = yield* OpenCodeDriver.make()

yield* llm.queue(
  Llm.text("Hello from the simulated model."),
)

yield* ui.submit("Hello")
yield* ui.waitFor("Hello from the simulated model.")
```

Keep the aggregate value only when driver-wide capabilities such as `clients` are needed:

```ts
const oc = yield* OpenCodeDriver.make()
const secondary = yield* oc.clients.make()

yield* oc.ui.screenshot("primary")
yield* secondary.ui.screenshot("secondary")
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

## Current and Effect call sites map directly

### Primary UI

Current:

```ts
export default defineScript({
  async run({ ui, llm }) {
    llm.queue(llm.text("The value is 1."))
    await ui.submit("Read src/example.ts")
    await ui.waitFor("The value is 1.")
  },
})
```

Effect:

```ts
const { ui, llm } = yield* OpenCodeDriver.make()

yield* llm.queue(
  Llm.text("The value is 1."),
)
yield* ui.submit("Read src/example.ts")
yield* ui.waitFor("The value is 1.")
```

### Additional client

Current:

```ts
await server.launch()
const alice = await clients.launch("alice")
const bob = await clients.launch("bob")

await alice.submit("Hello from Alice")
await bob.screenshot("bob-view")
```

Effect:

```ts
const oc = yield* OpenCodeDriver.make()
const secondary = yield* oc.clients.make()

yield* oc.ui.submit("Hello from the primary client")
yield* secondary.ui.screenshot("secondary-view")
```

### Client configuration

Current:

```ts
export default defineScript({
  viewport: {
    cols: 118,
    rows: 34,
  },
  async run({ ui }) {
    await ui.screenshot("home")
  },
})
```

Effect:

```ts
const { ui } = yield* OpenCodeDriver.make({
  client: {
    viewport: {
      cols: 118,
      rows: 34,
    },
  },
})

yield* ui.screenshot("home")
```

## Settled interface

- The API is Effect-native.
- `OpenCodeDriver.make(options)` is the primary scoped constructor.
- A CLI-loaded Drive script default-exports one fully configured Effect program.
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

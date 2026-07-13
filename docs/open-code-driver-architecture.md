# OpenCode Driver Architecture

Status: architecture guide for the Effect migration

This document explains how the settled userland API desugars into scoped resources and internal adapters. The public API remains in [OpenCode Driver API](./open-code-driver-api.md).

## The driver composes a project, server, and clients

`OpenCodeDriver.make(...)` creates one isolated project, one shared OpenCode server, one primary client, and the connections needed to drive them. The project does not own or expose RPC endpoints.

```text
                  ╭─────────────────────╮
                  │ OpenCodeDriver.make │
                  ╰──────────┬──────────╯
            ╭────────────────╰─────────────────╮
            ▼                                  ▼
╭──────────────────────╮            ╭─────────────────────╮
│ OpenCodeProject.make │            │ OpenCodeServer.make │
╰──────────────────────╯            ╰──────────┬──────────╯
              ╭───────────────────────────────┬╯
              ▼                               ▼
   ╭────────────────────╮            ╭────────────────╮
   │ Shared LLM Control │            │ server.clients │
   ╰────────────────────╯            ╰────────┬───────╯
            ╭─────────────────────────────────╰╮
            ▼                                  ▼
 ╭─────────────────────╮            ╭────────────────────╮
 │ OpenCodeClient.make │            │ Additional Clients │
 ╰──────────┬──────────╯            ╰──────────┬─────────╯
            ╰────╮                        ╭────╯
                 ▼                        ▼
          ╭────────────╮            ╭───────────╮
          │ Primary UI │            │ client.ui │
          ╰────────────╯            ╰───────────╯
```

The domain relationships are:

- An `OpenCodeProject` is the isolated workspace directory and its configuration.
- An `OpenCodeServer` is one scoped server process with shared LLM control.
- An `OpenCodeClient` is one scoped frontend process connected to that server.
- A client owns one UI control connection and an optional recording.
- The server owns the factory used to make connected clients.

## The project is only the workspace

The current artifact directory contains several concepts that should not be conflated:

```text
run-034689/
|-- files/              # OpenCodeProject workspace
|   |-- .git/
|   |-- .opencode/
|   `-- src/
|-- drive/              # Internal launch descriptors
|   |-- service.json
|   `-- client-*.json
|-- home/               # Isolated process home and XDG state
`-- logs/               # Server and client process logs
```

`OpenCodeProject.make(...)` owns `files/`. It creates the directory, writes fixture files and configuration, applies setup, and optionally creates a Git baseline.

The files under `drive/` are internal launch descriptors. They tell a spawned OpenCode process which UI and backend endpoints, viewport, and recording timeline to use. They are transport wiring, not part of the project model.

The endpoint owners are:

- `OpenCodeServer` owns the backend simulation endpoint.
- Each `OpenCodeClient` owns one UI simulation endpoint.

## Domain constructors use `make`

Scoped domain resources consistently use `make`:

```ts
OpenCodeDriver.make(options)
OpenCodeProject.make(options)
OpenCodeServer.make(options)
OpenCodeClient.make(options)
server.clients.make(options)
```

Infrastructure keeps the verb that describes its operation:

```ts
processSpawner.spawn(command)
simulationConnector.backend(endpoint)
simulationConnector.ui(endpoint)
```

`make` means "acquire this domain resource and return it ready to use." `spawn` and endpoint connection remain hidden implementation operations.

## `OpenCodeDriver.make` is shallow orchestration over deep modules

The high-level constructor should read as a domain recipe:

```ts
export const make = Effect.fn("OpenCodeDriver.make")(
  function* (options: OpenCodeDriver.Options) {
    const project = yield* OpenCodeProject.make({
      project: options.project,
      config: options.config,
    })

    const server = yield* OpenCodeServer.make({
      project,
      target: options.opencode,
    })

    const client = yield* server.clients.make(
      options.client,
    )

    return OpenCodeDriver.of({
      ui: client.ui,
      llm: server.llm,
      clients: server.clients,
    })
  },
)
```

The constructor does not manage ports, process flags, WebSocket listeners, request IDs, recording files, or cleanup directly. Those details stay behind the modules that own them.

## The server hides its process and backend connection

`OpenCodeServer.make(...)` acquires the server process, waits for readiness, connects backend control, creates shared LLM control, and exposes a client factory.

```ts
export const make = Effect.fn("OpenCodeServer.make")(
  function* (options: OpenCodeServer.Options) {
    const processSpawner = yield* ProcessSpawner.Service
    const connector = yield* SimulationConnector.Service

    const process = yield* processSpawner.server(options)
    const backend = yield* connector.backend(
      process.endpoints.backend,
    )
    const llm = yield* LlmController.make(backend)
    const clients = yield* OpenCodeClients.make({
      project: options.project,
      server: process,
      connector,
    })

    return OpenCodeServer.of({
      llm,
      clients,
    })
  },
)
```

The returned server value has domain capabilities. It does not expose the raw backend WebSocket.

## Each client hides its process and UI connection

`OpenCodeClient.make(...)` acquires one frontend process and connects typed UI control to that exact process.

```ts
export const make = Effect.fn("OpenCodeClient.make")(
  function* (options: OpenCodeClient.Options) {
    const process = yield* options.processSpawner.client(options)
    const ui = yield* options.connector.ui(
      process.endpoints.ui,
    )

    return OpenCodeClient.of({
      ui,
    })
  },
)
```

Client identity is generated internally for process maps, launch descriptors, logs, and artifact paths. It is not caller configuration.

## The connector is an internal transport adapter

The driver and OpenCode processes communicate over local WebSockets. Localhost does not remove the protocol seam: the processes still exchange OpenCode's existing JSON-RPC frames and fail independently.

`SimulationConnector` owns:

- WebSocket acquisition and release.
- Connection timeout and interruption.
- Request ID correlation.
- Canonical OpenCode JSON-RPC framing.
- Schema validation of results and notifications.
- Rejection of pending requests when the connection closes.
- Backend `llm.request` delivery as a validated `Stream`.
- Generated `RpcClient` acquisition through a custom protocol adapter.

The connector is injected into server and client constructors. It is not visible in `OpenCodeDriver.make(...)` or in userland.

```text
Driver                    Connector                      Process
   │                          │                             │
   ├─ spawn with launch descriptor ─────────────────────────▶
   │                          │                             │
   ├─ connect(endpoint) ──────▶                             │
   │                          │                             │
   │                          ├─ open localhost WebSocket ──▶
   │                          │                             │
   │                          ◀─ ready ─────────────────────┤
   │                          │                             │
   ◀─ typed protocol client ──┤                             │
   │                          │                             │
```

The same seam supports a real WebSocket adapter, direct connection to an already-running endpoint, and deterministic test adapters.

## Scope mirrors ownership

The driver scope owns the project, server, backend connection, LLM workers, primary client, and additional client scopes.

```text
                                                                                          ╭─┬────────────┬─╮
                                                                                          │ │Driver Scope│ │
                                                                                          ╰─┴──────┬─────┴─╯
          ╭───────────────────────────────┬───────────────────────────────┬────────────────────────╰───────┬───────────────────────────────────┬───────────────────────────────────────╮
          ▼                               ▼                               ▼                                ▼                                   ▼                                       ▼
╭───────────────────╮            ╭────────────────╮            ╭────────────────────╮            ╭───────────────────╮            ╭─┬────────────────────┬─╮            ╭─┬────────────────────────┬─╮
│ Project Workspace │            │ Server Process │            │ Backend Connection │            │ LLM Worker Fibers │            │ │Primary Client Scope│ │            │ │Additional Client Scopes│ │
╰───────────────────╯            ╰────────────────╯            ╰────────────────────╯            ╰───────────────────╯            ╰─┴──────────┬─────────┴─╯            ╰─┴────────────┬───────────┴─╯
                                     ╭─────────────────────────────┬───────────────────────────────┬────────────────────────────────┬──────────╯──────────────────┬────────────────────╯
                                     ▼                             ▼                               ▼                                ▼                             ▼
                           ╭──────────────────╮            ╭───────────────╮            ╭────────────────────╮            ╭──────────────────╮            ╭───────────────╮
                           │ Frontend Process │            │ UI Connection │            │ Optional Recording │            │ Frontend Process │            │ UI Connection │
                           ╰──────────────────╯            ╰───────────────╯            ╰────────────────────╯            ╰──────────────────╯            ╰───────────────╯
```

Reverse-order finalization produces the required shutdown order:

1. Interrupt and join response workers.
2. Finish client recordings.
3. Close UI connections.
4. Terminate client processes.
5. Close backend control.
6. Terminate the server process.
7. Apply artifact-retention policy.

Every process, connection, listener, and temporary directory has one scope owner.

## Effect primitives replace manual lifecycle coordination

| Concern | Effect primitive |
|---|---|
| Process, socket, and temporary-directory ownership | `Scope` and `Effect.acquireRelease` |
| Bracketed use whose settlement can fail | `Effect.acquireUseRelease` |
| Readiness, process exit, and first failure | `Deferred` |
| Queued future LLM responses | `Queue` |
| Backend request notifications | `Stream` over a private queue |
| Concurrent response handlers | `FiberSet` |
| Named active client workers | `FiberMap` where keyed supervision is needed |
| Readiness polling | `Schedule` plus an outer timeout |
| Lifecycle state | One tagged state in `Ref` |
| Wire, persisted, and user input | Effect `Schema` |
| Expected boundary failures | `Schema.TaggedErrorClass` |
| Reusable workflows | `Effect.fn("Module.operation")` |

Do not translate each mutable field into its own `Ref`, each callback into a `Queue`, or each object into a `Context.Service`. Use primitives only where they express real ownership or coordination.

## Stable adapters are services; dynamic resources are values

The architecture needs only a few service seams:

| Service | Real adapters |
|---|---|
| `ProcessSpawner` | Bun process adapter and deterministic test adapter |
| `SimulationConnector` | Canonical WebSocket adapter and in-memory test adapter |
| `RecordingExporter` | Canvas/ffmpeg adapter and injected test adapter |
| `InstanceRegistry` | Filesystem registry and deterministic test adapter |

Dynamic resources remain scoped values:

- `OpenCodeProject`
- `OpenCodeServer`
- `OpenCodeClient`
- UI and backend protocol clients
- `OpenCodeDriver`

This avoids creating a service tag for every object while retaining replaceable infrastructure seams.

## Effect RPC owns Drive's contracts and generated clients

OpenCode already exposes every UI and backend operation Drive needs. Its private `@opencode-ai/simulation` package defines the schemas, and its frontend and backend simulation processes use manual `Bun.serve` WebSocket dispatchers that speak plain JSON-RPC.

Drive currently mirrors that canonical protocol in `src/client/protocol.ts`. The first migration keeps the OpenCode processes and wire format unchanged. Drive defines local `RpcGroup`s that reference those schemas without changing command names or parameter shapes.

```ts
const UiRpcs = RpcGroup.make(
  Rpc.make("ui.state", {
    success: Frontend.State,
  }),
  Rpc.make("ui.type", {
    payload: Frontend.TypeParams,
    success: Frontend.State,
  }),
  Rpc.make("ui.screenshot", {
    payload: Schema.UndefinedOr(
      Frontend.ScreenshotParams,
    ),
    success: Frontend.Screenshot,
  }),
)
```

`RpcClient.make(UiRpcs)` provides the generated typed client, Schema encoding and decoding, middleware, tracing, interruption, and `RpcTest` support. A custom protocol underneath it translates Effect RPC requests and exits to OpenCode's exact JSON-RPC frames:

```ts
const protocol = yield* OpenCodeRpcProtocol.make(endpoint)

const rpc = yield* RpcClient.make(UiRpcs).pipe(
  Effect.provideService(
    RpcClient.Protocol,
    protocol,
  ),
)
```

The UI module wraps generated dotted methods with the settled userland names:

```ts
const type = (text: string) =>
  rpc["ui.type"]({ text })

const state = () =>
  rpc["ui.state"]()
```

```text
UiRpcs
  -> generated RpcClient
  -> custom OpenCodeRpcProtocol
  -> exact OpenCode JSON-RPC
  -> client UI WebSocket

BackendRpcs
  -> generated RpcClient
  -> custom OpenCodeRpcProtocol
  -> exact OpenCode JSON-RPC
  -> server backend WebSocket
  + validated llm.request Stream
```

The custom protocol is necessary because OpenCode does not currently speak Effect's stock socket dialect. That dialect can emit protocol headers, trace metadata, ping/pong, acknowledgements, interruption, chunks, and Effect cause envelopes that the existing OpenCode dispatchers do not understand.

The adapter owns only the compatibility boundary: request IDs, exact framing, response correlation, and translation of connection or JSON-RPC failures into typed client failures. Interruption stops waiting locally, but it cannot send Effect's interruption frame to the unchanged OpenCode peer.

The backend's `llm.request` messages are unsolicited OpenCode notifications rather than Effect RPC stream frames. The backend connector validates those notifications and exposes them as a separate Effect `Stream`; ordinary `llm.attach`, `llm.chunk`, `llm.finish`, and `llm.disconnect` calls continue through the generated `BackendRpcs` client.

## A follow-up can move the source of truth into OpenCode

The custom protocol lets Drive adopt Effect RPC without modifying OpenCode V2. It is an intentional migration boundary, not the desired permanent ownership model.

A later coordinated change should extract a lightweight `@opencode-ai/simulation-protocol` package from OpenCode containing the canonical schemas, `RpcGroup`s, protocol version, capability model, and typed compatibility errors. The current `@opencode-ai/simulation` package is private and also contains server, renderer, and font dependencies, so Drive should not depend on that full implementation package.

At that point, OpenCode server handlers and Drive clients consume the same values:

```text
@opencode-ai/simulation-protocol
  |-- HandshakeRpc
  |-- UiRpcs
  |-- BackendRpcs
  |-- Frontend schemas
  `-- Backend schemas

OpenCode -> RpcServer.layer(UiRpcs)
Drive    -> RpcClient.make(UiRpcs)
```

The follow-up should:

- Align OpenCode and Drive on one Effect version before sharing unstable RPC types.
- Replace OpenCode's manual frontend and backend dispatchers with `RpcServer` and the stock Effect WebSocket protocol.
- Replace Drive's custom compatibility protocol with the stock `RpcClient` socket protocol.
- Model backend request delivery as a real streaming RPC instead of `llm.attach` plus unsolicited `llm.request` notifications.
- Add an explicit application-level protocol version and capability handshake.

The handshake can first be requested in the launch descriptor and then verified through a typed `simulation.handshake` RPC after the WebSocket opens. It should confirm the endpoint role, protocol version, optional capabilities, and running OpenCode version. This work is not a prerequisite for `OpenCodeDriver.make(...)`.

The private Unix control socket used by detached CLI instances can use native Effect RPC because both peers belong to Drive. That control plane remains outside `OpenCodeDriver.make(...)`.

## The library and detached CLI have different outer ownership

The library constructor owns one ephemeral run in the caller's scope. It does not register a global instance name or open a Unix control socket.

The detached CLI adds an outer owner around the same core resources:

```text
Detached owner
|-- InstanceRegistry lease
|-- Effect RPC control server
|-- lifecycle command queue
`-- OpenCodeDriver scope
```

This keeps registry persistence, remote restart, and daemon ownership out of ordinary library use.

## Typed settlement must happen before infallible cleanup

Scope finalizers are appropriate for cleanup that cannot fail in the typed channel. Existing Drive scripts also enforce expected completion rules:

- Every queued LLM response must be consumed.
- Unexpected LLM requests fail the run.
- Output after a terminal event fails the run.
- Recording completion can fail.

Those checks must run as a normal Effect before the resource scope closes. They must not be converted into defects inside `acquireRelease` finalizers. The final script-level bracket that runs user code, settles LLM and recording work, and then closes resources must use `Effect.acquireUseRelease` or an equivalent explicit bracket.

The exact public spelling of that bracket is intentionally left out of the settled API document until it has a call site that preserves the agreed ergonomics.

## Implementation proceeds from pure contracts to ownership

1. Align Drive's Effect packages with the selected local `effect-smol` version.
2. Add pure `Llm` schemas, the manual output union, and constructors.
3. Add exact JSON-RPC characterization tests for all current UI and backend methods.
4. Define Drive-local UI and backend `RpcGroup`s over the canonical schemas.
5. Build the scoped WebSocket connection and custom `OpenCodeRpcProtocol`.
6. Replace Drive's manual clients with generated `RpcClient`s.
7. Add scoped process adapters and `OpenCodeProject.make`.
8. Add `OpenCodeServer.make` with shared backend and LLM control.
9. Add `OpenCodeClient.make` and the primary UI path.
10. Compose `OpenCodeDriver.make` and its typed settlement bracket.
11. Add `server.clients.make(...)` for additional clients.
12. Add the default-exported Effect runner used by `opencode-drive run`.

The first implementation slice is the pure `Llm` module. The first runtime slice is one primary client driven through `OpenCodeDriver.make(...)` with complete scoped cleanup.

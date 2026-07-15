# Driver Consolidation Plan

## Goal

Make the Effect-native driver the single owner of OpenCode Drive lifecycle behavior while preserving the existing `defineScript` call sites as a Promise adapter. Promote ordinary Effect programs to the primary product, add deterministic OpenCode TUI configuration, return structured run evidence with validated path types, and replace protocol-skew timeouts with explicit compatibility negotiation.

## Invariants

- `OpenCodeDriver.use` is the default safe lifecycle boundary.
- The Promise script API remains source-compatible.
- Manual scripts retain server kill/relaunch and named multi-client behavior.
- CLI `--command.ui.*` names and payloads remain identical to OpenCode's canonical frontend protocol.
- OpenCode configuration is expressed through normal `opencode.jsonc` and `tui.jsonc` files, not Drive-specific runtime flags.
- Backend simulation control remains in programs, not CLI commands.
- Every process, socket, worker, timeline, and temporary project has one lifecycle owner.
- Protocol compatibility is reported truthfully; legacy fallback is never described as negotiated compatibility.
- Filesystem paths crossing public boundaries are schema-validated branded values.

## Phase 0: Release Correctness

1. Correct the skill's targeted prune example to use the instance name.
2. Preserve the final off-grid terminal state in MP4 output and add encoded-output regression coverage.
3. Add the project MIT license and explicit Bun runtime metadata/documentation.
4. Keep `0.5.0` unpublished until the consolidation and release validation pass.

## Phase 1: Deterministic Configuration

1. Add semantic `OpenCodeConfig` and `OpenCodeTuiConfig` JSON object types.
2. Add `config` and `tui` to script definitions and driver options.
3. Expose mutable `config` and `tui` objects to `setup`.
4. Deep-merge declared configuration over project fixture files, with arrays replacing and setup mutations taking final precedence.
5. Parse existing JSONC rather than assuming strict JSON.
6. Write normalized `.opencode/opencode.jsonc` and `.opencode/tui.jsonc` before creating the optional Git baseline.
7. Verify the same behavior through Promise scripts and the Effect driver.

## Phase 2: Effect Program Runner

1. Add `opencode-drive run <module>`.
2. Require a default-exported, fully provided `Effect` value.
3. Typecheck a generated contract entrypoint before importing the program.
4. Execute the program in the CLI's existing Effect runtime, without a nested runtime or detached owner.
5. Reject command flags and arguments after `--`.
6. Make the Effect runner the README quick start.
7. Document minimal, multi-client, recording, settlement-failure, and `use` versus `make` examples.

## Phase 3: One Lifecycle Engine

1. Make LLM response state independent of one backend connection and attach it per server generation.
2. Introduce an Effect-native server-generation controller over one prepared `OpenCodeInstance`.
3. Add Effect-native named client creation, name release, unexpected-exit observation, and relaunch.
4. Reuse the Effect UI implementation for Promise scripts, including effectful predicates at the adapter boundary.
5. Add an internal driver constructor over an already prepared instance.
6. Replace Promise-side backend, UI polling, LLM routing, recording finalization, and client ownership with shallow adapters.
7. Delete duplicated lifecycle implementations only after all characterization tests pass.
8. Replace interruption-sensitive cached terminal operations with shared independently owned settlement effects.

## Phase 4: Structured Run Evidence

1. Add schema-validated `AbsolutePath` and portable artifact `RelativePath` branded types.
2. Add tagged artifact-relative and external path references.
3. Add a versioned `RunReport` containing timing, outcome, compatibility, retention, logs, screenshots, recordings, and concrete artifacts.
4. Return reports from safe library settlement and expose explicit JSON output for the CLI without changing ordinary stdout.
5. Publish recordings atomically through temporary files and rename on success.

## Phase 5: Protocol Compatibility

1. Add canonical `simulation.handshake` schemas and capability identifiers to OpenCode.
2. Implement the handshake on UI and backend endpoints.
3. Mirror the exact canonical protocol in Drive.
4. Negotiate endpoint role, protocol version, OpenCode version, and required/optional capabilities before exposing operations.
5. Support `required`, `preferred`, and explicit legacy compatibility policies.
6. Fail locally with typed compatibility errors rather than timing out on unsupported operations.
7. Include negotiated or legacy compatibility records in `RunReport`.

## Follow-Ups

### Typed OpenCode Client

Expose the existing OpenCode SDK client after introducing one service-registration discovery abstraction. The driver must keep registration passwords private and document compatibility between the SDK version bundled by Drive and arbitrary OpenCode command/dev targets.

### Tool Lifecycle Simulation

Extend the canonical OpenCode simulation protocol to model delayed tool completion, structured success, failure, cancellation, concurrency, and partial input. Expose this only through programs, never through convenience CLI command flags.

### Semantic UI Snapshot

Add roles, labels, stable identity, selected/expanded/disabled state, and hierarchy to the canonical OpenCode frontend protocol. Drive should consume those semantics instead of deriving them from terminal text.

## Verification Gates

- Focused unit and integration tests at each phase.
- `bun run check` after each public type or CLI boundary change.
- `bun run test` before each phase commit.
- Real OpenCode v2 capture/configuration smoke test when `OPENCODE_V2_SOURCE` is available.
- Packed-artifact inspection and clean Bun consumer validation before publication.
- Fresh-session skill verification locally, on kitbox, and on the Anomaly agent box.

## Explicit Non-Goals

- Generic terminal automation.
- Noncanonical CLI protocol aliases.
- Backend LLM or tool lifecycle control through shell flags.
- Public raw process, socket, scope, port, registry, or launch-descriptor control.
- Speculative transport/provider plugin systems.
- Automatic retries of state-changing UI operations.
- Campaign or cloud orchestration before the single-run engine is stable.

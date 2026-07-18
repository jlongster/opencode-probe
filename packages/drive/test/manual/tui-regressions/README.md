# TUI regression probes

These scripts exercise real OpenCode TUI behavior against a compatible local checkout. They are deliberately excluded from the normal package test command: some are diagnostic probes for timing-sensitive bugs, and some encode desired behavior for known-open V2 issues and currently fail.

From the repository root, set `OPENCODE_DEV` to the checkout under test:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/interaction-lifecycle.ts
bun run --cwd packages/drive drive start --name tui-interaction-lifecycle \
  --script test/manual/tui-regressions/interaction-lifecycle.ts \
  --dev "$OPENCODE_DEV"
```

The interaction probe asserts that:

- A submitted message is visible before a delayed model response begins.
- An active streaming response reaches the interrupted state after Escape.

## Initial message hydration

[`anomalyco/opencode#35988`](https://github.com/anomalyco/opencode/issues/35988) reports that a new Session can permanently lose its first user row during pending/history hydration while retaining the assistant response. The black-box probe creates fresh TUIs and checks both transcript rows after the response:

```sh
OPENCODE_DRIVE_ATTEMPTS=20 bun run --cwd packages/drive drive start \
  --name tui-initial-message \
  --script test/manual/tui-regressions/initial-message-hydration.ts \
  --dev "$OPENCODE_DEV"
```

The natural race is uncommon. During diagnosis, a valid empty history snapshot was gated across input promotion; that deterministic Drive run failed against the pre-fix parent and passed against the fix in OpenCode PR #36433. The checked-in probe does not require test-only OpenCode instrumentation, so use more attempts when trying to reproduce naturally.

The restart probe deliberately exposes a known failure:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/server-restart.ts
bun run --cwd packages/drive drive start --name tui-server-restart \
  --script test/manual/tui-regressions/server-restart.ts \
  --dev "$OPENCODE_DEV"
```

After the service restarts, the TUI reconnects its event stream but displays `Session not found` for the previous in-memory session. The failed run retains `after-restart.frame.json` in its artifact directory.

## Pending form restart

[`anomalyco/opencode#36585`](https://github.com/anomalyco/opencode/issues/36585) reports that a form retained by the TUI becomes unanswerable after the replacement server loses its process-local form cache:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/pending-form-restart.ts
bun run --cwd packages/drive drive start --name tui-pending-form-restart \
  --script test/manual/tui-regressions/pending-form-restart.ts \
  --dev "$OPENCODE_DEV"
```

The desired invariant is that the form either remains answerable or is dismissed as stale. If a retained form accepts local input but submission returns `Form not found`, the probe fails and preserves `stale-form.frame.json`. Current V2 dismisses the stale form and passes this probe.

## Reconnect outage

[`anomalyco/opencode#36688`](https://github.com/anomalyco/opencode/issues/36688) reports that a TUI exhausts its reconnect budget and crashes during a realistic post-update service outage:

```sh
OPENCODE_DRIVE_OUTAGE_MS=20000 bun run --cwd packages/drive drive start \
  --name tui-reconnect-outage \
  --script test/manual/tui-regressions/reconnect-outage.ts \
  --dev "$OPENCODE_DEV"
```

The desired invariant is that the TUI remains alive and returns to an actionable composer after the service relaunches. Current V2 passes with both 20-second and 60-second isolated outages. Increase the outage to model slower update election and cold location startup.

## Seeded lifecycle simulation

`lifecycle-properties.ts` selects deterministic response lifecycle transitions and runs shared invariants after every step. A failure preserves its seed, action trace, and terminal frame in `state-machine-failure.json`:

```sh
OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=20 \
  bun run --cwd packages/drive drive start --name tui-lifecycle-properties \
  --script test/manual/tui-regressions/lifecycle-properties.ts \
  --dev "$OPENCODE_DEV"
```

Re-run a failure with the same seed and step count. The transition set covers successful responses, user interruption, and provider disconnects. Shared invariants require the latest prompt and output to remain visible, the server projection to retain the prompt, pending input to settle, the composer to become actionable, and internal transport defects to stay out of the UI.

Interruption uses the existing `llm.pending` simulation capability. If OpenCode rejects a response write after terminating the invocation, Drive confirms that the invocation is no longer pending and settles the response as externally terminated. If the invocation remains pending or the query fails, Drive preserves the original write failure.

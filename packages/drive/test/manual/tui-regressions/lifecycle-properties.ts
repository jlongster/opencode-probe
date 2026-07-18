import { defineScript, Llm } from "../../../src/index.js"
import { Effect } from "effect"
import { run } from "./state-machine.js"

const seed = readInteger("OPENCODE_DRIVE_SEED", 1, Number.MAX_SAFE_INTEGER)
const steps = readInteger("OPENCODE_DRIVE_STEPS", 6, 1_000)

export default defineScript({
  run: ({ ui, llm, opencode, artifacts }) =>
    Effect.gen(function* () {
      type SessionID = Effect.Success<ReturnType<typeof opencode.session.list>>["data"][number]["id"]
      let sessionID: SessionID | undefined

      const getSession = Effect.fn("LifecycleProperties.getSession")(function* () {
        if (sessionID !== undefined) return sessionID
        const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
        sessionID = sessions.data[0]?.id
        if (sessionID === undefined) return yield* Effect.fail(new Error("no current session"))
        return sessionID
      })

      yield* run({
        context: { ui, artifacts },
        seed,
        steps,
        transitions: [
          {
            name: "response-completes",
            run: (step) =>
              Effect.gen(function* () {
                const prompt = `complete-prompt-${step}`
                const output = `complete-response-${step}`
                yield* llm.queue(Llm.text(output, { delay: 5, chunkSize: 4 }))
                yield* ui.submit(prompt)
                yield* ui.waitFor(output, { timeout: 10_000 })
                return { prompt, output, sessionID: yield* getSession() }
              }),
          },
          {
            name: "response-interrupted",
            run: (step) =>
              Effect.gen(function* () {
                const prompt = `interrupt-prompt-${step}`
                const output = `interrupt-partial-${step}`
                yield* llm.queue(
                  Llm.text(output, { delay: 0, chunkSize: 100 }),
                  Llm.text("-streaming-continuation".repeat(20), { delay: 100, chunkSize: 1 }),
                )
                yield* ui.submit(prompt)
                yield* Effect.sleep(500)
                const current = yield* getSession()
                yield* opencode.session.interrupt({ sessionID: current })
                yield* ui.waitFor(output, { timeout: 10_000 })
                return { prompt, output, sessionID: current }
              }),
          },
          {
            name: "provider-disconnects",
            run: (step) =>
              Effect.gen(function* () {
                const prompt = `disconnect-prompt-${step}`
                const output = `disconnect-partial-${step}`
                yield* llm.queue(Llm.text(output), Llm.disconnect())
                yield* ui.submit(prompt)
                yield* ui.waitFor(output, { timeout: 10_000 })
                return { prompt, output, sessionID: yield* getSession() }
              }),
          },
        ],
        invariants: [
          {
            name: "latest prompt remains visible",
            check: ({ prompt }) => ui.waitFor(prompt, { timeout: 10_000 }).pipe(Effect.asVoid),
          },
          {
            name: "latest output remains visible",
            check: ({ output }) => ui.waitFor(output, { timeout: 10_000 }).pipe(Effect.asVoid),
          },
          {
            name: "composer is actionable",
            check: () => ui.waitFor((state) => state.focused.editor, { timeout: 10_000 }).pipe(Effect.asVoid),
          },
          {
            name: "server projection retains the latest prompt",
            check: ({ prompt, sessionID }) =>
              Effect.gen(function* () {
                const messages = yield* opencode.message.list({ sessionID, limit: 20, order: "desc" })
                if (messages.data.some((message) => message.type === "user" && message.text === prompt)) return
                return yield* Effect.fail(new Error(`server projection lost prompt: ${prompt}`))
              }),
          },
          {
            name: "settled session has no pending input",
            check: ({ sessionID }) =>
              Effect.gen(function* () {
                const pending = yield* opencode.session.pending.list({ sessionID })
                if (pending.length === 0) return
                return yield* Effect.fail(new Error(`settled session retained ${pending.length} pending input(s)`))
              }),
          },
          {
            name: "transport defects are not rendered",
            check: () =>
              Effect.forEach(["UnknownError", "RpcClientDefect"], (text) =>
                ui.matches(text).pipe(
                  Effect.filterOrFail((visible) => !visible, () => new Error(`rendered internal error: ${text}`)),
                ),
              ).pipe(Effect.asVoid),
          },
        ],
      })
    }),
})

function readInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  return value
}

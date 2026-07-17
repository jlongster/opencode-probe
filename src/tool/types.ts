import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

export const ShellInput = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(600_000)),
  ).annotate({ description: "Optional timeout in milliseconds. Zero means unlimited. May not exceed 600000." }),
  background: Schema.optional(Schema.Boolean).annotate({ description: "Run the command in the background." }),
})
export interface ShellInput extends Schema.Schema.Type<typeof ShellInput> {}

export const ShellResult = Schema.Struct({
  output: Schema.String,
  exit: Schema.optional(Schema.Number),
  shellID: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["completed", "running"])),
  warnings: Schema.optional(Schema.Array(Schema.String)),
})
export interface ShellResult extends Schema.Schema.Type<typeof ShellResult> {}

export const WebFetchInput = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(120)),
  ).annotate({ description: "Optional timeout in seconds (maximum: 120)" }),
})
export interface WebFetchInput extends Schema.Schema.Type<typeof WebFetchInput> {}

export const WebFetchResult = Schema.Struct({
  output: Schema.String,
  url: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  format: Schema.optional(Schema.Literals(["text", "markdown", "html"])),
})
export interface WebFetchResult extends Schema.Schema.Type<typeof WebFetchResult> {}

export const WebSearchInput = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])),
  contextMaxCharacters: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
})
export interface WebSearchInput extends Schema.Schema.Type<typeof WebSearchInput> {}

export const WebSearchResult = Schema.Struct({
  output: Schema.String,
  provider: Schema.optional(Schema.Literals(["exa", "parallel"])),
})
export interface WebSearchResult extends Schema.Schema.Type<typeof WebSearchResult> {}

export class Failure extends Schema.TaggedErrorClass<Failure>()(
  "OpenCodeDrive.ToolFailure",
  { message: Schema.String },
) {}

export interface Context<Input, Result> {
  readonly input: Input
  /** Zero-based invocation index for this handler. */
  readonly index: number
  readonly progress: (output: string | Result) => Effect.Effect<void>
}

export type Handler<Input, Result> = (
  context: Context<Input, Result>,
) => Effect.Effect<Result, Failure>

export type ShellHandler = Handler<ShellInput, ShellResult>
export type WebFetchHandler = Handler<WebFetchInput, WebFetchResult>
export type WebSearchHandler = Handler<WebSearchInput, WebSearchResult>

export type Registration =
  | readonly [name: "shell", handler: ShellHandler]
  | readonly [name: "webfetch", handler: WebFetchHandler]
  | readonly [name: "websearch", handler: WebSearchHandler]

export interface Registry {
  handle(name: "shell", handler: ShellHandler): void
  handle(name: "webfetch", handler: WebFetchHandler): void
  handle(name: "websearch", handler: WebSearchHandler): void
}

export type Setup = (tools: Registry) => void

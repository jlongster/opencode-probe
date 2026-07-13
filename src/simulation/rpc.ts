import * as Schema from "effect/Schema"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Backend, Frontend } from "./protocol.js"

export class SimulationRequestError extends Schema.TaggedErrorClass<SimulationRequestError>()(
  "SimulationRequestError",
  {
    method: Schema.String,
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  },
) {}

const request = <
  const Tag extends string,
  Payload extends Schema.Top | Schema.Struct.Fields = typeof Schema.Void,
  Success extends Schema.Top = typeof Schema.Void,
>(
  tag: Tag,
  options?: {
    readonly payload?: Payload
    readonly success?: Success
  },
) =>
  Rpc.make(tag, {
    ...options,
    error: SimulationRequestError,
  })

export const UiRpcs = RpcGroup.make(
  request("ui.state", { success: Frontend.State }),
  request("ui.matches", {
    payload: Frontend.MatchesParams,
    success: Frontend.Matches,
  }),
  request("ui.screenshot", {
    payload: Schema.UndefinedOr(Frontend.ScreenshotParams),
    success: Frontend.Screenshot,
  }),
  request("ui.recording.finish", {
    success: Frontend.RecordingFinish,
  }),
  request("ui.type", {
    payload: Frontend.TypeParams,
    success: Frontend.State,
  }),
  request("ui.press", {
    payload: Frontend.PressParams,
    success: Frontend.State,
  }),
  request("ui.enter", { success: Frontend.State }),
  request("ui.arrow", {
    payload: Frontend.ArrowParams,
    success: Frontend.State,
  }),
  request("ui.focus", {
    payload: Frontend.FocusParams,
    success: Frontend.State,
  }),
  request("ui.click", {
    payload: Frontend.ClickParams,
    success: Frontend.State,
  }),
  request("ui.resize", {
    payload: Frontend.ResizeParams,
    success: Frontend.State,
  }),
)

export const BackendRpcs = RpcGroup.make(
  request("llm.attach", { success: Backend.Attached }),
  request("llm.chunk", {
    payload: Backend.ChunkParams,
    success: Backend.Ok,
  }),
  request("llm.finish", {
    payload: Backend.FinishPayload,
    success: Backend.Ok,
  }),
  request("llm.disconnect", {
    payload: Backend.DisconnectParams,
    success: Backend.Ok,
  }),
)

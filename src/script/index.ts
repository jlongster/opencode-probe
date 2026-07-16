import * as Effect from "effect/Effect"
import type {
  AutomaticScriptDefinition,
  ManualScriptDefinition,
  ScriptDefinition,
} from "./types.js"

export function defineScript(script: ManualScriptDefinition): ManualScriptDefinition
export function defineScript(
  script: AutomaticScriptDefinition,
): AutomaticScriptDefinition
export function defineScript(script: ScriptDefinition): ScriptDefinition {
  return script
}

export const wait = (milliseconds: number) => Effect.sleep(milliseconds)

export type * from "./types.js"

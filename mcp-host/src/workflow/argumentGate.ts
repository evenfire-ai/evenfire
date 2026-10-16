/**
 * The check every internal tool call passes before it runs, from chat and from
 * a workflow step alike: nulls sent for unset optional arguments are dropped,
 * then the arguments are validated against the tool's JSON Schema. A call that
 * fails runs nothing, so it writes no file and attaches nothing.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import { logger } from '../logger'
import { withoutUnsetNulls } from './schemaArguments'
import type { InternalToolDefinition } from './types'

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true })
const compiled = new WeakMap<object, ValidateFunction | null>()

/**
 * A call can break every field of a long document at once; naming a few is
 * enough for the model to fix the call, and keeps the error out of its way.
 */
const MAX_ERRORS = 8
const MAX_ERROR_CHARS = 1_000

/**
 * The validator of `tool`'s schema, compiled once per schema. A schema that
 * does not compile is logged and leaves the tool's own argument checks.
 */
export function argumentValidator(tool: InternalToolDefinition): ValidateFunction | null {
  const schema = tool.parameters
  const known = compiled.get(schema)
  if (known !== undefined) return known
  let validator: ValidateFunction | null = null
  try {
    validator = ajv.compile(schema)
  } catch (err) {
    // Surface the failure so a schema regression does not pass silently.
    logger.warn({ err, toolName: tool.name }, 'Internal tool schema compilation failed')
  }
  compiled.set(schema, validator)
  return validator
}

function errorsText(errors: ErrorObject[] | null | undefined): string {
  const all = errors ?? []
  let text = ajv.errorsText(all.slice(0, MAX_ERRORS), { separator: '; ' })
  if (all.length > MAX_ERRORS) text += `; and ${all.length - MAX_ERRORS} more`
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

export type ArgumentCheck =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * `args` as `tool` runs them, with the schema's defaults filled in, or why it
 * must not run. The objects the schema describes are copied before defaults
 * are filled, so `args` stays as sent.
 */
export function checkToolArguments(
  tool: InternalToolDefinition,
  args: Record<string, unknown> | null | undefined
): ArgumentCheck {
  const input = withoutUnsetNulls(tool.parameters, args ?? {}) as Record<string, unknown>
  const validate = argumentValidator(tool)
  if (!validate || validate(input)) return { ok: true, input }
  return { ok: false, error: `Invalid arguments: ${errorsText(validate.errors)}` }
}

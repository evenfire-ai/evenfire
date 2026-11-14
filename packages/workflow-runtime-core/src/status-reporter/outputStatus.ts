/**
 * Step output bounds for status reports. WRC stores only a preview of a step's
 * output (at most STATUS_OUTPUT_MAX_CHARS characters) and rejects request
 * bodies over 512 KiB. The coordinator cuts the output to the largest preview
 * WRC can store. When the serialized body is over STATUS_REPORT_MAX_BYTES it
 * reduces `error`/`failureReason`, tool-call previews and `output`, in that
 * order. Other fields are not bounded, so a body can still be over the
 * ceiling; the caller logs it and sends it.
 */
import {
  type StatusArtifact,
  boundToolsCalledForStatus,
  normalizeArtifactForStatus,
  parseArtifactToolResult,
} from './toolCallStatus'

/** Largest output preview WRC can be configured to store. */
export const STATUS_OUTPUT_MAX_CHARS = 64 * 1024
/** Size above which a step status body is reduced; WRC rejects bodies over 512 KiB. */
export const STATUS_REPORT_MAX_BYTES = 256 * 1024
export const STATUS_ERROR_MAX_CHARS = 8192
/** Entries read from an output's `artifacts[]`. */
export const MAX_OUTPUT_ARTIFACTS_FOR_STATUS = 20
/** Most artifacts one output declares: `artifact` plus the entries read from `artifacts[]`. */
export const MAX_REPORTED_OUTPUT_ARTIFACTS = 1 + MAX_OUTPUT_ARTIFACTS_FOR_STATUS
/** Smallest preview WRC can be configured to store; halving stops at this length. */
const MIN_DEGRADED_OUTPUT_CHARS = 1024

export interface BoundedStatusOutput {
  output: string
  outputLength: number
  outputTruncated: boolean
  outputArtifacts?: StatusArtifact[]
}

/**
 * Serialization WRC applies to the `output` it received before storing the
 * preview. The argument is a value that already went through JSON transport.
 */
export function serializeOutputForStatus(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'

  const seen = new WeakSet<object>()
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]'
        seen.add(nested)
      }
      return nested
    })
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * The text of a step output as the report carries it. JSON semantics, so an
 * object referenced twice is written out twice, with three differences:
 * - an object that contains itself is written as "[Circular]" where it repeats;
 * - an output whose JSON form is a string (a Date, a `toJSON` returning a
 *   string) is that string, which is what WRC receives for it;
 * - an output with no JSON form is `String(output)`: undefined, a function, a
 *   symbol, or an object whose `toJSON` returns one of those (for a plain
 *   object that text is "[object Object]").
 * Throws when JSON cannot serialize the output (a BigInt, a throwing `toJSON`).
 */
function serializeOutputForReport(output: unknown): string {
  if (typeof output === 'string') return output
  const json = JSON.stringify(output, circularReferenceMarker())
  if (json === undefined) return String(output)
  return json.startsWith('"') ? (JSON.parse(json) as string) : json
}

/**
 * JSON.stringify replacer that replaces an object with "[Circular]" only when
 * it is one of its own ancestors. JSON.stringify calls the replacer with
 * `this` set to the object that holds `value`, so the ancestors of `value` are
 * the stack up to and including that holder. `onStack` holds the same objects
 * as the stack, so the ancestor test does not scan it.
 */
function circularReferenceMarker(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: object[] = []
  const onStack = new Set<object>()
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      onStack.delete(ancestors.pop() as object)
    }
    if (onStack.has(value)) return '[Circular]'
    ancestors.push(value)
    onStack.add(value)
    return value
  }
}

/** Artifacts a step output declares (`artifact`, `artifacts[]`), normalized. */
export function extractOutputArtifactsForStatus(output: unknown): StatusArtifact[] {
  const parsedOutput = parseOutputRecord(output)
  if (!parsedOutput) return []

  const artifacts: StatusArtifact[] = []
  if (isRecord(parsedOutput.artifact)) {
    const artifact = normalizeArtifactForStatus(parsedOutput.artifact)
    if (artifact) artifacts.push(artifact)
  }

  if (Array.isArray(parsedOutput.artifacts)) {
    for (const item of parsedOutput.artifacts.slice(0, MAX_OUTPUT_ARTIFACTS_FOR_STATUS)) {
      if (!isRecord(item)) continue
      const artifact = normalizeArtifactForStatus(item)
      if (artifact) artifacts.push(artifact)
    }
  }

  return artifacts
}

/**
 * Cut `output` to STATUS_OUTPUT_MAX_CHARS. Artifacts are extracted only when
 * the output is cut (an uncut output still carries them), and from the
 * serialized text, which is what WRC parses when it receives the whole output.
 */
export function boundOutputForStatus(output: unknown): BoundedStatusOutput {
  const serialized = serializeOutputForReport(output)
  if (serialized.length <= STATUS_OUTPUT_MAX_CHARS) {
    return { output: serialized, outputLength: serialized.length, outputTruncated: false }
  }
  const outputArtifacts = extractOutputArtifactsForStatus(serialized)
  return {
    output: serialized.slice(0, STATUS_OUTPUT_MAX_CHARS),
    outputLength: serialized.length,
    outputTruncated: true,
    ...(outputArtifacts.length > 0 && { outputArtifacts }),
  }
}

/**
 * Apply the output cut and the tool-call bounds to a step status body, then
 * reduce it while it is over STATUS_REPORT_MAX_BYTES. Pure: the input is not
 * mutated. Character limits do not bound bytes (a control character is six
 * bytes in JSON), so the reduction runs in a fixed order and stops as soon as
 * the body fits: cut `error`/`failureReason`; remove tool-call previews from
 * the last call backwards, keeping artifact metadata and leaving a call that
 * would not get smaller as it is; halve `output`. A body that still does not
 * fit is returned as is; the caller logs it.
 */
export function boundStepStatusBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body }
  if (body.output !== undefined && body.output !== null) {
    Object.assign(result, boundOutputForStatus(body.output))
  }
  if (Array.isArray(body.toolsCalled)) {
    result.toolsCalled = boundToolsCalledForStatus(body.toolsCalled)
  }
  if (fits(result)) return result

  for (const field of ['error', 'failureReason'] as const) {
    const value = result[field]
    if (typeof value === 'string' && value.length > STATUS_ERROR_MAX_CHARS) {
      result[field] = value.slice(0, STATUS_ERROR_MAX_CHARS)
    }
  }
  if (fits(result)) return result

  if (Array.isArray(result.toolsCalled)) {
    result.toolsCalled = removePreviewsFromTheEnd(result.toolsCalled, bodyBytes(result))
    if (fits(result)) return result
  }

  if (typeof result.output === 'string' && result.output.length > MIN_DEGRADED_OUTPUT_CHARS) {
    if (result.outputTruncated !== true) {
      // Not cut yet, so `result.output` is the whole serialized output.
      const outputArtifacts = extractOutputArtifactsForStatus(result.output)
      if (outputArtifacts.length > 0) result.outputArtifacts = outputArtifacts
    }
    while (
      !fits(result) &&
      typeof result.output === 'string' &&
      result.output.length > MIN_DEGRADED_OUTPUT_CHARS
    ) {
      const half = Math.floor(result.output.length / 2)
      result.output = result.output.slice(0, Math.max(MIN_DEGRADED_OUTPUT_CHARS, half))
      result.outputTruncated = true
    }
  }
  return result
}

/**
 * Remove args and result previews from the last call backwards, until the
 * body fits. A call whose reduced form is not smaller is left as it is: the
 * normalized artifact metadata can be larger than the result it replaces. A
 * JSON array element is serialized on its own, so the bytes saved by one call
 * are exact.
 */
function removePreviewsFromTheEnd(toolsCalled: readonly unknown[], bytes: number): unknown[] {
  const calls = [...toolsCalled]
  let excess = bytes - STATUS_REPORT_MAX_BYTES
  for (let index = calls.length - 1; index >= 0 && excess > 0; index--) {
    const call = calls[index]
    if (!isRecord(call)) continue
    const reduced = withoutPreviews(call)
    const saved = jsonBytes(call) - jsonBytes(reduced)
    if (saved <= 0) continue
    excess -= saved
    calls[index] = reduced
  }
  return calls
}

/** Drop args and the result preview; keep the artifact metadata WRC would accept. */
function withoutPreviews(call: Record<string, unknown>): Record<string, unknown> {
  const { args: _args, result, ...rest } = call
  const artifact = parseArtifactToolResult(result)
  const accepted = artifact ? normalizeArtifactForStatus(artifact) : null
  return accepted ? { ...rest, result: { success: true, artifact: accepted } } : rest
}

function fits(body: Record<string, unknown>): boolean {
  return bodyBytes(body) <= STATUS_REPORT_MAX_BYTES
}

function bodyBytes(body: Record<string, unknown>): number {
  return jsonBytes(body)
}

function jsonBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function parseOutputRecord(output: unknown): Record<string, unknown> | null {
  if (isRecord(output)) return output
  if (typeof output !== 'string') return null
  try {
    const parsed = JSON.parse(output)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

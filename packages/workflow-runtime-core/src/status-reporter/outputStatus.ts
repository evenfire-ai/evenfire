/**
 * Step output bounds for status reports. WRC stores only a preview of a step's
 * output (at most STATUS_OUTPUT_MAX_CHARS characters) and rejects request
 * bodies over 512 KiB, so the coordinator cuts the output to the largest
 * preview WRC can store and keeps the whole serialized body under
 * STATUS_REPORT_MAX_BYTES.
 */
import {
  type StatusArtifact,
  boundToolsCalledForStatus,
  normalizeArtifactForStatus,
} from './toolCallStatus'

/** Largest output preview WRC can be configured to store. */
export const STATUS_OUTPUT_MAX_CHARS = 64 * 1024
/** Ceiling for a serialized step status body; WRC rejects bodies over 512 KiB. */
export const STATUS_REPORT_MAX_BYTES = 256 * 1024
export const STATUS_ERROR_MAX_CHARS = 8192
export const MAX_OUTPUT_ARTIFACTS_FOR_STATUS = 20
/** The output is never halved below this length to make the body fit. */
const MIN_DEGRADED_OUTPUT_CHARS = 1024

export interface BoundedStatusOutput {
  output: string
  outputLength: number
  outputTruncated: boolean
  outputArtifacts?: StatusArtifact[]
}

/** Same serialization WRC applies before storing the preview. */
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
 * the output is cut: an uncut output still carries them, and WRC extracts
 * them from it as before.
 */
export function boundOutputForStatus(output: unknown): BoundedStatusOutput {
  const serialized = serializeOutputForStatus(output)
  if (serialized.length <= STATUS_OUTPUT_MAX_CHARS) {
    return { output: serialized, outputLength: serialized.length, outputTruncated: false }
  }
  const outputArtifacts = extractOutputArtifactsForStatus(output)
  return {
    output: serialized.slice(0, STATUS_OUTPUT_MAX_CHARS),
    outputLength: serialized.length,
    outputTruncated: true,
    ...(outputArtifacts.length > 0 && { outputArtifacts }),
  }
}

/**
 * Apply every bound and the byte ceiling to a step status body. Pure: the
 * input is not mutated. Character limits do not bound bytes (a control
 * character is six bytes in JSON), so when the body is still over
 * STATUS_REPORT_MAX_BYTES it degrades in a fixed order, measuring after each
 * step: cut `error`/`failureReason`, drop tool-call args and non-artifact
 * results, then halve `output`. A body that still does not fit is returned as
 * is; the caller logs it.
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
    result.toolsCalled = result.toolsCalled.map(dropToolCallPreviews)
    if (fits(result)) return result
  }

  if (typeof result.output === 'string' && result.output.length > MIN_DEGRADED_OUTPUT_CHARS) {
    if (result.outputArtifacts === undefined) {
      const outputArtifacts = extractOutputArtifactsForStatus(body.output)
      if (outputArtifacts.length > 0) result.outputArtifacts = outputArtifacts
    }
    while (
      !fits(result) &&
      typeof result.output === 'string' &&
      result.output.length > MIN_DEGRADED_OUTPUT_CHARS
    ) {
      result.output = result.output.slice(0, Math.floor(result.output.length / 2))
      result.outputTruncated = true
    }
  }
  return result
}

/** Keep only the artifact metadata a bounded tool call carries; drop args. */
function dropToolCallPreviews(call: unknown): unknown {
  if (!isRecord(call)) return call
  const { args: _args, result, ...rest } = call
  return isArtifactOnlyResult(result) ? { ...rest, result } : rest
}

/** The `{ success: true, artifact }` shape boundToolsCalledForStatus leaves for artifacts. */
function isArtifactOnlyResult(result: unknown): boolean {
  return (
    isRecord(result) &&
    Object.keys(result).length === 2 &&
    result.success === true &&
    isRecord(result.artifact)
  )
}

function fits(body: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(body)) <= STATUS_REPORT_MAX_BYTES
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

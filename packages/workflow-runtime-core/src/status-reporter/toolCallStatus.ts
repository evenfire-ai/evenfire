/**
 * Tool-call status limits shared by the coordinator (before reporting) and WRC
 * (before storing). WRC persists at most MAX_STATUS_TOOL_CALLS calls with
 * args/results cut to the preview limits, so the coordinator bounds the report
 * the same way instead of sending every full tool result over the wire.
 */
export const MAX_STATUS_TOOL_CALLS = 50
export const STATUS_TOOL_ARGS_PREVIEW_LIMIT = 1024
export const STATUS_TOOL_RESULT_PREVIEW_LIMIT = 1024
const MAX_ARTIFACT_NAME_LENGTH = 128
const MAX_ARTIFACT_FORMAT_LENGTH = 64
const MAX_ARTIFACT_PATH_LENGTH = 512
const MAX_ARTIFACT_CREATED_AT_LENGTH = 64

export interface StatusArtifact {
  name: string
  format: string
  sizeBytes: number
  path: string
  createdAt: string
}

type StatusPreview = { truncated: true; preview: string }

export function normalizeToolArgsForStatus(args: unknown): Record<string, unknown> | undefined {
  if (args === undefined) return undefined
  if (isStatusPreview(args, STATUS_TOOL_ARGS_PREVIEW_LIMIT)) return args
  const serialized = stringifyStatusPreview(args)
  if (serialized.length > STATUS_TOOL_ARGS_PREVIEW_LIMIT) {
    return { truncated: true, preview: serialized.slice(0, STATUS_TOOL_ARGS_PREVIEW_LIMIT) }
  }
  if (isRecord(args)) return args
  return { value: args }
}

export function normalizeToolResultForStatus(result: unknown): unknown {
  if (result === undefined) return undefined
  if (isStatusPreview(result, STATUS_TOOL_RESULT_PREVIEW_LIMIT)) return result
  const serialized = stringifyStatusPreview(result)
  if (serialized.length > STATUS_TOOL_RESULT_PREVIEW_LIMIT) {
    return { truncated: true, preview: serialized.slice(0, STATUS_TOOL_RESULT_PREVIEW_LIMIT) }
  }
  return result
}

/**
 * Bound a step's tool calls for a status report: the first
 * MAX_STATUS_TOOL_CALLS calls with previewed args/results (what WRC stores),
 * plus up to MAX_STATUS_TOOL_CALLS later calls whose result reports a
 * generated artifact. WRC extracts artifacts from every reported call, so those
 * later calls are kept (without args), and an artifact result too large for a
 * preview is reduced to the artifact metadata WRC accepts (normalized, so
 * at most a few hundred chars) rather than truncated. Past the
 * cap, artifacts from a step with more than 2 x MAX_STATUS_TOOL_CALLS calls
 * are dropped to keep the report bounded.
 * Entries are not validated here; WRC rejects malformed ones.
 */
export function boundToolsCalledForStatus(toolsCalled: readonly unknown[]): unknown[] {
  const bounded = toolsCalled.slice(0, MAX_STATUS_TOOL_CALLS).map(call => {
    if (!isRecord(call)) return call
    const { args, result, ...rest } = call
    return {
      ...rest,
      ...(args !== undefined && { args: normalizeToolArgsForStatus(args) }),
      ...(result !== undefined && { result: boundToolResultForStatus(result) }),
    }
  })

  let laterArtifactCalls = 0
  for (const call of toolsCalled.slice(MAX_STATUS_TOOL_CALLS)) {
    if (laterArtifactCalls >= MAX_STATUS_TOOL_CALLS) break
    if (!isRecord(call) || !parseArtifactToolResult(call.result)) continue
    const { args: _args, result, ...rest } = call
    bounded.push({ ...rest, result: boundToolResultForStatus(result) })
    laterArtifactCalls += 1
  }
  return bounded
}

function boundToolResultForStatus(result: unknown): unknown {
  const normalized = normalizeToolResultForStatus(result)
  if (normalized === result) return result
  // Send only what WRC would extract from the full result; a result whose
  // artifact WRC rejects carries nothing to extract and stays a preview.
  const artifact = parseArtifactToolResult(result)
  const accepted = artifact ? normalizeArtifactForStatus(artifact) : null
  return accepted ? { success: true, artifact: accepted } : normalized
}

/** WRC's validation of reported artifact metadata; null when WRC rejects it. */
export function normalizeArtifactForStatus(value: Record<string, unknown>): StatusArtifact | null {
  if (typeof value.name !== 'string') return null
  const name = value.name.trim()
  if (!name || name.length > MAX_ARTIFACT_NAME_LENGTH) return null
  if (/[/\\\x00]/.test(name) || name.includes('..')) return null

  if (typeof value.path !== 'string') return null
  const path = value.path.trim()
  if (!path.startsWith('/output/') || path.length > MAX_ARTIFACT_PATH_LENGTH) return null
  if (path.includes('\x00') || path.split('/').includes('..')) return null

  const format = typeof value.format === 'string' ? value.format.trim() : ''
  if (format.length > MAX_ARTIFACT_FORMAT_LENGTH) return null

  const sizeBytes = typeof value.sizeBytes === 'number' ? value.sizeBytes : 0
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null

  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt.length <= MAX_ARTIFACT_CREATED_AT_LENGTH
      ? value.createdAt
      : new Date().toISOString()

  return {
    name,
    format,
    sizeBytes,
    path,
    createdAt,
  }
}

function parseArtifactToolResult(result: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof result === 'object' ? result : JSON.parse(String(result ?? '{}'))
    return isRecord(parsed) && parsed.success === true && isRecord(parsed.artifact)
      ? parsed.artifact
      : null
  } catch {
    return null
  }
}

function isStatusPreview(value: unknown, limit: number): value is StatusPreview {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.truncated === true &&
    typeof value.preview === 'string' &&
    value.preview.length <= limit
  )
}

function stringifyStatusPreview(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

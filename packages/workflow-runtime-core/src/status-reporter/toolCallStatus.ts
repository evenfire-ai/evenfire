/**
 * Tool-call status limits shared by the coordinator (before reporting) and WRC
 * (before storing). WRC persists at most MAX_STATUS_TOOL_CALLS calls with
 * args/results cut to the preview limits, so the coordinator bounds the report
 * the same way instead of sending every full tool result over the wire.
 */
export const MAX_STATUS_TOOL_CALLS = 50
export const STATUS_TOOL_ARGS_PREVIEW_LIMIT = 1024
export const STATUS_TOOL_RESULT_PREVIEW_LIMIT = 1024
/**
 * The request body limit and the CRD size limit count UTF-8 bytes of the
 * serialized JSON, where one character costs up to six bytes (an escaped
 * control character). An args or result value is therefore also limited to
 * this many serialized bytes per character of its preview limit. Two is the
 * most a printable ASCII character costs (`"` and `\` are escaped to two
 * bytes), so previews of printable ASCII text keep their length.
 */
const STATUS_TOOL_PREVIEW_MAX_BYTES_PER_CHAR = 2
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
  const kept = isRecord(args) ? args : { value: args }
  if (exceedsStatusLimit(kept, serialized, STATUS_TOOL_ARGS_PREVIEW_LIMIT)) {
    return {
      truncated: true,
      preview: cutStatusPreview(serialized, STATUS_TOOL_ARGS_PREVIEW_LIMIT),
    }
  }
  return kept
}

export function normalizeToolResultForStatus(result: unknown): unknown {
  if (result === undefined) return undefined
  if (isStatusPreview(result, STATUS_TOOL_RESULT_PREVIEW_LIMIT)) return result
  const serialized = stringifyStatusPreview(result)
  if (exceedsStatusLimit(result, serialized, STATUS_TOOL_RESULT_PREVIEW_LIMIT)) {
    return {
      truncated: true,
      preview: cutStatusPreview(serialized, STATUS_TOOL_RESULT_PREVIEW_LIMIT),
    }
  }
  return result
}

/**
 * Bound a step's tool calls for a status report: the first
 * MAX_STATUS_TOOL_CALLS calls with previewed args/results (what WRC stores),
 * plus up to MAX_STATUS_TOOL_CALLS later calls whose result reports a
 * generated artifact. WRC extracts artifacts from every reported call, so those
 * later calls are kept (without args), and an artifact result too large for a
 * preview is reduced to the artifact metadata WRC accepts (normalized: at
 * most 768 characters of metadata, which can serialize to about 4.7 KB)
 * rather than truncated. WRC stores metadata over the byte limit as a
 * preview, but still lists the artifact in status.artifacts. Past the
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
    value.preview.length <= limit &&
    serializedStringBytes(value.preview) <= STATUS_TOOL_PREVIEW_MAX_BYTES_PER_CHAR * limit
  )
}

/**
 * True when a value is too long to keep (`serialized` is its preview text), or
 * when `kept`, the value as it would be sent, is too large once serialized.
 */
function exceedsStatusLimit(kept: unknown, serialized: string, limit: number): boolean {
  if (serialized.length > limit) return true
  const bytes =
    typeof kept === 'string'
      ? serializedStringBytes(kept)
      : Buffer.byteLength(stringifyStatusPreview(kept))
  return bytes > STATUS_TOOL_PREVIEW_MAX_BYTES_PER_CHAR * limit
}

/**
 * The first `limit` characters of `text`, shortened further (on a code-point
 * boundary) while they serialize to more than the byte limit.
 */
function cutStatusPreview(text: string, limit: number): string {
  const head = text.slice(0, limit)
  const maxBytes = STATUS_TOOL_PREVIEW_MAX_BYTES_PER_CHAR * limit
  if (serializedStringBytes(head) <= maxBytes) return head
  let bytes = 0
  let end = 0
  for (const codePoint of head) {
    bytes += serializedStringBytes(codePoint)
    if (bytes > maxBytes) break
    end += codePoint.length
  }
  return head.slice(0, end)
}

/** UTF-8 bytes of `text` inside a JSON string, without the two quotes. */
function serializedStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2
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

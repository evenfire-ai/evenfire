/**
 * Tool-call status limits shared by the coordinator (before reporting) and WRC
 * (before storing). WRC persists at most MAX_STATUS_TOOL_CALLS calls with
 * args/results cut to the preview limits, so the coordinator bounds the report
 * the same way instead of sending every full tool result over the wire.
 */
export const MAX_STATUS_TOOL_CALLS = 50
export const STATUS_TOOL_ARGS_PREVIEW_LIMIT = 1024
export const STATUS_TOOL_RESULT_PREVIEW_LIMIT = 1024

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
 * later calls are kept (without args) to leave status.artifacts unchanged.
 * Entries are not validated here; WRC rejects malformed ones.
 */
export function boundToolsCalledForStatus(toolsCalled: readonly unknown[]): unknown[] {
  const bounded = toolsCalled.slice(0, MAX_STATUS_TOOL_CALLS).map(call => {
    if (!isRecord(call)) return call
    const { args, result, ...rest } = call
    return {
      ...rest,
      ...(args !== undefined && { args: normalizeToolArgsForStatus(args) }),
      ...(result !== undefined && { result: normalizeToolResultForStatus(result) }),
    }
  })

  let laterArtifactCalls = 0
  for (const call of toolsCalled.slice(MAX_STATUS_TOOL_CALLS)) {
    if (laterArtifactCalls >= MAX_STATUS_TOOL_CALLS) break
    if (!isRecord(call) || !isArtifactToolResult(call.result)) continue
    const { args: _args, result, ...rest } = call
    bounded.push({ ...rest, result: normalizeToolResultForStatus(result) })
    laterArtifactCalls += 1
  }
  return bounded
}

function isArtifactToolResult(result: unknown): boolean {
  try {
    const parsed = typeof result === 'object' ? result : JSON.parse(String(result ?? '{}'))
    return isRecord(parsed) && parsed.success === true && isRecord(parsed.artifact)
  } catch {
    return false
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

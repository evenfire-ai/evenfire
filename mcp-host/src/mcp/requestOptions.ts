const DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000
const DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS = 3_600_000
const MCP_TOOL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_TIMEOUT_MS'
const MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS'

export interface McpToolCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface McpSdkRequestOptions {
  timeout: number
  maxTotalTimeout: number
  signal?: AbortSignal
}

function readPositiveSafeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive safe integer`)
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

export function resolveMcpRequestTimeoutMs(callerTimeoutMs?: number): number {
  const configuredTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_TIMEOUT_ENV,
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
  const configuredMaxTotalTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV,
    DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS
  )
  if (
    configuredMaxTotalTimeoutMs < configuredTimeoutMs &&
    (callerTimeoutMs === undefined || callerTimeoutMs > configuredMaxTotalTimeoutMs)
  ) {
    throw new Error(
      `${MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV} must be greater than or equal to ${MCP_TOOL_TIMEOUT_ENV}`
    )
  }
  if (callerTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(callerTimeoutMs) || callerTimeoutMs < 1) {
      throw new Error('caller MCP timeout must be a positive safe integer')
    }
    return Math.min(configuredTimeoutMs, configuredMaxTotalTimeoutMs, callerTimeoutMs)
  }
  return Math.min(configuredTimeoutMs, configuredMaxTotalTimeoutMs)
}

export function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw abortError(signal, 'aborted')
}

function abortError(signal: AbortSignal | undefined, fallback: string): Error {
  // Preserve an Error abort reason verbatim (e.g. the lifecycle 'closed' /
  // 'superseded' error propagated through retirementController.abort()), so a
  // retired/superseded connection surfaces its real cause instead of 'aborted'.
  if (signal?.reason instanceof Error) return signal.reason
  const reason =
    typeof signal?.reason === 'string' && signal.reason.trim() ? signal.reason : fallback
  return new Error(reason)
}

export function withRequestTimeout<T>(
  operation: Promise<T>,
  options: McpToolCallOptions,
  timeoutMessage: string
): Promise<T> {
  ensureNotAborted(options.signal)
  const timeoutMs = resolveMcpRequestTimeoutMs(options.timeoutMs)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => rejectOnce(abortError(options.signal, 'aborted'))
    const timer = setTimeout(
      () =>
        rejectOnce(new Error(options.timeoutMs !== undefined ? 'step-timeout' : timeoutMessage)),
      timeoutMs
    )
    options.signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(resolveOnce, rejectOnce)
  })
}

export function remainingBudgetMs(deadlineMs: number | undefined): number | undefined {
  if (deadlineMs === undefined) return undefined
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new Error('step-timeout')
  return remainingMs
}

export function requestOptions(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): McpSdkRequestOptions {
  ensureNotAborted(signal)
  const timeout = resolveMcpRequestTimeoutMs(timeoutMs)
  return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) }
}

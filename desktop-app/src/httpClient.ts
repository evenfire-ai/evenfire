import { config } from './config.js'

export class ApiError extends Error {
  status: number
  bodyText: string

  constructor(message: string, status: number, bodyText: string) {
    super(message)
    this.status = status
    this.bodyText = bodyText
  }
}

const TRANSIENT_RETRY_DELAY_MS = 250

/**
 * Wrap an optional caller signal with the app-wide client timeout
 * (`config.requestTimeoutMs`, 60s). Exported so the raw-`fetch` methods in
 * `rpcProxyClient` (sessions/approvals/cancel) get the SAME client-side bound as
 * every `requestJson` call — a hung rpc-proxy no longer leaves them pending
 * forever (spec-v2 §4.5-6 / GAP-D3).
 *
 * Built on `AbortSignal.timeout` (matching `authClient.ts`) rather than a manual
 * `setTimeout`: the runtime owns the timer (unref'd, self-collected once the
 * signal is unreachable), so there is no owned handle to leak on the happy path,
 * AND — unlike a `clearTimeout`-on-fetch-settle wrapper — the bound stays armed
 * through the FULL request lifecycle, covering a rpc-proxy that streams headers
 * then stalls the response body (security review, M8 follow-up).
 */
export function withTimeout(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
  // A caller may pass a longer per-call deadline (e.g. GFS uploads) than the
  // app-wide default; fall back to config.requestTimeoutMs otherwise.
  const effectiveTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : config.requestTimeoutMs
  const timeout = AbortSignal.timeout(effectiveTimeoutMs)
  if (!signal) return timeout
  // Abort on whichever fires first (caller cancellation OR timeout).
  return AbortSignal.any([signal, timeout])
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; cause?: { code?: unknown } }
  return String(record.cause?.code || record.code || '')
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; message?: unknown }
  const name = String(record.name || '')
  const message = String(record.message || '').toLowerCase()
  return name === 'AbortError' || message.includes('aborted')
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof ApiError || isAbortError(error)) {
    return false
  }

  const code = getErrorCode(error)
  if (
    code === 'ECONNRESET' ||
    // Local port-forwards can briefly refuse a socket while kubectl tears down
    // and rebinds the local listener. Retry that case once, then surface the
    // error normally if the endpoint is still unavailable.
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return (
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('network error')
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function requestJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'HEAD' | 'DELETE',
  url: string,
  options?: {
    token?: string
    body?: unknown
    headers?: Record<string, string>
    signal?: AbortSignal
    /** Per-call deadline override (ms); defaults to config.requestTimeoutMs. */
    timeoutMs?: number
    retryTransientOnce?: boolean
  }
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options?.headers ?? {}),
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }

  const performRequest = async (): Promise<T> => {
    const response = await fetch(url, {
      method,
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      signal: withTimeout(options?.signal, options?.timeoutMs),
    })

    const raw = await response.text()
    if (!response.ok) {
      let msg = raw || response.statusText
      try {
        const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown }
        if (parsed.error) msg = String(parsed.error)
        if (parsed.message) msg = `${msg} - ${String(parsed.message)}`
      } catch {
        // Keep raw text as message.
      }
      throw new ApiError(`${response.status} ${response.statusText}: ${msg}`, response.status, raw)
    }

    if (!raw) return {} as T
    return JSON.parse(raw) as T
  }

  try {
    return await performRequest()
  } catch (error) {
    if (!options?.retryTransientOnce || !isTransientNetworkError(error)) {
      throw error
    }
    await sleep(TRANSIENT_RETRY_DELAY_MS)
    return performRequest()
  }
}

// G1-7 (#720): the fetch failures that prove no live control-plane process
// received the request. Each one fails before a connection exists (refused,
// DNS, unreachable network, connect timeout), which is what a Service with no
// ready endpoint produces during a cluster restart. A reset, a read timeout or
// a failure after the response started may have reached a live process, so
// they are not in this set. The proxies keep the same set in their own
// `controlApiClient.ts` (#799 tracks the duplication).
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

// The code undici puts on a failed fetch's cause. Only a code-shaped string is
// returned, so nothing else from the error can reach a message or a log.
export function fetchCauseCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const cause: unknown = (err as { cause?: unknown }).cause
  if (typeof cause !== 'object' || cause === null) return undefined
  const code: unknown = (cause as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined
}

// True only for a fetch rejection the caller did not cause: once the caller's
// signal aborted, the rejection belongs to the abort whatever its code says.
export function isConnectPhaseFailure(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted || !(err instanceof TypeError)) return false
  const code = fetchCauseCode(err)
  return code !== undefined && CONNECT_PHASE_CODES.has(code)
}

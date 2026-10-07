import { withAbort } from '../core/adapters/abortableLlmPort'

/**
 * G1-9 (#720): the longest Retry-After a subscription provider waits before its
 * single retry of a 429. Longer advice is thrown as `RateLimited`, so failover
 * and its cooldown decide instead of the turn being held open.
 */
export const RATE_LIMIT_RETRY_MAX_WAIT_MS = 30_000

/**
 * The wait before the single retry of a proxy or authorize error, or
 * `undefined` when it is not retried: only a `rate_limited` that carried a
 * Retry-After greater than zero and within
 * {@link RATE_LIMIT_RETRY_MAX_WAIT_MS}. A non-positive value is treated as
 * absent, like any other invalid Retry-After. `control_plane_unavailable` and
 * every other code are never retried here.
 */
export function rateLimitRetryDelayMs(
  code: string,
  retryAfterMs: number | undefined
): number | undefined {
  return code === 'rate_limited' ? boundedRetryDelayMs(retryAfterMs) : undefined
}

/**
 * The wait before the single retry of an authorize error: a `rate_limited`
 * as in {@link rateLimitRetryDelayMs}, or control-api's
 * `authorize_capacity_exceeded` with its Retry-After, on the same bound.
 * Nothing was read or recorded for that refusal, so the retry stays with the
 * same provider; a second refusal is terminal and never fails over.
 */
export function authorizeRetryDelayMs(
  code: string,
  retryAfterMs: number | undefined
): number | undefined {
  return code === 'rate_limited' || code === 'authorize_capacity_exceeded'
    ? boundedRetryDelayMs(retryAfterMs)
    : undefined
}

function boundedRetryDelayMs(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined) return undefined
  return retryAfterMs > 0 && retryAfterMs <= RATE_LIMIT_RETRY_MAX_WAIT_MS ? retryAfterMs : undefined
}

/** Waits `ms`; an abort of `signal` rejects at once with the abort reason. */
export function waitBeforeRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = () =>
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
  if (!signal) return wait()
  return withAbort(wait, signal).finally(() => clearTimeout(timer))
}

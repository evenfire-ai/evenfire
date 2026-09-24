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
 * Retry-After within
 * {@link RATE_LIMIT_RETRY_MAX_WAIT_MS}. `control_plane_unavailable` and every
 * other code are never retried here.
 */
export function rateLimitRetryDelayMs(
  code: string,
  retryAfterMs: number | undefined
): number | undefined {
  if (code !== 'rate_limited' || retryAfterMs === undefined) return undefined
  return retryAfterMs <= RATE_LIMIT_RETRY_MAX_WAIT_MS ? retryAfterMs : undefined
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

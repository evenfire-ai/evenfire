import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'
import { isRateLimited, parseHttpStatus, parseRetryAfterSeconds } from './gfsGrantErrors'

export const GFS_AUTHORITY_STALE_TIME_MS = 15_000
export const GFS_ROW_PRESENTATION_CACHE_MS = 60_000

const UNKNOWN_RATE_LIMIT_PAUSE_MS = 60_000
const MAX_RATE_LIMIT_PAUSE_MS = 60_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rateLimitPauseMs(error: unknown): number {
  const message = errorMessage(error)
  const status = parseHttpStatus(message)
  if (status !== 429 && !isRateLimited(message)) return 0
  const retryAfterSeconds = parseRetryAfterSeconds(message)
  return retryAfterSeconds === null
    ? UNKNOWN_RATE_LIMIT_PAUSE_MS
    : Math.min(retryAfterSeconds * 1_000, MAX_RATE_LIMIT_PAUSE_MS)
}

export function gfsAuthorityRetryPauseRemainingMs(
  error: unknown,
  errorUpdatedAt: number,
  now = Date.now()
): number {
  const pauseMs = rateLimitPauseMs(error)
  return pauseMs > 0 ? Math.max(0, errorUpdatedAt + pauseMs - now) : 0
}

/** Keeps explicit retry controls inside the same bounded 429 recovery window. */
export function assertGfsAuthorityRetryAllowed(queryClient: QueryClient, queryKey: QueryKey): void {
  const state = queryClient.getQueryState(queryKey)
  const remainingMs = gfsAuthorityRetryPauseRemainingMs(state?.error, state?.errorUpdatedAt ?? 0)
  if (remainingMs <= 0) return
  const seconds = Math.ceil(remainingMs / 1_000)
  throw new Error(`429 Too Many Requests retryAfterSeconds=${seconds}`)
}

/**
 * Resource authority is stale after the shared freshness window. If the last
 * active read was rate limited, wait for its bounded server window before a
 * focus-driven or explicit user retry.
 */
export function refetchGfsAuthorityOnWindowFocus<
  TQueryFnData = unknown,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(query: Query<TQueryFnData, TError, TData, TQueryKey>): boolean {
  const error = query.state.error
  if (!error) return true
  return gfsAuthorityRetryPauseRemainingMs(error, query.state.errorUpdatedAt) === 0
}

export const gfsAuthorityQueryPolicy = {
  staleTime: GFS_AUTHORITY_STALE_TIME_MS,
  refetchOnMount: true,
  refetchOnWindowFocus: refetchGfsAuthorityOnWindowFocus,
  retry: false,
} as const

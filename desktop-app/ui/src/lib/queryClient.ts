import { QueryClient, type QueryKey } from '@tanstack/react-query'

/**
 * Production query defaults. Exported so tests can exercise GFS behavior
 * under the REAL cache policy (Infinity staleTime, no background refetches)
 * instead of a looser harness default.
 */
export const desktopQueryDefaults = {
  queries: {
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  },
} as const

export const desktopQueryClient = new QueryClient({
  defaultOptions: desktopQueryDefaults,
})

/**
 * Cache-age read for app-coordinated (`enabled:false`) queries, evaluated at
 * call time so timer/focus callbacks never act on a render snapshot. A fetch
 * already in flight counts as fresh (it is about to land, and must not be
 * duplicated); a query with no data (never loaded, or removed by an identity
 * `reset`) is stale.
 */
export function isQueryOlderThan(
  queryClient: QueryClient,
  queryKey: QueryKey,
  maxAgeMs: number
): boolean {
  const state = queryClient.getQueryState(queryKey)
  if (state?.fetchStatus === 'fetching') return false
  if (!state || state.dataUpdatedAt <= 0) return true
  return Date.now() - state.dataUpdatedAt >= maxAgeMs
}

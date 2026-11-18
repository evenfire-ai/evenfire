import { QueryClient } from '@tanstack/react-query'

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

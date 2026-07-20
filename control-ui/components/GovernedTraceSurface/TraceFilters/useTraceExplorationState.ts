'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  buildTraceExplorationUrl,
  parseTraceExplorationState,
  traceApiQuery,
  traceExplorationStateKey,
} from '@lib/governedTraceFilters'
import type { TraceExplorationFamily, TraceExplorationState } from '@lib/governedTraceFilters'

export function useTraceExplorationState(family: TraceExplorationFamily, boundaryEpoch = 0) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchParamsValue = searchParams.toString()
  const state = useMemo(
    () => parseTraceExplorationState(new URLSearchParams(searchParamsValue), family),
    [family, searchParamsValue]
  )
  const stateKey = traceExplorationStateKey(state)
  const boundary = useMemo(() => traceApiQuery(state), [boundaryEpoch, state])
  const updateState = useCallback(
    (next: TraceExplorationState) => {
      router.replace(buildTraceExplorationUrl(pathname, next), { scroll: false })
    },
    [pathname, router]
  )

  return {
    apiQuery: boundary.query,
    invalidRange: boundary.error,
    state,
    stateKey,
    updateState,
  }
}

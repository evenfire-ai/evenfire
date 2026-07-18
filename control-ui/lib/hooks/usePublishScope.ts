'use client'

import { useEffect, useState } from 'react'
import { type PublishScope, getPublishScope, isSilentApiError } from '../api'

export type PublishScopeState = {
  scope: PublishScope | null
  loading: boolean
  error: boolean
}

/**
 * Resolve the caller's registry publish scope once on mount. Used to gate the
 * Publisher sidebar entry and view. Fails CLOSED: while loading, on a hard
 * error, or on a curator / org-unbound scope, the Publisher surface stays
 * hidden. A silent 401 (session expiry) is left to the global auth handler.
 */
export function usePublishScope(): PublishScopeState {
  const [state, setState] = useState<PublishScopeState>({
    scope: null,
    loading: true,
    error: false,
  })

  useEffect(() => {
    let cancelled = false
    getPublishScope()
      .then(scope => {
        if (!cancelled) setState({ scope, loading: false, error: false })
      })
      .catch(err => {
        if (cancelled || isSilentApiError(err)) return
        setState({ scope: null, loading: false, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

/**
 * Publisher is available only for an org-bound, non-curator deploy, and only
 * when the control-api hasn't explicitly disabled the Publisher UI surface
 * (self-hosted deployments default this off). `publisherUiEnabled` absent —
 * an older control-api that doesn't send the field — is treated as enabled,
 * preserving today's behavior.
 */
export function isPublisherEnabled(
  scope: PublishScope | null
): scope is PublishScope & { scope: string } {
  return !!scope && !scope.curator && scope.scope !== null && scope.publisherUiEnabled !== false
}

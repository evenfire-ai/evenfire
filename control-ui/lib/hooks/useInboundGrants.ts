'use client'

import { useCallback, useEffect, useState } from 'react'
import { type GrantedToMeItem, isSilentApiError, listGrantedToMe } from '../api'

export type InboundGrantsStatus = 'loading' | 'available' | 'unavailable' | 'error'

export type InboundGrantsState = {
  status: InboundGrantsStatus
  grants: GrantedToMeItem[]
  reload: () => void
}

/**
 * Fetch the org's inbound cross-org grants once on mount.
 *
 * `unavailable` is a 403: the deployment's registry client is not provisioned to
 * list grants (self-hosted connect tenants get read/publish scopes but not
 * `registry:grant`). Grant *listing* is a hosted/curator surface — but plugins
 * shared with the org still appear in the Marketplace catalog and install
 * normally, so this is a missing convenience list, not a broken feature. The
 * Publisher hides the "Shared with me" tab in that case (see PublisherView).
 * `error` is a transient failure (retryable via `reload`). A silent 401
 * (session expiry) is left to the global auth handler.
 */
export function useInboundGrants(): InboundGrantsState {
  const [status, setStatus] = useState<InboundGrantsStatus>('loading')
  const [grants, setGrants] = useState<GrantedToMeItem[]>([])
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    listGrantedToMe()
      .then(({ grants: rows }) => {
        if (cancelled) return
        setGrants(rows)
        setStatus('available')
      })
      .catch(err => {
        if (cancelled || isSilentApiError(err)) return
        setStatus((err as { status?: number }).status === 403 ? 'unavailable' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { status, grants, reload }
}

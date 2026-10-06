'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { METADATA_READ_MAX_RECOVERY_ATTEMPTS } from '@constants/readRequests'
import type { ApiRequestError } from '../api.types'
import {
  getReadRequestPrincipal,
  getReadRequestSessionIdentity,
  scheduleReadRequestRetry,
  subscribeReadRequestSessionIdentity,
} from '../readRequestCache'
import {
  type SubscriptionCapabilities,
  loadSubscriptionCapabilities,
} from '../subscriptionCapabilities'

export type SubscriptionCapabilitiesState = {
  capabilities: SubscriptionCapabilities | null
  loading: boolean
  error: ApiRequestError | null
  retry: () => void
}

export function useSubscriptionCapabilities(
  options: { enabled?: boolean } = {}
): SubscriptionCapabilitiesState {
  const enabled = options.enabled ?? true
  const [capabilities, setCapabilities] = useState<SubscriptionCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiRequestError | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const requestRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const recoveryAttemptsRef = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Retry only re-runs the load. Forcing a refresh would discard a result that
  // another consumer's recovery already cached and spend a second read.
  const load = useCallback(async () => {
    if (!enabledRef.current) return
    const controller =
      controllerRef.current && !controllerRef.current.signal.aborted
        ? controllerRef.current
        : new AbortController()
    controllerRef.current = controller
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await loadSubscriptionCapabilities({ signal: controller.signal })
      if (controller.signal.aborted || requestRef.current !== requestId) return
      setCapabilities(next)
      recoveryAttemptsRef.current = 0
    } catch (err) {
      if (controller.signal.aborted || requestRef.current !== requestId) return
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'AuthExpiredError'))
        return
      setError(err as ApiRequestError)
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [])

  // The confirmed principal. When it changes, the previous session's result,
  // error and recovery budget are dropped and the new session loads its own.
  // With no confirmed principal (before the first /me, or after a session
  // ended) the hook waits, loading, for /me to confirm one: an unconfirmed
  // read could neither be cached nor share the family's quota coordination.
  const sessionIdentity = useSyncExternalStore(
    subscribeReadRequestSessionIdentity,
    getReadRequestSessionIdentity,
    () => 0
  )
  const sessionIdentityRef = useRef(sessionIdentity)

  useEffect(() => {
    if (sessionIdentityRef.current !== sessionIdentity) {
      sessionIdentityRef.current = sessionIdentity
      setCapabilities(null)
      setError(null)
      recoveryAttemptsRef.current = 0
    }
    if (!enabled) {
      requestRef.current += 1
      controllerRef.current?.abort()
      setLoading(false)
      return
    }
    // Retry cannot load for an unconfirmed session; only /me can end the wait.
    if (getReadRequestPrincipal() === null) {
      requestRef.current += 1
      controllerRef.current?.abort()
      setLoading(true)
      return
    }
    void load()
    return () => {
      requestRef.current += 1
      controllerRef.current?.abort()
    }
  }, [enabled, load, retryNonce, sessionIdentity])

  useEffect(() => {
    if (
      !enabled ||
      error?.status !== 429 ||
      recoveryAttemptsRef.current >= METADATA_READ_MAX_RECOVERY_ATTEMPTS
    )
      return
    return scheduleReadRequestRetry(error, () => {
      recoveryAttemptsRef.current += 1
      void load()
    })
  }, [enabled, error, load])

  const retry = useCallback(() => {
    recoveryAttemptsRef.current = 0
    setRetryNonce(value => value + 1)
  }, [])

  return useMemo(
    () => ({ capabilities, loading, error, retry }),
    [capabilities, error, loading, retry]
  )
}

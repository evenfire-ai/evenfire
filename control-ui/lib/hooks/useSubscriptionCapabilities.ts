'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  METADATA_READ_MAX_RECOVERY_ATTEMPTS,
  METADATA_READ_UNTIMED_COOLDOWN_MS,
} from '@constants/readRequests'
import type { ApiRequestError } from '../api.types'
import {
  getReadRequestPrincipal,
  getReadRequestSessionIdentity,
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
  // error and recovery budget are dropped and the new session loads its own;
  // with no confirmed principal the hook waits, loading, for /me to confirm one.
  const sessionIdentity = useSyncExternalStore(
    subscribeReadRequestSessionIdentity,
    getReadRequestSessionIdentity,
    () => 0
  )
  const sessionIdentityRef = useRef(sessionIdentity)
  // Set when the session this consumer loaded for ended without a successor;
  // Retry cannot load for an unconfirmed session, only /me can end the wait.
  const sessionEndedRef = useRef(false)

  useEffect(() => {
    if (sessionIdentityRef.current !== sessionIdentity) {
      sessionIdentityRef.current = sessionIdentity
      setCapabilities(null)
      setError(null)
      recoveryAttemptsRef.current = 0
      sessionEndedRef.current = getReadRequestPrincipal() === null
    }
    if (!enabled) {
      requestRef.current += 1
      controllerRef.current?.abort()
      setLoading(false)
      return
    }
    if (sessionEndedRef.current) {
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
    const retryAtMs = error.retryAtMs ?? Date.now() + METADATA_READ_UNTIMED_COOLDOWN_MS
    const delay = Math.max(0, retryAtMs - Date.now())
    const timer = setTimeout(() => {
      recoveryAttemptsRef.current += 1
      void load()
    }, delay)
    return () => clearTimeout(timer)
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

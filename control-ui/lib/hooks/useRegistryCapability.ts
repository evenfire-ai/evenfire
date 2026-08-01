'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  type RegistryConnectionState,
  getPublishScope,
  getRegistryConnection,
  isSilentApiError,
} from '../api'
import { isPublisherEnabled } from './usePublishScope'

export type RegistryDeploymentMode = 'self-hosted' | 'managed' | 'unknown'

export type RegistryCapability = {
  orgName: string | null
  scope: string | null // '@org', or null for curator / unbound
  isCurator: boolean
  mode: RegistryDeploymentMode
  authEnabled: boolean
  connectionState: RegistryConnectionState | null
  /**
   * Org-owned management surfaces (publish, entry edit/remove, API keys) may
   * render. A self-hosted deploy must also have registry auth active; managed
   * deploys gate on publisher-UI enablement + scope alone.
   */
  canManageOrg: boolean
}

export type RegistryCapabilityState = {
  capability: RegistryCapability | null
  loading: boolean
  /** Transient failure of the publish-scope probe — safe to offer Retry (§5.1). */
  error: boolean
  reload: () => void
}

// Session-stable identity cache + in-flight de-duplication. The org/curator/
// connection signals do not change while the console is open, and refetching
// on every mount both flickered the org-tab label ("Your org" → "@org") and
// fanned out getRegistryConnection() calls from every component that reads
// capability — enough, with React StrictMode double-invoke, to trip the
// registry connect-status rate limit (30/min). The first resolve populates the
// cache; concurrent mounts share one in-flight request; reload() clears both.
let capabilityCache: RegistryCapability | null = null
let inflight: Promise<RegistryCapability> | null = null

async function loadCapability(): Promise<RegistryCapability> {
  // Connection probe is soft: resolve to a mode + auth state, never reject.
  const connection = getRegistryConnection().then(
    status => ({
      mode: 'self-hosted' as RegistryDeploymentMode,
      authEnabled: status.authEnabled === true,
      connectionState: status.state as RegistryConnectionState | null,
    }),
    err => ({
      mode: ((err as { code?: unknown }).code === 'not_self_hosted'
        ? 'managed'
        : 'unknown') as RegistryDeploymentMode,
      authEnabled: false,
      connectionState: null as RegistryConnectionState | null,
    })
  )
  const [scope, conn] = await Promise.all([getPublishScope(), connection])
  const managed = conn.mode === 'managed'
  const next: RegistryCapability = {
    orgName: scope.orgName,
    scope: scope.scope,
    isCurator: scope.curator,
    mode: conn.mode,
    authEnabled: conn.authEnabled,
    connectionState: conn.connectionState,
    canManageOrg: isPublisherEnabled(scope) && (managed || conn.authEnabled),
  }
  capabilityCache = next
  return next
}

function sharedLoad(): Promise<RegistryCapability> {
  if (!inflight) {
    inflight = loadCapability().finally(() => {
      inflight = null
    })
  }
  return inflight
}

/** Test hook: drop the module cache + in-flight request so each test is isolated. */
export function __resetRegistryCapabilityCacheForTests(): void {
  capabilityCache = null
  inflight = null
}

/**
 * Compose the two capability probes the registry redesign renders controls from
 * (design spec §5.1: render from capability, not role guesses).
 *
 * - `getPublishScope()` is authoritative for identity (org, curator) and is the
 *   retryable signal — a hard failure here surfaces as `error` so the caller can
 *   offer Retry.
 * - `getRegistryConnection()` gives deployment mode + auth state. It fails OPEN:
 *   `not_self_hosted` (409) means managed; any other failure leaves `mode`
 *   'unknown' and never blocks the identity signal.
 *
 * A silent 401 (session expiry) is left to the global auth handler.
 */
export function useRegistryCapability(): RegistryCapabilityState {
  const [capability, setCapability] = useState<RegistryCapability | null>(capabilityCache)
  const [loading, setLoading] = useState(capabilityCache === null)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => {
    capabilityCache = null
    inflight = null
    setNonce(n => n + 1)
  }, [])

  useEffect(() => {
    // Serve the session-stable identity synchronously when we already have it,
    // so the org-tab label doesn't flicker and no request is made.
    if (capabilityCache && nonce === 0) {
      setCapability(capabilityCache)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    sharedLoad().then(
      next => {
        if (cancelled) return
        setCapability(next)
        setLoading(false)
      },
      err => {
        if (cancelled || isSilentApiError(err)) return
        setError(true)
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { capability, loading, error, reload }
}

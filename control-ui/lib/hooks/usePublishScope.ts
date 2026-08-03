'use client'

import type { ReactNode } from 'react'
import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react'
import { type PublishScope, getPublishScope, isSilentApiError } from '../api'

export type PublishScopeState = {
  scope: PublishScope | null
  loading: boolean
  error: boolean
}

const EMPTY_STATE: PublishScopeState = {
  scope: null,
  loading: true,
  error: false,
}

const PublishScopeContext = createContext<PublishScopeState | null>(null)
const resolvedScopes = new Map<string, PublishScope>()
const pendingScopes = new Map<string, Promise<PublishScope>>()

function requestPublishScope(cacheKey: string): Promise<PublishScope> {
  const resolved = resolvedScopes.get(cacheKey)
  if (resolved) return Promise.resolve(resolved)

  const pending = pendingScopes.get(cacheKey)
  if (pending) return pending

  const request = getPublishScope()
    .then(scope => {
      resolvedScopes.set(cacheKey, scope)
      return scope
    })
    .finally(() => {
      pendingScopes.delete(cacheKey)
    })
  pendingScopes.set(cacheKey, request)
  return request
}

export function resetPublishScopeCache(cacheKey?: string): void {
  if (cacheKey) {
    resolvedScopes.delete(cacheKey)
    pendingScopes.delete(cacheKey)
    return
  }
  resolvedScopes.clear()
  pendingScopes.clear()
}

export function PublishScopeProvider({
  cacheKey,
  children,
}: {
  cacheKey: string
  children: ReactNode
}) {
  const cachedScope = cacheKey ? resolvedScopes.get(cacheKey) : undefined
  const [state, setState] = useState<PublishScopeState>(() =>
    cachedScope ? { scope: cachedScope, loading: false, error: false } : EMPTY_STATE
  )

  useEffect(() => {
    let cancelled = false
    if (!cacheKey) {
      setState(EMPTY_STATE)
      return
    }

    const nextCachedScope = resolvedScopes.get(cacheKey)
    if (nextCachedScope) {
      setState({ scope: nextCachedScope, loading: false, error: false })
      return
    }

    setState(EMPTY_STATE)
    void requestPublishScope(cacheKey)
      .then(scope => {
        if (!cancelled) setState({ scope, loading: false, error: false })
      })
      .catch(error => {
        if (cancelled || isSilentApiError(error)) return
        setState({ scope: null, loading: false, error: true })
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey])

  const value = useMemo(() => state, [state])
  return createElement(PublishScopeContext.Provider, { value }, children)
}

/**
 * Read the persistent caller scope shared by the sidebar and Publisher views.
 * It fails closed while loading or when the provider reports an error.
 */
export function usePublishScope(): PublishScopeState {
  const state = useContext(PublishScopeContext)
  return state ?? EMPTY_STATE
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

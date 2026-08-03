'use client'

import type { ReactNode } from 'react'
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type PublishScope, getPublishScope, isSilentApiError } from '../api'

type RefreshOptions = { force?: boolean }

type PublishScopeSnapshot = {
  scope: PublishScope | null
  loading: boolean
  error: boolean
}

export type PublishScopeState = PublishScopeSnapshot & {
  refresh: (options?: RefreshOptions) => Promise<PublishScope | null>
}

const EMPTY_SNAPSHOT: PublishScopeSnapshot = {
  scope: null,
  loading: true,
  error: false,
}

const EMPTY_STATE: PublishScopeState = {
  ...EMPTY_SNAPSHOT,
  refresh: async () => null,
}

const PublishScopeContext = createContext<PublishScopeState | null>(null)
type PublishScopeCacheEntry = {
  request?: Promise<PublishScope | null>
  scope?: PublishScope
}

const scopeCache = new Map<string, PublishScopeCacheEntry>()

function entryFor(cacheKey: string): PublishScopeCacheEntry {
  const cached = scopeCache.get(cacheKey)
  if (cached) return cached
  const next: PublishScopeCacheEntry = {}
  scopeCache.set(cacheKey, next)
  return next
}

function requestPublishScope(
  cacheKey: string,
  options: RefreshOptions = {}
): Promise<PublishScope | null> {
  let entry = entryFor(cacheKey)
  if (options.force) {
    entry = {}
    scopeCache.set(cacheKey, entry)
  }

  if (!options.force && entry.scope) return Promise.resolve(entry.scope)
  if (entry.request) return entry.request

  const request = getPublishScope()
    .then(scope => {
      const liveEntry = scopeCache.get(cacheKey) === entry
      if (liveEntry) {
        entry.scope = scope
      }
      return liveEntry ? scope : null
    })
    .finally(() => {
      if (scopeCache.get(cacheKey) === entry && entry.request === request) {
        delete entry.request
      }
    })
  entry.request = request
  return request
}

export function resetPublishScopeCache(cacheKey?: string): void {
  if (cacheKey) {
    scopeCache.delete(cacheKey)
    return
  }
  scopeCache.clear()
}

export function PublishScopeProvider({
  cacheKey,
  children,
}: {
  cacheKey: string
  children: ReactNode
}) {
  const cachedScope = cacheKey ? scopeCache.get(cacheKey)?.scope : undefined
  const [state, setState] = useState<PublishScopeSnapshot>(() =>
    cachedScope ? { scope: cachedScope, loading: false, error: false } : EMPTY_SNAPSHOT
  )
  const requestSequenceRef = useRef(0)

  const refresh = useCallback(
    async (options: RefreshOptions = {}) => {
      const requestSequence = ++requestSequenceRef.current
      if (!cacheKey) {
        setState(EMPTY_SNAPSHOT)
        return null
      }

      const nextCachedScope = options.force ? undefined : scopeCache.get(cacheKey)?.scope
      if (nextCachedScope) {
        setState({ scope: nextCachedScope, loading: false, error: false })
        return nextCachedScope
      }

      setState(EMPTY_SNAPSHOT)
      try {
        const scope = await requestPublishScope(cacheKey, options)
        if (requestSequenceRef.current === requestSequence) {
          setState({ scope, loading: false, error: false })
        }
        return scope
      } catch (error) {
        if (requestSequenceRef.current === requestSequence) {
          setState({ scope: null, loading: false, error: !isSilentApiError(error) })
        }
        return null
      }
    },
    [cacheKey]
  )

  useEffect(() => {
    void refresh()

    return () => {
      requestSequenceRef.current += 1
    }
  }, [refresh])

  const value = useMemo(() => ({ ...state, refresh }), [refresh, state])
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

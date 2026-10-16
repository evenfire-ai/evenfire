import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthContext } from '@contexts/AuthContext'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsDragSessionApi, GfsDragSource } from './dragSession.types'

/**
 * Per-session drag coordinator (rev-2 §4): exactly one active in-window
 * source, held in refs (dragover never re-renders the tree). The store is
 * bound to the live session scope and the SHARED access-state query, so a
 * logout, env/user/team switch or a definite lifecycle rejection clears the
 * drag. Payload identity is the in-window descriptor; generations only
 * discard stale async callbacks — they are not credentials or a wire registry.
 */
export class GfsDragSessionStore implements GfsDragSessionApi {
  private active: GfsDragSource | null = null
  private generation = 0
  private boundScope: string | null = null

  beginDrag(source: Omit<GfsDragSource, 'generation'>): boolean {
    if (this.active) return false
    this.generation += 1
    this.active = { ...source, generation: this.generation }
    this.boundScope = source.scope
    return true
  }

  endDrag(): void {
    this.active = null
  }

  activeSource(): GfsDragSource | null {
    return this.active
  }

  matchesScope(scope: string | null): boolean {
    return this.active !== null && scope !== null && this.boundScope === scope
  }

  invalidate(): void {
    this.active = null
    // Bump so in-flight callbacks captured against an older generation are
    // discarded by their owners (`source.generation !== activeSource()`).
    this.generation += 1
  }

  currentGeneration(): number {
    return this.generation
  }
}

const GfsDragSessionContext = createContext<GfsDragSessionApi | null>(null)

function sessionScopeOf(auth: {
  isAuthenticated: boolean
  me: { id: string; teamId: string | null } | null
  runtimeConfigState: { envKey: string } | null
}): string | null {
  const envKey = auth.runtimeConfigState?.envKey ?? ''
  return auth.isAuthenticated && auth.me
    ? `${envKey}:${auth.me.id}:${auth.me.teamId ?? ''}`
    : null
}

export function GfsDragSessionProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<GfsDragSessionStore | null>(null)
  if (!storeRef.current) storeRef.current = new GfsDragSessionStore()
  const store = storeRef.current

  const { isAuthenticated, me, runtimeConfigState } = useAuthContext()
  const scope = useMemo(
    () => sessionScopeOf({ isAuthenticated, me, runtimeConfigState }),
    [isAuthenticated, me, runtimeConfigState]
  )

  // Bind lifecycle: scope change or a revoked shared access state clears the
  // active drag. The access state is written by ANY controller mount's
  // fail-closed boundary via setQueryData; this is the same pure-subscription
  // pattern the controller uses (never fetches — a cold cache must not invent
  // a revocation, and 'active' is the safe default while nothing wrote yet).
  const accessStateQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAccessState(scope ?? 'anonymous'),
    queryFn: () => 'active' as const,
    enabled: false,
    initialData: 'active' as const,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState = accessStateQuery.data ?? 'active'

  useEffect(() => {
    if (scope === null || accessState === 'revoked') store.invalidate('authority')
  }, [accessState, scope, store])

  useEffect(() => () => store.invalidate('authority'), [store])

  const api = useMemo<GfsDragSessionApi>(
    () => ({
      beginDrag: source => {
        if (scope === null || accessState !== 'active') return false
        return store.beginDrag(source)
      },
      endDrag: () => store.endDrag(),
      activeSource: () => store.activeSource(),
      matchesScope: candidate => store.matchesScope(candidate),
      invalidate: reason => store.invalidate(reason),
    }),
    [accessState, scope, store]
  )

  return <GfsDragSessionContext.Provider value={api}>{children}</GfsDragSessionContext.Provider>
}

/** Returns the session-scoped drag coordinator, or null outside the provider. */
export function useGfsDragSession(): GfsDragSessionApi | null {
  return useContext(GfsDragSessionContext)
}

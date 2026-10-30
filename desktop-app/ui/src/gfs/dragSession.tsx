import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useQuery } from '@tanstack/react-query'
import { DRAG_COLD_CHECK_BUDGET, DRAG_COLD_CHECK_MAX_CONCURRENCY } from '@constants/gfsBrowser'
import { desktopQueryKeys, isGfsSessionGeneration } from '@hooks/domain/queryKeys'
import type { GfsDragSessionApi, GfsDragSource, GfsHoverCheckLease } from './dragSession.types'

type GfsAccessState = 'active' | 'revoked'

/** Same lease rules for shared gestures and provider-absent single-surface mode. */
export class GfsHoverCheckBudget {
  private ledger = { generation: -1, dispatched: 0, inFlight: 0 }

  beginCheck(
    expectedGeneration: number,
    currentGeneration: number,
    active: boolean
  ): GfsHoverCheckLease | null {
    if (!active || expectedGeneration !== currentGeneration) return null
    if (this.ledger.generation !== currentGeneration) {
      this.ledger = { generation: currentGeneration, dispatched: 0, inFlight: 0 }
    }
    const ledger = this.ledger
    if (
      ledger.dispatched >= DRAG_COLD_CHECK_BUDGET ||
      ledger.inFlight >= DRAG_COLD_CHECK_MAX_CONCURRENCY
    )
      return null
    ledger.dispatched += 1
    ledger.inFlight += 1
    let completed = false
    return {
      complete: () => {
        if (completed) return
        completed = true
        if (this.ledger === ledger) ledger.inFlight -= 1
      },
    }
  }
}

/**
 * Per-session drag coordinator (rev-2 §4): exactly one active in-window
 * source, held in refs (dragover never re-renders the tree). The store is
 * bound to the live session scope and the SHARED access-state query, so a
 * logout, env/user/team switch or a definite lifecycle rejection clears the
 * drag. A lost dragend must not outlive the next trusted gesture: a
 * same-session beginDrag SUPERSEDES the stale source with a new generation,
 * while a foreign-session gesture is still refused. Payload identity is the
 * in-window descriptor; generations only discard stale async callbacks — they
 * are not credentials or a wire registry.
 */
export class GfsDragSessionStore implements GfsDragSessionApi {
  private active: GfsDragSource | null = null
  private generation = 0
  private boundScope: string | null = null
  private hoverBudget = new GfsHoverCheckBudget()

  beginDrag(source: Omit<GfsDragSource, 'generation'>): boolean {
    if (this.active && this.boundScope !== source.scope) return false
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

  invalidate(_reason?: 'authority' | 'scope-change'): void {
    this.active = null
    // Bump so in-flight callbacks captured against an older generation are
    // discarded by their owners (`source.generation !== activeSource()`).
    this.generation += 1
  }

  currentGeneration(): number {
    return this.generation
  }

  beginHoverCheck(expectedGeneration: number): GfsHoverCheckLease | null {
    return this.hoverBudget.beginCheck(expectedGeneration, this.generation, this.active !== null)
  }
}

export type {
  GfsDragSource,
  GfsDropDecision,
  GfsDropRejection,
  GfsDropVerdict,
} from './dragSession.types'

const GfsDragSessionContext = createContext<GfsDragSessionApi | null>(null)

function sessionScopeOf(auth: {
  isAuthenticated: boolean
  me: { id: string; teamId: string | null } | null
  runtimeConfigState: { envKey: string } | null
}): string | null {
  const envKey = auth.runtimeConfigState?.envKey ?? ''
  return auth.isAuthenticated && auth.me ? `${envKey}:${auth.me.id}:${auth.me.teamId ?? ''}` : null
}

export function GfsDragSessionProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<GfsDragSessionStore | null>(null)
  if (!storeRef.current) storeRef.current = new GfsDragSessionStore()
  const store = storeRef.current

  const { isAuthenticated, me, runtimeConfigState, sessionGeneration } = useAuthContext()
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
    queryKey: desktopQueryKeys.gfsAccessState(scope ?? 'anonymous', sessionGeneration ?? null),
    queryFn: (): GfsAccessState => 'active',
    enabled: false,
    initialData: 'active' as GfsAccessState,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState: GfsAccessState = accessStateQuery.data ?? 'active'
  const previousAuthorityRef = useRef({ scope, generation: sessionGeneration ?? null })

  useEffect(() => {
    const scopeChanged = previousAuthorityRef.current.scope !== scope
    const generationChanged =
      previousAuthorityRef.current.generation !== (sessionGeneration ?? null)
    previousAuthorityRef.current = { scope, generation: sessionGeneration ?? null }
    // Native end may already have cleared the transport source while a drop
    // is pending. Every scope transition still invalidates its ownership.
    if (scopeChanged || generationChanged) store.invalidate('scope-change')
    else if (
      scope === null ||
      !isGfsSessionGeneration(sessionGeneration) ||
      accessState === 'revoked'
    ) {
      store.invalidate('authority')
    }
  }, [accessState, scope, sessionGeneration, store])

  useEffect(() => () => store.invalidate('authority'), [store])

  const api = useMemo<GfsDragSessionApi>(
    () => ({
      beginDrag: source => {
        if (
          scope === null ||
          !isGfsSessionGeneration(sessionGeneration) ||
          accessState !== 'active'
        )
          return false
        // A drag started under another env/user/team never crosses into this
        // session (foreign/other-window drags stay inert).
        if (source.scope !== scope) return false
        return store.beginDrag(source)
      },
      endDrag: () => store.endDrag(),
      activeSource: () => store.activeSource(),
      matchesScope: candidate => store.matchesScope(candidate),
      invalidate: reason => store.invalidate(reason),
      currentGeneration: () => store.currentGeneration(),
      beginHoverCheck: expectedGeneration => store.beginHoverCheck(expectedGeneration),
    }),
    [accessState, scope, sessionGeneration, store]
  )

  return <GfsDragSessionContext.Provider value={api}>{children}</GfsDragSessionContext.Provider>
}

/** Returns the session-scoped drag coordinator, or null outside the provider. */
export function useGfsDragSession(): GfsDragSessionApi | null {
  return useContext(GfsDragSessionContext)
}

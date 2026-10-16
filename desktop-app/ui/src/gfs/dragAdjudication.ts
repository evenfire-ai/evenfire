import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { decideDragAuthority, decideDragStructure } from '@clerum/gfs-interaction-policy'
import { DRAG_COLD_CHECK_BUDGET, DRAG_COLD_CHECK_DEBOUNCE_MS } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { describeGfsReadError, parseHttpStatus } from '@lib/gfsGrantErrors'
import type {
  GfsDragSource,
  GfsDropDecision,
  GfsDropRejection,
  GfsDropTargetFact,
  GfsDropVerdict,
} from './dragSession.types'

/** At most two ancestor resolves on drop when cached structure cannot decide. */
const MAX_DROP_ANCESTOR_RESOLVES = 2
/** Mutation-intent affordance freshness (rev-2 cache decisions). */
const AFFORDANCES_HOVER_STALE_MS = 60_000
const AFFORDANCES_MUTATION_STALE_MS = 5_000

interface ResolvedLike {
  resourceId: string
  parentResourceId: string | null
  name: string
  version: number
}

export interface GfsDragAdjudicationDeps {
  scope: string | null
  drive: string
  /** Resolve by stable URI (read plane; 403/404/429 throw). */
  resolve: (gfsUri: string) => Promise<ResolvedLike>
}

interface HeldAffordances {
  held: string[]
}

type AffordancesProbe = { ok: true; held: string[] } | { ok: false; error: unknown }

/** Map a failed probe to a drop decision, or null when it should not decide. */
function unavailableDecision(error: unknown): GfsDropRejection | null {
  const status = parseHttpStatus(error instanceof Error ? error.message : String(error))
  if (status === 401) return { allowed: false, reason: 'session-lost' }
  if (status === 429) {
    return {
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(error).message,
    }
  }
  if (status === 404) {
    return {
      allowed: false,
      reason: 'target-unavailable',
      message: 'This folder is no longer available.',
    }
  }
  return null
}

/**
 * Hover/drop adjudication shared by the Files page and the sidebar explorer
 * (rev-2 §3, §4.1). Structure comes from loaded observations first (common
 * anchor / breadcrumb chains); authority comes from the SHARED TanStack
 * affordances keys — warm hover reads cache only, a cold target is debounced
 * and budgeted (≤ DRAG_COLD_CHECK_BUDGET per drag), and over-budget targets
 * stay "checking" and get a priority check on drop instead of a false deny.
 */
export function useGfsDragAdjudication(deps: GfsDragAdjudicationDeps) {
  const queryClient = useQueryClient()
  const coldChecksRef = useRef(0)
  const debounceTimerRef = useRef<number | null>(null)
  const inFlightRef = useRef(0)

  const readCachedAffordances = useCallback(
    (resourceId: string): HeldAffordances | null => {
      if (!deps.scope) return null
      return (
        queryClient.getQueryData<HeldAffordances>(
          desktopQueryKeys.gfsAffordances(deps.scope, resourceId, deps.drive)
        ) ?? null
      )
    },
    [deps.drive, deps.scope, queryClient]
  )

  const fetchAffordances = useCallback(
    async (resourceId: string, staleTime: number): Promise<AffordancesProbe> => {
      if (!deps.scope) return { ok: false, error: new Error('No active session scope') }
      try {
        const held = await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.gfsAffordances(deps.scope, resourceId, deps.drive),
          queryFn: () => window.clerum.gfs.affordances(resourceId, deps.drive),
          staleTime,
        })
        return { ok: true, held: held.held }
      } catch (error) {
        return { ok: false, error }
      }
    },
    [deps.drive, deps.scope, queryClient]
  )

  /** Warm hover verdict: cached structure + cached bits; ZERO network reads. */
  const hoverVerdict = useCallback(
    (source: GfsDragSource, target: GfsDropTargetFact): GfsDropVerdict => {
      if (target.kind !== 'directory') return { state: 'denied', reason: 'self' }
      const structure = decideDragStructure({
        source: {
          resourceId: source.resourceId,
          drive: source.drive,
          kind: source.kind,
          parentKnown: source.parentKnown,
          parentResourceId: source.parentResourceId,
        },
        target: { resourceId: target.resourceId, drive: source.drive },
        targetAncestorIds: target.ancestorIds,
        knownSourceAncestorIds: new Set(source.knownAncestorIds),
      })
      if (structure.kind === 'deny') {
        return { state: 'denied', reason: structure.reason }
      }
      const destinationHeld = readCachedAffordances(target.resourceId)
      const sourceParentHeld = source.parentKnown
        ? source.parentResourceId !== null
          ? readCachedAffordances(source.parentResourceId)
          : null
        : null
      if (destinationHeld === null || (source.parentKnown && sourceParentHeld === null)) {
        return { state: 'checking' }
      }
      const authority = decideDragAuthority({
        sourceParentHeld: sourceParentHeld?.held ?? null,
        destinationHeld: destinationHeld.held,
      })
      if (authority.kind === 'deny') return { state: 'denied', reason: authority.reason }
      if (authority.kind === 'observed-allowed' && structure.kind === 'observed-safe') {
        return { state: 'allowed' }
      }
      return { state: 'checking' }
    },
    [readCachedAffordances]
  )

  /**
   * Schedule one budgeted cold check for a hovered target: at most two
   * feature requests (destination + known source parent) run concurrently
   * after the dwell debounce; over-budget stays silent (drop performs the
   * priority check). No network resolves happen on hover.
   */
  const scheduleColdCheck = useCallback(
    (
      target: GfsDropTargetFact,
      sourceParentId: string | null,
      onComplete: () => void
    ) => {
      if (inFlightRef.current >= 2) return
      if (coldChecksRef.current >= DRAG_COLD_CHECK_BUDGET) return
      coldChecksRef.current += 1
      inFlightRef.current += 1
      if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null
        void (async () => {
          try {
            if (readCachedAffordances(target.resourceId) === null) {
              await fetchAffordances(target.resourceId, AFFORDANCES_HOVER_STALE_MS)
            }
            if (
              sourceParentId !== null &&
              readCachedAffordances(sourceParentId) === null
            ) {
              await fetchAffordances(sourceParentId, AFFORDANCES_HOVER_STALE_MS)
            }
            onComplete()
          } finally {
            inFlightRef.current -= 1
          }
        })()
      }, DRAG_COLD_CHECK_DEBOUNCE_MS)
    },
    [fetchAffordances, readCachedAffordances]
  )

  /** Reset the per-drag budget (new dragstart). */
  const beginDragSession = useCallback(() => {
    coldChecksRef.current = 0
    inFlightRef.current = 0
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const endDragSession = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  /**
   * Bounded upward continuation of the target's ancestor chain (rev-2 §3.1):
   * start from the oldest LOADED ancestor (or the target itself), resolve at
   * most MAX_DROP_ANCESTOR_RESOLVES parents upward, stop on the physical root
   * (null sentinel), a repetition, or a read 403/404 visibility boundary —
   * never treat an unreadable ancestor as missing move rights.
   */
  const resolveAncestorsUpTo = useCallback(
    async (source: GfsDragSource, target: GfsDropTargetFact): Promise<(string | null)[]> => {
      const chain: (string | null)[] = [...target.ancestorIds]
      const oldest = chain.length > 0 ? chain[chain.length - 1] : null
      if (oldest === null && chain.length > 0) return chain // already at root
      let nextIdToResolve: string = oldest ?? target.resourceId
      for (let step = 0; step < MAX_DROP_ANCESTOR_RESOLVES; step += 1) {
        const uri = `gfs://${source.drive}/${nextIdToResolve.replace(/-/g, '').toLowerCase()}`
        let parent: string | null
        try {
          const resolved = await deps.resolve(uri)
          parent = resolved.parentResourceId
        } catch (error) {
          const status = parseHttpStatus(error instanceof Error ? error.message : String(error))
          if (status === 403 || status === 404) return chain
          throw error
        }
        if (parent === null) {
          chain.push(null)
          return chain
        }
        if (chain.includes(parent)) return chain
        chain.push(parent)
        nextIdToResolve = parent
      }
      return chain
    },
    [deps]
  )

  /**
   * Priority drop admission (rev-2 §3): immutable facts → structure (loaded,
   * then ≤2 ancestor resolves for folders) → exact authority via fresh (5 s)
   * affordances → rename capability via source-resource write. Never denies on
   * an unproved structure; the atomic server PATCH is the backstop.
   */
  const adjudicateDrop = useCallback(
    async (source: GfsDragSource, target: GfsDropTargetFact): Promise<GfsDropDecision> => {
      if (target.kind !== 'directory') {
        return { allowed: false, reason: 'self', message: 'A folder destination is required.' }
      }
      const structureFacts = {
        source: {
          resourceId: source.resourceId,
          drive: source.drive,
          kind: source.kind,
          parentKnown: source.parentKnown,
          parentResourceId: source.parentResourceId,
        } as const,
        target: { resourceId: target.resourceId, drive: source.drive } as const,
      }
      let structure = decideDragStructure({
        ...structureFacts,
        targetAncestorIds: target.ancestorIds,
        knownSourceAncestorIds: new Set(source.knownAncestorIds),
      })
      if (structure.kind === 'server-check-required' && source.kind === 'directory') {
        try {
          const chain = await resolveAncestorsUpTo(source, target)
          structure = decideDragStructure({
            ...structureFacts,
            targetAncestorIds: chain,
            knownSourceAncestorIds: new Set(source.knownAncestorIds),
          })
        } catch {
          // Unreadable ancestry stays server-check-required; proceed below —
          // a read failure upward is a visibility boundary, not a denial.
        }
      }

      if (structure.kind === 'deny') {
        return { allowed: false, reason: structure.reason }
      }

      // Exact authority: destination write + source-parent write & delete.
      let sourceParentForProbe: string | null = source.parentKnown
        ? source.parentResourceId
        : null
      if (sourceParentForProbe === null) {
        try {
          const resolved = await deps.resolve(source.gfsUri)
          sourceParentForProbe = resolved.parentResourceId
        } catch (error) {
          const status = parseHttpStatus(error instanceof Error ? error.message : String(error))
          if (status === 401) return { allowed: false, reason: 'session-lost' }
          if (status === 404) {
            return {
              allowed: false,
              reason: 'source-location-unknown',
              message: 'EvenDrive cannot verify this item’s current location. Refresh and try again.',
            }
          }
          return {
            allowed: false,
            reason: 'unavailable',
            message: describeGfsReadError(error).message,
          }
        }
      }
      if (sourceParentForProbe === null) {
        // Physical root source.
        return { allowed: false, reason: 'root-source' }
      }

      const destinationProbe = await fetchAffordances(target.resourceId, AFFORDANCES_MUTATION_STALE_MS)
      if (!destinationProbe.ok) {
        const decision = unavailableDecision(destinationProbe.error)
        if (decision) return decision
      }
      const sourceParentProbe = await fetchAffordances(
        sourceParentForProbe,
        AFFORDANCES_MUTATION_STALE_MS
      )
      if (!sourceParentProbe.ok) {
        const decision = unavailableDecision(sourceParentProbe.error)
        if (decision) return decision
      }
      const authority = decideDragAuthority({
        destinationHeld: destinationProbe.ok ? destinationProbe.held : null,
        sourceParentHeld: sourceParentProbe.ok ? sourceParentProbe.held : null,
      })
      if (authority.kind === 'deny') return { allowed: false, reason: authority.reason }

      // Rename capability (not user consent): source-resource write proves a
      // combined rename+move; the folder confirmation records the opt-in.
      const sourceProbe = await fetchAffordances(source.resourceId, AFFORDANCES_MUTATION_STALE_MS)
      const canRename = sourceProbe.ok && sourceProbe.held.includes('write')

      return {
        allowed: true,
        allowNumberedRename: canRename,
        structure,
        authority: { kind: 'observed-allowed', checkedAt: Date.now() },
      }
    },
    [deps, fetchAffordances, resolveAncestorsUpTo]
  )

  /** Fresh (5 s) source-resource write probe for the rename policy. */
  const probeSourceWrite = useCallback(
    async (resourceId: string): Promise<boolean> => {
      const cached = readCachedAffordances(resourceId)
      if (cached?.held.includes('write')) return true
      const fresh = await fetchAffordances(resourceId, AFFORDANCES_MUTATION_STALE_MS)
      return fresh.ok && fresh.held.includes('write')
    },
    [fetchAffordances, readCachedAffordances]
  )

  return {
    hoverVerdict,
    scheduleColdCheck,
    beginDragSession,
    endDragSession,
    adjudicateDrop,
    probeSourceWrite,
    readCachedAffordances,
  }
}

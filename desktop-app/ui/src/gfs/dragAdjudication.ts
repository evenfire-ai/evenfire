import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { decideDragAuthority, decideDragStructure } from '@clerum/gfs-interaction-policy'
import { DRAG_COLD_CHECK_DEBOUNCE_MS } from '@constants/gfsBrowser'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import {
  describeGfsReadError,
  isGfsSessionAuthorityFailure,
  parseHttpStatus,
} from '@lib/gfsGrantErrors'
import { GfsHoverCheckBudget, useGfsDragSession } from './dragSession'
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
  sessionGeneration: number | null
  drive: string
  /** Resolve by stable URI (read plane; 403/404/429 throw). */
  resolve: (gfsUri: string) => Promise<ResolvedLike>
  /**
   * Central fail-closed classifier for the operation surface; returns true
   * when it revoked the session. A probe 401 is a SESSION failure, not a
   * per-resource policy verdict: the drop must be refused AND the session
   * revoked, otherwise observer-less views keep rendering a dead session's
   * data. Optional so a surface without an authority boundary still refuses
   * the drop.
   */
  handleAuthorityFailure?: (message: string, scope: string, sessionGeneration: number) => boolean
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
 * Required (admission-gating) probe failure: keep the mapped 401/429/404
 * semantics and fail CLOSED with a generic unavailable for every other
 * failure class (403, 5xx, transport). A required probe must positively
 * establish its bits before any confirmation or mutation is offered.
 */
function requiredProbeRejection(error: unknown): GfsDropRejection {
  return (
    unavailableDecision(error) ?? {
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(error).message,
    }
  )
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
  const session = useGfsDragSession()
  const authorityRef = useRef({ scope: deps.scope, generation: deps.sessionGeneration })
  authorityRef.current = { scope: deps.scope, generation: deps.sessionGeneration }
  const isAuthorityCurrent = () =>
    isGfsSessionAuthorityCurrent(
      deps.scope,
      deps.sessionGeneration,
      authorityRef.current.scope,
      authorityRef.current.generation
    )
  const localGestureRef = useRef({ generation: 0, active: false })
  const localBudgetRef = useRef(new GfsHoverCheckBudget())
  const debounceTimerRef = useRef<number | null>(null)
  /**
   * The targets whose cold check already FAILED in this gesture.
   *
   * A destination that answers nothing stays cold, so every hover over it
   * dispatched a fresh probe and every probe spent one slot of the shared
   * cold-check budget. One erroring destination could therefore burn the
   * whole budget and leave every other target stuck on "checking". The
   * failure is remembered for the gesture instead: the target is probed once,
   * and the drop-time priority check is where a failed target gets a fresh
   * read (RP-022).
   */
  const failedColdTargetsRef = useRef<{ generation: number; ids: Set<string> }>({
    generation: -1,
    ids: new Set(),
  })

  /**
   * Hand a probe failure to the surface's central fail-closed classifier when
   * it is a session-authority failure. The drop is refused either way; this
   * is what makes the refusal also REVOKE the session instead of leaving an
   * active accessState over a dead session.
   *
   * The classification travels back to the caller: a session failure is
   * TERMINAL for the gesture (the session it was reading is gone), while a
   * per-resource policy verdict stays local to the attempted operation.
   */
  const reportAuthorityFailure = useCallback(
    (error: unknown): { message: string; sessionFailure: boolean; revoked: boolean } => {
      const message = error instanceof Error ? error.message : String(error ?? '')
      if (!isGfsSessionAuthorityFailure(message, 'operation')) {
        return { message, sessionFailure: false, revoked: false }
      }
      return {
        message,
        sessionFailure: true,
        revoked:
          isAuthorityCurrent() && deps.scope && isGfsSessionGeneration(deps.sessionGeneration)
            ? (deps.handleAuthorityFailure?.(message, deps.scope, deps.sessionGeneration) ?? false)
            : false,
      }
    },
    [deps]
  )

  const readCachedAffordances = useCallback(
    (resourceId: string, drive: string): HeldAffordances | null => {
      if (!deps.scope || !isGfsSessionGeneration(deps.sessionGeneration) || !isAuthorityCurrent()) {
        return null
      }
      return (
        queryClient.getQueryData<HeldAffordances>(
          desktopQueryKeys.gfsAffordances(deps.scope, resourceId, drive, deps.sessionGeneration)
        ) ?? null
      )
    },
    [deps.drive, deps.scope, deps.sessionGeneration, queryClient]
  )

  const fetchAffordances = useCallback(
    async (resourceId: string, drive: string, staleTime: number): Promise<AffordancesProbe> => {
      if (!deps.scope || !isGfsSessionGeneration(deps.sessionGeneration) || !isAuthorityCurrent())
        return { ok: false, error: new Error('No active session authority') }
      try {
        const held = await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.gfsAffordances(
            deps.scope,
            resourceId,
            drive,
            deps.sessionGeneration
          ),
          queryFn: () => window.clerum.gfs.affordances(resourceId, drive),
          staleTime,
        })
        if (!isAuthorityCurrent()) {
          return { ok: false, error: new Error('Session authority changed during drag check') }
        }
        return { ok: true, held: held.held }
      } catch (error) {
        // A 401 here is a session failure, not a refused probe: report it so
        // the surface revokes instead of leaving the drop silently dead.
        if (isAuthorityCurrent()) reportAuthorityFailure(error)
        return { ok: false, error }
      }
    },
    [deps.drive, deps.scope, deps.sessionGeneration, queryClient, reportAuthorityFailure]
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
      const destinationHeld = readCachedAffordances(target.resourceId, source.drive)
      const sourceParentHeld = source.parentKnown
        ? source.parentResourceId !== null
          ? readCachedAffordances(source.parentResourceId, source.drive)
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

  /** A dwell belongs to its schedule-time gesture. Canceled/warm checks are
   * free; a cold chain acquires one shared slot only when it dispatches. */
  const scheduleColdCheck = useCallback(
    (
      target: GfsDropTargetFact,
      drive: string,
      sourceParentId: string | null,
      onComplete: () => void
    ) => {
      const localGeneration = localGestureRef.current.generation
      const expectedGeneration = session?.currentGeneration() ?? localGeneration
      const isCurrent = () =>
        deps.scope !== null &&
        isGfsSessionGeneration(deps.sessionGeneration) &&
        isAuthorityCurrent() &&
        localGeneration === localGestureRef.current.generation &&
        (session
          ? session.currentGeneration() === expectedGeneration && session.matchesScope(deps.scope)
          : localGestureRef.current.active)
      if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null
        if (!isCurrent()) return
        if (failedColdTargetsRef.current.generation !== localGeneration) {
          failedColdTargetsRef.current = { generation: localGeneration, ids: new Set() }
        }
        // Already failed in this gesture: probing it again would spend
        // another budget slot and still answer nothing (RP-022).
        if (failedColdTargetsRef.current.ids.has(target.resourceId)) return
        const warm =
          readCachedAffordances(target.resourceId, drive) !== null &&
          (sourceParentId === null || readCachedAffordances(sourceParentId, drive) !== null)
        if (warm) {
          if (isCurrent()) onComplete()
          return
        }
        const lease = session
          ? session.beginHoverCheck(expectedGeneration)
          : localBudgetRef.current.beginCheck(
              expectedGeneration,
              localGestureRef.current.generation,
              localGestureRef.current.active
            )
        if (!lease) return
        void (async () => {
          try {
            if (!isCurrent()) return
            if (readCachedAffordances(target.resourceId, drive) === null) {
              const probe = await fetchAffordances(
                target.resourceId,
                drive,
                AFFORDANCES_HOVER_STALE_MS
              )
              if (!probe.ok) {
                // The target answered nothing: remember it for this gesture
                // and stop — the source-parent probe cannot produce a verdict
                // for a target whose own bits are unknown (RP-022).
                if (isCurrent()) failedColdTargetsRef.current.ids.add(target.resourceId)
                return
              }
            }
            if (!isCurrent()) return
            if (sourceParentId !== null && readCachedAffordances(sourceParentId, drive) === null) {
              await fetchAffordances(sourceParentId, drive, AFFORDANCES_HOVER_STALE_MS)
            }
            if (isCurrent()) onComplete()
          } finally {
            lease.complete()
          }
        })()
      }, DRAG_COLD_CHECK_DEBOUNCE_MS)
    },
    [deps.scope, deps.sessionGeneration, fetchAffordances, readCachedAffordances, session]
  )

  const cancelHover = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const beginDragSession = useCallback(() => {
    localGestureRef.current = { generation: localGestureRef.current.generation + 1, active: true }
    cancelHover()
  }, [cancelHover])

  const endDragSession = useCallback(() => {
    localGestureRef.current = { generation: localGestureRef.current.generation + 1, active: false }
    cancelHover()
  }, [cancelHover])

  useEffect(() => {
    endDragSession()
    return endDragSession
  }, [deps.scope, deps.sessionGeneration, endDragSession])

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
        if (!isAuthorityCurrent()) return chain
        const uri = `gfs://${source.drive}/${nextIdToResolve.replace(/-/g, '').toLowerCase()}`
        let parent: string | null
        try {
          const resolved = await deps.resolve(uri)
          if (!isAuthorityCurrent()) return chain
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
      if (!deps.scope || !isGfsSessionGeneration(deps.sessionGeneration) || !isAuthorityCurrent()) {
        return {
          allowed: false,
          reason: 'unavailable',
          message: 'Could not verify permissions for this move.',
        }
      }
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
        } catch (error) {
          if (!isAuthorityCurrent()) return { allowed: false, reason: 'unavailable' }
          // A read failure upward is a visibility boundary, not a denial: the
          // ancestry stays unproven and the server PATCH remains the backstop.
          // A SESSION failure is not a boundary — the session the ancestry
          // would be read from is gone. Report it so the session is revoked
          // and STOP: continuing would let the later probes answer "allowed"
          // over a dead session (RP-002).
          const failure = reportAuthorityFailure(error)
          if (failure.sessionFailure) {
            return { allowed: false, reason: 'session-lost' }
          }
        }
      }

      if (structure.kind === 'deny') {
        return { allowed: false, reason: structure.reason }
      }

      // Exact authority: destination write + source-parent write & delete.
      let sourceParentForProbe: string | null = source.parentKnown ? source.parentResourceId : null
      if (sourceParentForProbe === null) {
        try {
          if (!isAuthorityCurrent()) {
            return { allowed: false, reason: 'unavailable' }
          }
          const resolved = await deps.resolve(source.gfsUri)
          if (!isAuthorityCurrent()) {
            return { allowed: false, reason: 'unavailable' }
          }
          sourceParentForProbe = resolved.parentResourceId
        } catch (error) {
          if (!isAuthorityCurrent()) return { allowed: false, reason: 'unavailable' }
          const status = parseHttpStatus(error instanceof Error ? error.message : String(error))
          if (status === 401) {
            // The drop is refused AND the session revoked: a 401 here means the
            // session died, not that this item is off limits.
            reportAuthorityFailure(error)
            return { allowed: false, reason: 'session-lost' }
          }
          if (status === 404) {
            return {
              allowed: false,
              reason: 'source-location-unknown',
              message:
                'EvenDrive cannot verify this item’s current location. Refresh and try again.',
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

      const destinationProbe = await fetchAffordances(
        target.resourceId,
        source.drive,
        AFFORDANCES_MUTATION_STALE_MS
      )
      if (!isAuthorityCurrent()) return { allowed: false, reason: 'unavailable' }
      if (!destinationProbe.ok) {
        return requiredProbeRejection(destinationProbe.error)
      }
      const sourceParentProbe = await fetchAffordances(
        sourceParentForProbe,
        source.drive,
        AFFORDANCES_MUTATION_STALE_MS
      )
      if (!sourceParentProbe.ok) {
        return requiredProbeRejection(sourceParentProbe.error)
      }
      const authority = decideDragAuthority({
        destinationHeld: destinationProbe.held,
        sourceParentHeld: sourceParentProbe.held,
      })
      if (authority.kind === 'deny') return { allowed: false, reason: authority.reason }
      if (authority.kind !== 'observed-allowed') {
        // Both required probes succeeded, so their bits are non-null; any
        // non-positive verdict here must never be admitted as allowed.
        return {
          allowed: false,
          reason: 'unavailable',
          message: 'EvenDrive could not confirm permission for this move. Try again.',
        }
      }

      // Rename capability (not user consent): source-resource write proves a
      // combined rename+move; the folder confirmation records the opt-in.
      //
      // This probe is OPTIONAL for the move, so an ordinary failure only
      // withdraws the rename option and the move stays allowed. A SESSION
      // failure is different: the session the move would be dispatched with
      // is gone, so the drop must be refused terminally instead of being
      // dispatched into a dead session. The probe itself already reported the
      // failure to the surface (which revoked the session), so this only
      // CLASSIFIES it.
      const sourceProbe = await fetchAffordances(
        source.resourceId,
        source.drive,
        AFFORDANCES_MUTATION_STALE_MS
      )
      if (!sourceProbe.ok) {
        const message =
          sourceProbe.error instanceof Error ? sourceProbe.error.message : String(sourceProbe.error)
        if (isGfsSessionAuthorityFailure(message, 'operation')) {
          return { allowed: false, reason: 'session-lost' }
        }
      }
      const canRename = sourceProbe.ok && sourceProbe.held.includes('write')

      return {
        allowed: true,
        allowNumberedRename: canRename,
        structure,
        authority: { kind: 'observed-allowed', checkedAt: Date.now() },
      }
    },
    [deps, fetchAffordances, reportAuthorityFailure, resolveAncestorsUpTo]
  )

  /**
   * Fresh (5 s) source-resource write probe for the rename policy.
   *
   * The rename option authorizes a MUTATION, so it must rest on a current
   * observation. A cached "write" of any age used to answer this probe
   * directly: a member whose write access had since been revoked still got
   * the numbered-rename option offered, and the move was only refused later
   * by the server. The cache is now consulted only through the same
   * freshness window the mutation probes use (RP-023).
   */
  const probeSourceWrite = useCallback(
    async (resourceId: string, drive: string): Promise<boolean> => {
      const fresh = await fetchAffordances(resourceId, drive, AFFORDANCES_MUTATION_STALE_MS)
      return fresh.ok && fresh.held.includes('write')
    },
    [fetchAffordances]
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

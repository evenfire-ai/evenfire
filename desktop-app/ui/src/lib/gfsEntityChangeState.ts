import type { QueryClient } from '@tanstack/react-query'
import { planMoveConvergence } from '@clerum/gfs-interaction-policy'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { parseHttpStatus } from './gfsGrantErrors'
import { publishGfsMoveRelocation } from './gfsOpenLocations'
import { refreshPreviewTab } from './workspaceTabs'
import type { WorkspaceTabsState } from './workspaceTabs.types'

/**
 * Return only a transport-vetted status attached by the main-process GFS client.
 * Error prose can contain arbitrary upstream status numbers and is not an
 * authorization or deletion signal.
 */
export function authoritativeGfsStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return parseHttpStatus(message) ?? undefined
}

/** Keep long-lived per-resource write affordances out of periodic content refreshes. */
export function shouldRevalidateGfsQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'desktop-app' && queryKey[1] === 'gfs' && queryKey[3] !== 'affordances'
}

/** Purge every open GFS preview after the authenticated session is rejected. */
export function expireGfsPreviewTabs(state: WorkspaceTabsState): WorkspaceTabsState {
  const gfsUris = new Set(
    state.tabs.flatMap(tab => (tab.kind === 'preview' && tab.preview ? [tab.preview.gfsUri] : []))
  )
  return Array.from(gfsUris).reduce(
    (next, gfsUri) =>
      refreshPreviewTab(next, gfsUri, {
        status: 'unavailable',
        shellTitle: 'File unavailable',
      }),
    state
  )
}

/** Make the plugin overlay unavailable once; repeated unchanged invalidations are idempotent. */
export function markPluginGfsPreviewUnavailable<
  T extends { gfsUri: string; reloadVersion: number; unavailable?: boolean },
>(current: T | null, gfsUri: string): T | null {
  if (!current || current.gfsUri !== gfsUri || current.unavailable) return current
  return { ...current, unavailable: true, reloadVersion: current.reloadVersion + 1 }
}

// ── selective move convergence (rev-2 drag-and-drop §6) ──────────────────────

interface ChildrenPageLike {
  items?: Array<{ resourceId: string }>
}

type ChildrenCacheEntry = { pages?: ChildrenPageLike[] }

export interface GfsMoveReceiptInput {
  resourceId: string
  oldParentId: string | null
  newParentId: string | null
}

/**
 * Resources whose INHERITED access depends on the moved resource's ancestry.
 * The open Share/Manage dialog is the live instance: when the moved item is
 * that resource or one of its ancestors, the rows it shows were derived from
 * a chain that no longer exists, and the dialog must re-read them instead of
 * keeping the pre-move observation.
 */
export interface GfsMoveConvergenceOptions {
  sessionGeneration: number | null
  ancestryDependentResourceIds?: readonly string[]
}

/**
 * Collect the child→parent links currently present in cached children
 * listings (an observation of what this session has loaded — never a claim
 * that it covers the physical subtree). Children keys are
 * ['desktop-app','gfs',scope,'children',drive,parentId].
 */
export function collectKnownChildParents(
  queryClient: QueryClient,
  scope: string,
  drive: string,
  sessionGeneration: number | null
): Map<string, string | null> {
  const links = new Map<string, string | null>()
  if (!isGfsSessionGeneration(sessionGeneration)) return links
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (!Array.isArray(key) || key.length !== 7 || !hasGfsSessionGeneration(key, sessionGeneration))
      continue
    if (
      key[0] === 'desktop-app' &&
      key[1] === 'gfs' &&
      key[2] === scope &&
      key[3] === 'children' &&
      key[4] === drive &&
      typeof key[5] === 'string'
    ) {
      const parentId = key[5] as string
      const data = query.state.data as ChildrenCacheEntry | undefined
      const items = data?.pages?.flatMap(page => page.items ?? []) ?? []
      for (const item of items) links.set(item.resourceId, parentId)
    }
  }
  return links
}

/**
 * Selective move convergence: apply the pure plan from
 * gfs-interaction-policy to the SHARED query cache — refetch the old/new
 * parent children listings and the accessible roots (active surfaces only),
 * and mark the moved resource plus its KNOWN cached descendants stale
 * (affordances, grants, shares, inherited access) without eager refetches.
 * Local receipts and remote hints converge through the same cache; there is
 * deliberately no echo matching (user hint frames carry no operation ids).
 *
 * Inherited access is the ONE family that is re-read rather than marked
 * stale: it is derived from the resource's ANCESTRY, so a move of the
 * resource or of one of its ancestors invalidates the rows an OPEN
 * Share/Manage dialog is showing. `refetchType: 'active'` keeps that
 * bounded — only a mounted dialog refetches; the rest stay stale-on-entry.
 */
export function applyMoveConvergence(
  queryClient: QueryClient,
  scope: string,
  drive: string,
  receipt: GfsMoveReceiptInput,
  options: GfsMoveConvergenceOptions
): void {
  const { sessionGeneration } = options
  if (!isGfsSessionGeneration(sessionGeneration)) return
  const known = {
    childParentByResourceId: collectKnownChildParents(queryClient, scope, drive, sessionGeneration),
  }
  const plan = planMoveConvergence(receipt, known)

  // The published open-location chains are OBSERVED chains, so the move makes
  // them stale for every resource below the moved one. Relocating them here
  // keeps the shared registry able to answer the NEXT question — "is the
  // moved resource's new parent an ancestor of the open resource?" — which
  // neither the registry's old crumbs nor the children cache can answer
  // after the chain changed.
  publishGfsMoveRelocation(queryClient, scope, receipt.resourceId, receipt.newParentId)

  for (const parentId of plan.refetchChildIds) {
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsChildren(scope, parentId, drive, sessionGeneration),
    })
  }
  void queryClient.invalidateQueries({
    exact: true,
    queryKey: desktopQueryKeys.gfsAccessible(scope, drive, sessionGeneration),
  })
  for (const resourceId of plan.staleResourceIds) {
    // Stale-on-entry: inactive permission caches re-read when next observed,
    // not eagerly here (bounded feature traffic).
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsAffordances(scope, resourceId, drive, sessionGeneration),
      refetchType: 'none',
    })
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsGrants(scope, resourceId, drive, sessionGeneration),
      refetchType: 'none',
    })
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsShares(scope, resourceId, drive, sessionGeneration),
      refetchType: 'none',
    })
  }
  const inheritedAccessResourceIds = new Set([
    ...plan.staleResourceIds,
    ...(options.ancestryDependentResourceIds ?? []),
  ])
  for (const resourceId of inheritedAccessResourceIds) {
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsInheritedAccess(scope, resourceId, drive, sessionGeneration),
      refetchType: 'active',
    })
  }
}

import { describe, expect, it, vi } from 'vitest'
// ── selective move convergence (rev-2 drag-and-drop §6) ─────────────────────

import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { markPluginGfsPreviewUnavailable } from '../gfsEntityChangeState'
import { applyMoveConvergence, collectKnownChildParents } from '../gfsEntityChangeState'
import {
  ancestryDependentGfsResourceIds,
  publishGfsOpenLocation,
  readGfsOpenLocations,
} from '../gfsOpenLocations'

describe('plugin preview unavailable reconciliation', () => {
  it('increments the reload identity once and preserves it on repeated invalidation', () => {
    const available = {
      gfsUri: 'gfs://main/image',
      name: 'diagram.png',
      bytes: 32,
      mimeType: 'image/png',
      version: 8,
      reloadVersion: 4,
    }

    const unavailable = markPluginGfsPreviewUnavailable(available, available.gfsUri)
    expect(unavailable).toMatchObject({ unavailable: true, reloadVersion: 5 })
    expect(markPluginGfsPreviewUnavailable(unavailable, available.gfsUri)).toBe(unavailable)
  })

  it('does not alter an unrelated or absent plugin preview', () => {
    const current = {
      gfsUri: 'gfs://main/visible.png',
      name: 'visible.png',
      bytes: 8,
      mimeType: 'image/png',
      reloadVersion: 1,
    }

    expect(markPluginGfsPreviewUnavailable(current, 'gfs://main/other.png')).toBe(current)
    expect(markPluginGfsPreviewUnavailable(null, 'gfs://main/visible.png')).toBeNull()
  })
})

const SCOPE = 'test:user-1:team-1'
const DRIVE = 'main'

function seedChildren(
  queryClient: QueryClient,
  parentId: string,
  items: Array<{ resourceId: string; name?: string }>
) {
  queryClient.setQueryData(desktopQueryKeys.gfsChildren(SCOPE, parentId, DRIVE), {
    pages: [{ items: items.map(item => ({ ...item, name: item.name ?? item.resourceId })) }],
  })
}

describe('collectKnownChildParents', () => {
  it('derives child→parent links from cached children listings only', () => {
    const queryClient = new QueryClient()
    seedChildren(queryClient, 'A', [{ resourceId: 'x' }, { resourceId: 'M' }])
    seedChildren(queryClient, 'M', [{ resourceId: 'c1' }])
    expect(collectKnownChildParents(queryClient, SCOPE, DRIVE)).toEqual(
      new Map([
        ['x', 'A'],
        ['M', 'A'],
        ['c1', 'M'],
      ])
    )
  })

  it('ignores other scopes, drives and key families', () => {
    const queryClient = new QueryClient()
    seedChildren(queryClient, 'A', [{ resourceId: 'x' }])
    queryClient.setQueryData(desktopQueryKeys.gfsChildren('other-scope', 'A', DRIVE), {
      pages: [{ items: [{ resourceId: 'foreign' }] }],
    })
    queryClient.setQueryData(desktopQueryKeys.gfsAffordances(SCOPE, 'x', DRIVE), {
      held: ['read'],
    })
    const links = collectKnownChildParents(queryClient, SCOPE, DRIVE)
    expect(links.has('x')).toBe(true)
    expect(links.has('foreign')).toBe(false)
  })
})

describe('applyMoveConvergence', () => {
  it('invalidates old/new parent children and accessible, and marks known descendants stale without refetch', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedChildren(queryClient, 'A', [{ resourceId: 'M' }])
    seedChildren(queryClient, 'M', [{ resourceId: 'c1' }, { resourceId: 'c2', name: 'nested' }])
    seedChildren(queryClient, 'c1', [{ resourceId: 'c3' }])
    seedChildren(queryClient, 'B', [{ resourceId: 'unrelated' }])
    queryClient.setQueryData(desktopQueryKeys.gfsAccessible(SCOPE, DRIVE), {
      pages: [{ items: [] }],
    })
    for (const id of ['M', 'c1', 'c3', 'B']) {
      queryClient.setQueryData(desktopQueryKeys.gfsAffordances(SCOPE, id, DRIVE), {
        held: ['read'],
      })
    }

    applyMoveConvergence(queryClient, SCOPE, DRIVE, {
      resourceId: 'M',
      oldParentId: 'A',
      newParentId: 'B',
    })

    // Let microtasks settle (invalidations are fire-and-forget promises).
    await Promise.resolve()

    // Old + new parent children and accessible were invalidated: their cached
    // data is now marked stale (isInvalidated true).
    const stale = (key: readonly unknown[]) =>
      queryClient.getQueryCache().find({ queryKey: key })?.state.isInvalidated === true
    expect(stale(desktopQueryKeys.gfsChildren(SCOPE, 'A', DRIVE))).toBe(true)
    expect(stale(desktopQueryKeys.gfsChildren(SCOPE, 'B', DRIVE))).toBe(true)
    expect(stale(desktopQueryKeys.gfsAccessible(SCOPE, DRIVE))).toBe(true)
    // The moved resource and its KNOWN descendants' permission data were
    // invalidated with refetchType none — stale, not eagerly refetched.
    expect(stale(desktopQueryKeys.gfsAffordances(SCOPE, 'M', DRIVE))).toBe(true)
    expect(stale(desktopQueryKeys.gfsAffordances(SCOPE, 'c1', DRIVE))).toBe(true)
    expect(stale(desktopQueryKeys.gfsAffordances(SCOPE, 'c3', DRIVE))).toBe(true)
    // Unknown-descendant guarantee: nothing outside the known subtree was touched.
    expect(stale(desktopQueryKeys.gfsChildren(SCOPE, 'M', DRIVE))).toBe(false)
    expect(stale(desktopQueryKeys.gfsAffordances(SCOPE, 'B', DRIVE))).toBe(false)
  })

  it('re-reads the inherited access of the moved resource and of an ancestry-dependent one', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The OPEN Share/Manage dialog observes this resource's inherited rows.
    // An active observer is what makes the query "active" for the
    // invalidation below.
    const openKey = desktopQueryKeys.gfsInheritedAccess(SCOPE, 'open', DRIVE)
    let openReads = 0
    const openObserver = new QueryObserver(queryClient, {
      queryKey: openKey,
      queryFn: async () => {
        openReads += 1
        return { items: [], coverage: 'complete' }
      },
    })
    const unsubscribe = openObserver.subscribe(() => {})
    const openQuery = queryClient.getQueryCache().find({ queryKey: openKey })!
    await vi.waitFor(() => expect(openQuery.state.fetchStatus).toBe('idle'))
    expect(openReads).toBe(1)

    applyMoveConvergence(
      queryClient,
      SCOPE,
      DRIVE,
      { resourceId: 'ancestor', oldParentId: 'A', newParentId: 'B' },
      { ancestryDependentResourceIds: ['open'] }
    )

    // The dialog's rows were derived from an ancestry that no longer exists:
    // they are re-read, not merely marked stale.
    await vi.waitFor(() => expect(openReads).toBe(2))
    unsubscribe()
  })

  it("re-reads a descendant's ACL rows after a SECOND move, through the relocated chain", async () => {
    // TWO controllers: Files has the leaf L open (reached BY URI, so no
    // children listing connects A to it), the sidebar has B open. The first
    // move (A under B) relocates the leaf's published chain; the second
    // move (of B) must then see the leaf as a descendant — neither the
    // registry's old crumbs nor the children cache could answer that.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    publishGfsOpenLocation(queryClient, SCOPE, 'files', {
      resourceId: 'L',
      ancestorResourceIds: ['A', 'X', 'root'],
    })
    publishGfsOpenLocation(queryClient, SCOPE, 'sidebar', {
      resourceId: 'B',
      ancestorResourceIds: ['P', 'root'],
    })

    const leafKey = desktopQueryKeys.gfsInheritedAccess(SCOPE, 'L', DRIVE)
    let leafReads = 0
    const observer = new QueryObserver(queryClient, {
      queryKey: leafKey,
      queryFn: async () => {
        leafReads += 1
        return { items: [], coverage: 'complete' }
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    await vi.waitFor(() =>
      expect(queryClient.getQueryCache().find({ queryKey: leafKey })?.state.fetchStatus).toBe(
        'idle'
      )
    )
    const readsBefore = leafReads

    // Move 1: the sidebar moves A under B.
    applyMoveConvergence(queryClient, SCOPE, DRIVE, {
      resourceId: 'A',
      oldParentId: 'X',
      newParentId: 'B',
    })
    await Promise.resolve()

    // The leaf's chain now names B, so the SECOND move claims it.
    const ancestryDependent = ancestryDependentGfsResourceIds(
      readGfsOpenLocations(queryClient, SCOPE),
      'B'
    )
    expect(ancestryDependent).toContain('L')

    // Move 2: the sidebar moves B elsewhere. The leaf's inherited rows are
    // derived from its ancestry, so they must be re-read.
    applyMoveConvergence(
      queryClient,
      SCOPE,
      DRIVE,
      { resourceId: 'B', oldParentId: 'P', newParentId: 'Q' },
      { ancestryDependentResourceIds: ancestryDependent }
    )

    await vi.waitFor(() => expect(leafReads).toBeGreaterThan(readsBefore))
    unsubscribe()
  })

  it('leaves an unrelated open inherited-access query alone', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const openKey = desktopQueryKeys.gfsInheritedAccess(SCOPE, 'open', DRIVE)
    let openReads = 0
    const openObserver = new QueryObserver(queryClient, {
      queryKey: openKey,
      queryFn: async () => {
        openReads += 1
        return { items: [], coverage: 'complete' }
      },
    })
    const unsubscribe = openObserver.subscribe(() => {})
    const openQuery = queryClient.getQueryCache().find({ queryKey: openKey })!
    await vi.waitFor(() => expect(openQuery.state.fetchStatus).toBe('idle'))
    expect(openReads).toBe(1)

    applyMoveConvergence(queryClient, SCOPE, DRIVE, {
      resourceId: 'unrelated',
      oldParentId: 'A',
      newParentId: 'B',
    })

    await Promise.resolve()
    expect(openReads).toBe(1)
    unsubscribe()
  })
})

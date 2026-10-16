import { describe, expect, it } from 'vitest'
import { markPluginGfsPreviewUnavailable } from '../gfsEntityChangeState'

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

// ── selective move convergence (rev-2 drag-and-drop §6) ─────────────────────

import { QueryClient } from '@tanstack/react-query'
import { applyMoveConvergence, collectKnownChildParents } from '../gfsEntityChangeState'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'

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
    seedChildren(queryClient, 'M', [
      { resourceId: 'c1' },
      { resourceId: 'c2', name: 'nested' },
    ])
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
})

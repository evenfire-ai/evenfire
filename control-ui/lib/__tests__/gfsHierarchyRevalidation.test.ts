import { describe, expect, it, vi } from 'vitest'
import { resolveGfsHierarchy } from '../gfsHierarchyRevalidation'

describe('GFS hierarchy revalidation', () => {
  it('accepts the drive root without attempting to resolve a parent', async () => {
    const root = {
      resourceId: 'root-id',
      rid: 'root-rid',
      gfsUri: 'gfs://drive/root',
      name: 'Root',
      kind: 'directory',
      path: '/',
      version: 1,
    }
    const readAncestor = vi.fn()

    await expect(
      resolveGfsHierarchy({
        readCurrent: async () => root,
        readAncestor,
        isTransient: () => false,
      })
    ).resolves.toEqual({ kind: 'resolved', ancestors: [] })
    expect(readAncestor).not.toHaveBeenCalled()
  })
})

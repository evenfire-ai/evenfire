import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet as apiGetFn, getGfsGrants, getGfsResourceByPath, getGfsShares } from '@lib/api'
import { loadGfsInheritedAccess } from '../gfsInheritedAccess'

vi.mock('@lib/api', () => ({
  apiGet: vi.fn(),
  getGfsGrants: vi.fn(),
  getGfsResourceByPath: vi.fn(),
  getGfsShares: vi.fn(),
}))

const apiGet = vi.mocked(apiGetFn)
const mockGetGfsGrants = vi.mocked(getGfsGrants)
const mockGetGfsResourceByPath = vi.mocked(getGfsResourceByPath)
const mockGetGfsShares = vi.mocked(getGfsShares)

function resourceView(resourceId: string, name: string, path: string) {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    name,
    kind: 'directory',
    path,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('loadGfsInheritedAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGfsShares.mockResolvedValue({ items: [] })
  })

  it('continues after an ancestor ACL denial and marks retained rows incomplete', async () => {
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/nested') return resourceView('nested-folder', 'nested', '/nested')
      if (path === '/') return resourceView('root-folder', '', '/')
      throw new Error('unexpected path')
    })
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === 'nested-folder') throw new Error('403 manage_acl_required')
      return {
        items: [
          {
            id: 'root-grant',
            drive: 'main',
            resourceId: 'root-folder',
            subject: { type: 'user', id: 'member-1' },
            permissions: ['read'],
            inherit: true,
          },
        ],
      }
    })

    await expect(
      loadGfsInheritedAccess({ path: '/nested/report.md' }, 'main')
    ).resolves.toMatchObject({
      coverage: 'acl-limited',
      items: [{ subject: { type: 'user', id: 'member-1' }, permissions: ['read'] }],
    })
    expect(mockGetGfsResourceByPath.mock.calls.map(([, path]) => path)).toEqual(['/nested', '/'])
  })

  it('stops at an unreadable ancestor with explicit boundary coverage', async () => {
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/nested') throw new Error('403 forbidden')
      if (path === '/') return resourceView('root-folder', '', '/')
      throw new Error('unexpected path')
    })

    await expect(loadGfsInheritedAccess({ path: '/nested/report.md' }, 'main')).resolves.toEqual({
      items: [],
      coverage: 'read-boundary',
    })
    expect(mockGetGfsResourceByPath.mock.calls.map(([, path]) => path)).toEqual(['/nested'])
  })

  it('resolves the canonical path once when the target carries none', async () => {
    apiGet.mockResolvedValue({
      resourceId: 'nested-folder',
      path: '/nested',
      kind: 'directory',
    } as never)
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/nested') return resourceView('nested-folder', 'nested', '/nested')
      if (path === '/') return resourceView('root-folder', '', '/')
      throw new Error('unexpected path')
    })
    mockGetGfsGrants.mockResolvedValue({ items: [] })
    mockGetGfsShares.mockResolvedValue({ items: [] })

    const result = await loadGfsInheritedAccess({ path: null, gfsUri: 'gfs://main/abcdef' }, 'main')
    expect(result).toEqual({ items: [], coverage: 'complete' })
    expect(apiGet).toHaveBeenCalledWith(
      '/api/v1/gfs/resolve',
      { uri: 'gfs://main/abcdef' },
      expect.anything()
    )
    // The resolved target is the FOLDER /nested — its only ancestor is /.
    expect(mockGetGfsResourceByPath.mock.calls.map(([, path]) => path)).toEqual(['/'])
  })

  it('marks a path-less target boundary explicitly when it cannot be resolved', async () => {
    apiGet.mockRejectedValue(new Error('403 forbidden') as never)
    mockGetGfsResourceByPath.mockResolvedValue(resourceView('root-folder', '', '/'))

    await expect(
      loadGfsInheritedAccess({ path: null, gfsUri: 'gfs://main/abcdef' }, 'main')
    ).resolves.toEqual({ items: [], coverage: 'read-boundary' })
    expect(mockGetGfsResourceByPath).not.toHaveBeenCalled()
  })

  it('marks a target without a path or gfs URI unavailable', async () => {
    await expect(loadGfsInheritedAccess({ path: null, gfsUri: null }, 'main')).resolves.toEqual({
      items: [],
      coverage: 'unavailable',
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGfsGrants, getGfsResourceByPath, getGfsShares } from '@lib/api'
import { loadGfsInheritedAccess } from '../gfsInheritedAccess'

vi.mock('@lib/api', () => ({
  getGfsGrants: vi.fn(),
  getGfsResourceByPath: vi.fn(),
  getGfsShares: vi.fn(),
}))

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

  it('fails when an ancestor ACL read fails instead of returning a partial role', async () => {
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

    await expect(loadGfsInheritedAccess('/nested/report.md', 'main')).rejects.toThrow(
      'inherited_access_derivation_failed'
    )
    expect(mockGetGfsResourceByPath.mock.calls.map(([, path]) => path)).toEqual(['/nested'])
  })

  it('fails when an ancestor cannot be resolved, matching Desktop walk semantics', async () => {
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/nested') throw new Error('403 forbidden')
      if (path === '/') return resourceView('root-folder', '', '/')
      throw new Error('unexpected path')
    })

    await expect(loadGfsInheritedAccess('/nested/report.md', 'main')).rejects.toThrow(
      'inherited_access_derivation_failed'
    )
    expect(mockGetGfsResourceByPath.mock.calls.map(([, path]) => path)).toEqual(['/nested'])
  })
})

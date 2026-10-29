import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, getGfsGrants, getGfsResourceByPath, getGfsShares } from '@lib/api'
import { loadGfsInheritedAccess } from '../gfsInheritedAccess'

vi.mock('@lib/api', () => ({
  apiGet: vi.fn(),
  getGfsGrants: vi.fn(),
  getGfsResourceByPath: vi.fn(),
  getGfsShares: vi.fn(),
}))

const getFolder = vi.mocked(getGfsResourceByPath)
const getGrants = vi.mocked(getGfsGrants)
const getShares = vi.mocked(getGfsShares)
const FOLDER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ROOT = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const SUBJECT = { type: 'user', id: '11111111-1111-1111-1111-111111111111' } as const
const target = { path: '/team-docs/report.md' }

// Successful rows use the established Control UI API-boundary wire contract.
// Failure shapes come from the actual HTTP error producer, never invented markers.
async function failure(status: number, message = 'request rejected') {
  const api = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  const text = JSON.stringify({ error: 'request_failed', message })
  return api.formatApiError(new Response(text, { status }), text)
}

function grant() {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    drive: 'main',
    resourceId: FOLDER,
    subject: SUBJECT,
    permissions: ['read'],
    inherit: true,
  }
}

describe('Control UI inherited coverage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getFolder.mockImplementation(async (_drive, path) => ({
      resourceId: path === '/' ? ROOT : FOLDER,
      rid: (path === '/' ? ROOT : FOLDER).replace(/-/g, ''),
      gfsUri: `gfs://main/${path === '/' ? ROOT : FOLDER}`,
      drive: 'main',
      name: path === '/' ? '' : 'team-docs',
      kind: 'directory',
      path,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    getGrants.mockImplementation(async id => ({ items: id === FOLDER ? [grant()] : [] }))
    getShares.mockResolvedValue({ items: [] })
  })

  it.each([
    [403, 'read-boundary'],
    [404, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('retains a proven member when a later ancestor returns %s', async (status, coverage) => {
    const error = await failure(Number(status))
    const normal = getFolder.getMockImplementation()!
    getFolder.mockImplementation(async (...args) => {
      if (args[1] === '/') throw error
      return normal(...args)
    })
    await expect(loadGfsInheritedAccess(target, 'main')).resolves.toMatchObject({
      coverage,
      items: [{ subject: SUBJECT, permissions: ['read'], inheritedFrom: ['team-docs'] }],
    })
  })

  it('retains the successful grant family and continues after a share denial', async () => {
    const error = await failure(403)
    getShares.mockImplementation(async id => {
      if (id === FOLDER) throw error
      return { items: [] }
    })
    await expect(loadGfsInheritedAccess(target, 'main')).resolves.toMatchObject({
      coverage: 'acl-limited',
      items: [{ subject: SUBJECT, sources: [{ grantId: grant().id }] }],
    })
    expect(getFolder.mock.calls.map(([, path]) => path)).toEqual(['/team-docs', '/'])
  })

  it('retains the successful share family before stopping on a grant failure', async () => {
    const error = await failure(500, 'upstream background job returned 401')
    getGrants.mockRejectedValue(error)
    getShares.mockResolvedValue({
      items: [
        {
          id: '66666666-6666-6666-6666-666666666666',
          drive: 'main',
          resourceId: FOLDER,
          subject: SUBJECT,
          permissions: ['read'],
          includeDescendants: true,
        },
      ],
    })
    await expect(loadGfsInheritedAccess(target, 'main')).resolves.toMatchObject({
      coverage: 'unavailable',
      items: [
        { subject: SUBJECT, sources: [{ shareIds: ['66666666-6666-6666-6666-666666666666'] }] },
      ],
    })
    expect(getFolder.mock.calls.map(([, path]) => path)).toEqual(['/team-docs'])
  })

  it.each(['resolve', 'grants', 'shares'] as const)(
    'rethrows real session expiry from %s',
    async family => {
      const api = await vi.importActual<typeof import('@lib/api')>('@lib/api')
      const expired = new api.AuthExpiredError()
      if (family === 'resolve') getFolder.mockRejectedValue(expired)
      if (family === 'grants') getGrants.mockRejectedValue(expired)
      if (family === 'shares') getShares.mockRejectedValue(expired)
      await expect(loadGfsInheritedAccess(target, 'main')).rejects.toBe(expired)
    }
  )

  it('rethrows cancellation instead of publishing partial data', async () => {
    const controller = new AbortController()
    controller.abort()
    getFolder.mockRejectedValue(controller.signal.reason)
    await expect(loadGfsInheritedAccess(target, 'main', controller.signal)).rejects.toBe(
      controller.signal.reason
    )
  })

  it('rethrows cancellation during target resolution even when the target is root', async () => {
    const controller = new AbortController()
    vi.mocked(apiGet).mockImplementation(async () => {
      controller.abort()
      return { path: '/', kind: 'directory' }
    })
    await expect(
      loadGfsInheritedAccess(
        { path: null, gfsUri: `gfs://main/${ROOT.replace(/-/g, '')}` },
        'main',
        controller.signal
      )
    ).rejects.toBe(controller.signal.reason)
    expect(getFolder).not.toHaveBeenCalled()
  })

  it('rethrows real session expiry during target resolution', async () => {
    const api = await vi.importActual<typeof import('@lib/api')>('@lib/api')
    const expired = new api.AuthExpiredError()
    vi.mocked(apiGet).mockRejectedValue(expired)
    await expect(
      loadGfsInheritedAccess({ path: null, gfsUri: `gfs://main/${ROOT.replace(/-/g, '')}` }, 'main')
    ).rejects.toBe(expired)
  })

  it('marks a depth-capped walk unavailable instead of complete', async () => {
    getGrants.mockResolvedValue({ items: [] })
    await expect(
      loadGfsInheritedAccess({ path: '/' + Array(67).fill('folder').join('/') }, 'main')
    ).resolves.toMatchObject({ items: [], coverage: 'unavailable' })
    expect(getFolder).toHaveBeenCalledTimes(64)
  })

  it('returns complete when every ancestor and both families load', async () => {
    await expect(loadGfsInheritedAccess(target, 'main')).resolves.toMatchObject({
      coverage: 'complete',
      items: [{ subject: SUBJECT, permissions: ['read'] }],
    })
  })
})

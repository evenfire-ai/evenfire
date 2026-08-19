import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOrgGrant,
  getOwnedRegistryEntries,
  listGrantedToMe,
  listOrgGrants,
  revokeOrgGrant,
} from '../api'

function makeRes(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('registry publisher api', () => {
  it('getOwnedRegistryEntries returns { data, meta }', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
        meta: { total: 1 },
      })
    )
    const res = await getOwnedRegistryEntries()
    expect(res.data[0].name).toBe('@acme/db')
    expect(res.meta?.total).toBe(1)
  })

  // The registry's /org/:org/entries returns { entries: [...] } (its real wire
  // shape), while this wrapper's contract — and every consumer — expects
  // { data: [...] }. control-api forwards the registry body verbatim, so the
  // wrapper must tolerate either key and ALWAYS hand back a { data } array.
  // Otherwise OwnedEntries does setEntries(undefined) and crashes on
  // `entries.length`.
  it('getOwnedRegistryEntries tolerates the registry { entries } shape', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        entries: [
          { name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' },
        ],
        meta: { total: 1 },
      })
    )
    const res = await getOwnedRegistryEntries()
    expect(res.data[0].name).toBe('@acme/db')
    expect(res.meta?.total).toBe(1)
  })

  it('getOwnedRegistryEntries coalesces a body missing data/entries to { data: [] }', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(200, {}))
    const res = await getOwnedRegistryEntries()
    expect(res.data).toEqual([])
  })

  it('listOrgGrants passes pluginName as a query param', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(200, { grants: [] }))
    await listOrgGrants('@acme/db')
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('/api/v1/admin/registry/grants')
    expect(calledUrl).toContain('pluginName=%40acme%2Fdb')
  })

  it('createOrgGrant surfaces the typed error CODE from the { error } body', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(400, { error: 'self_grant' }))
    const err = await createOrgGrant({ pluginName: '@acme/db', granteeOrg: 'acme' }).catch(e => e)
    expect(err.status).toBe(400)
    expect(err.code).toBe('self_grant')
  })

  it('createOrgGrant returns the created grant on 201', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(201, { id: 'g1', pluginName: '@acme/db', granteeOrg: 'beta' })
    )
    await expect(createOrgGrant({ pluginName: '@acme/db', granteeOrg: 'beta' })).resolves.toEqual({
      id: 'g1',
      pluginName: '@acme/db',
      granteeOrg: 'beta',
    })
  })

  it('revokeOrgGrant resolves undefined on 204', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(204))
    await expect(revokeOrgGrant('g1')).resolves.toBeUndefined()
  })

  it('listGrantedToMe returns { grants }', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, { grants: [{ pluginName: '@beta/tool', ownerOrg: 'beta' }] })
    )
    const res = await listGrantedToMe()
    expect(res.grants[0].ownerOrg).toBe('beta')
  })

  // Field-naming tolerance: the control-api proxy forwards registry items
  // verbatim, and the registry catalog convention is snake_case. The wrappers
  // must normalize either casing to canonical camelCase so GrantAccessModal's
  // pluginName filter and the grant rows don't silently break.
  it('listOrgGrants normalizes snake_case grant items to camelCase', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        grants: [
          { id: 'g1', plugin_name: '@acme/db', grantee_org: 'beta', created_at: '2026-06-01' },
        ],
      })
    )
    const res = await listOrgGrants('@acme/db')
    expect(res.grants[0]).toEqual({
      id: 'g1',
      pluginName: '@acme/db',
      granteeOrg: 'beta',
      createdAt: '2026-06-01',
    })
  })

  it('createOrgGrant tolerates a snake_case response body', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(201, { id: 'g1', plugin_name: '@acme/db', grantee_org: 'beta' })
    )
    const g = await createOrgGrant({ pluginName: '@acme/db', granteeOrg: 'beta' })
    expect(g.pluginName).toBe('@acme/db')
    expect(g.granteeOrg).toBe('beta')
  })

  it('listGrantedToMe normalizes snake_case items to camelCase', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        grants: [{ plugin_name: '@beta/tool', owner_org: 'beta', created_at: '2026-06-02' }],
      })
    )
    const res = await listGrantedToMe()
    expect(res.grants[0]).toEqual({
      pluginName: '@beta/tool',
      ownerOrg: 'beta',
      createdAt: '2026-06-02',
    })
  })
})

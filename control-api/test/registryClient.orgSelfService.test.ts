import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Auth-off so authedFetch's mintToken() short-circuits to '' (no /oauth/token
// round trip) and every fetch call the stub sees is the org endpoint itself.
const ENV = {
  CLERUM_REGISTRY_URL: 'https://registry.evenfire.ai',
  CLERUM_REGISTRY_AUTH_ENABLED: 'false',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let RegistryProxyError: any
let __resetScopeCacheForTests: any
let __resetTokenCacheForTests: any
let createOrgGrant: any
let listGrantedToMe: any
let listOrgEntries: any
let listOrgGrants: any
let revokeOrgGrant: any

beforeEach(async () => {
  // Set env vars BEFORE importing to ensure config reads correct values
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v
  // Reset modules to clear cached config
  vi.resetModules()
  // Now import fresh modules with correct config
  const mod = await import('../src/services/registryClient.js')
  RegistryProxyError = mod.RegistryProxyError
  __resetScopeCacheForTests = mod.__resetScopeCacheForTests
  __resetTokenCacheForTests = mod.__resetTokenCacheForTests
  createOrgGrant = mod.createOrgGrant
  listGrantedToMe = mod.listGrantedToMe
  listOrgEntries = mod.listOrgEntries
  listOrgGrants = mod.listOrgGrants
  revokeOrgGrant = mod.revokeOrgGrant
  // Reset caches
  __resetTokenCacheForTests()
  __resetScopeCacheForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of Object.keys(ENV)) delete process.env[k]
})

describe('createOrgGrant', () => {
  it('POSTs /org/:org/grants with pluginName+granteeOrg+actingUserId and returns the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'g1' }, 201))
    vi.stubGlobal('fetch', fetchMock)
    const out = await createOrgGrant('acme', {
      pluginName: '@acme/p',
      granteeOrg: 'beta',
      actingUserId: 'admin-1',
    })
    expect(out).toEqual({ id: 'g1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://registry.evenfire.ai/api/v1/org/acme/grants')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      pluginName: '@acme/p',
      granteeOrg: 'beta',
      actingUserId: 'admin-1',
    })
  })

  it('throws RegistryProxyError carrying the upstream status AND the {error} body', async () => {
    // A fresh Response per call — a Response body can only be read once, and
    // this test now issues the call twice (toMatchObject + toBeInstanceOf).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json({ error: 'self_grant' }, 400)))
    )
    await expect(
      createOrgGrant('acme', { pluginName: '@acme/p', granteeOrg: 'acme', actingUserId: 'a' })
    ).rejects.toMatchObject({ status: 400, body: { error: 'self_grant' } })
    await expect(
      createOrgGrant('acme', { pluginName: '@acme/p', granteeOrg: 'acme', actingUserId: 'a' })
    ).rejects.toBeInstanceOf(RegistryProxyError)
  })
})

describe('revokeOrgGrant', () => {
  it('DELETEs /org/:org/grants/:id?actingUserId=… and returns undefined on 204 (no res.json crash)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(revokeOrgGrant('acme', 'g1', 'admin-1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://registry.evenfire.ai/api/v1/org/acme/grants/g1?actingUserId=admin-1')
    expect(init.method).toBe('DELETE')
  })

  it('forwards a typed 404 body as RegistryProxyError', async () => {
    // A fresh Response per call — see the createOrgGrant test above for why.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json({ error: 'plugin_not_found' }, 404)))
    )
    await expect(revokeOrgGrant('acme', 'gX', 'a')).rejects.toMatchObject({
      status: 404,
      body: { error: 'plugin_not_found' },
    })
    await expect(revokeOrgGrant('acme', 'gX', 'a')).rejects.toBeInstanceOf(RegistryProxyError)
  })
})

describe('listOrgGrants / listGrantedToMe / listOrgEntries', () => {
  it('GETs /org/:org/grants', async () => {
    // Real registry envelope: { grants: OrgGrant[] } (these wrappers are
    // passthroughs, so the shape here documents the contract control-ui relies on).
    const fetchMock = vi.fn().mockResolvedValue(json({ grants: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(listOrgGrants('acme')).resolves.toEqual({ grants: [] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://registry.evenfire.ai/api/v1/org/acme/grants')
  })

  it('GETs /org/:org/granted-to-me', async () => {
    // Real registry envelope: { grants: GrantedToMeItem[] }.
    const fetchMock = vi.fn().mockResolvedValue(json({ grants: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(listGrantedToMe('acme')).resolves.toEqual({ grants: [] })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://registry.evenfire.ai/api/v1/org/acme/granted-to-me'
    )
  })

  it('GETs /org/:org/entries with pagination', async () => {
    // Real registry envelope: { data: OwnedRegistryEntry[], meta: {...} }.
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [], meta: { total: 0 } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(listOrgEntries('acme', { limit: 50, offset: 10 })).resolves.toEqual({
      data: [],
      meta: { total: 0 },
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://registry.evenfire.ai/api/v1/org/acme/entries?limit=50&offset=10'
    )
  })

  it('encodes the org path segment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ grants: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listOrgGrants('a/b')
    expect(fetchMock.mock.calls[0][0]).toContain('/org/a%2Fb/grants')
  })
})

describe('orgRegistryFetch — transport-level fixes', () => {
  it('a persistent upstream 401 rejects with a 502 RegistryProxyError (not the raw 401)', async () => {
    // authedFetch already evict-retries once internally on a 401, so a single
    // wrapper call issues 2 fetch calls — and this test calls the wrapper
    // twice (toMatchObject + toBeInstanceOf). Return a FRESH 401 Response
    // every time since a Response body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })))
    )
    await expect(listOrgGrants('acme')).rejects.toMatchObject({
      status: 502,
      body: { error: 'registry_integration_error' },
    })
    await expect(listOrgGrants('acme')).rejects.toBeInstanceOf(RegistryProxyError)
  })

  it('a non-JSON 2xx body rejects with a typed 502, not a raw SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response('<html>ok</html>', { status: 200 })))
    )
    await expect(listOrgGrants('acme')).rejects.toMatchObject({
      status: 502,
      body: { error: 'registry_integration_error' },
    })
  })

  it('a non-JSON error body collapses to a synthetic registry_<status> code, not the raw markup', async () => {
    // 502 is also a retriable GET status at the authedFetch transport layer,
    // so this call incurs one real jitterSleep retry — mirrors the existing
    // GET retry-once tests in registryClient.test.ts. Fresh Response per call.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))
        )
    )
    await expect(listOrgGrants('acme')).rejects.toMatchObject({
      status: 502,
      body: { error: 'registry_502' },
    })
  })
})

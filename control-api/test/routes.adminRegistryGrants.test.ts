import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import {
  RegistryProxyError,
  createOrgGrant,
  listGrantedToMe,
  listOrgEntries,
  listOrgGrants,
  resolvePublishScope,
  revokeOrgGrant,
} from '../src/services/registryClient.js'

// Mock the registryClient surface: keep RegistryProxyError REAL so the route's
// instanceof check works, but stub the wrappers + resolvePublishScope.
vi.mock('../src/services/registryClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/registryClient.js')>()
  return {
    ...actual,
    searchEntries: vi.fn(),
    getEntry: vi.fn(),
    getEntryVersion: vi.fn(),
    getCredentialSchema: vi.fn(),
    getCategories: vi.fn(),
    reportInstall: vi.fn(),
    downloadBundle: vi.fn(),
    getDigest: vi.fn(),
    uploadArtifacts: vi.fn(),
    updateVersionMetadata: vi.fn(),
    deleteVersion: vi.fn(),
    publishEntry: vi.fn(),
    applyPublishScope: vi.fn((n: string | undefined) => n),
    resolvePublishScope: vi.fn(),
    createOrgGrant: vi.fn(),
    listOrgGrants: vi.fn(),
    revokeOrgGrant: vi.fn(),
    listGrantedToMe: vi.fn(),
    listOrgEntries: vi.fn(),
  }
})
vi.mock('../src/services/orgApiKeyClient.js', () => ({
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  RegistryStatusError: class extends Error {
    status: number
    constructor(code: string, status: number) {
      super(code)
      this.status = status
    }
  },
}))
vi.mock('../src/services/adminAuthService.js', () => ({ findAdminById: vi.fn() }))
const { cfg } = vi.hoisted(() => ({ cfg: { registryAuthEnabled: true } }))
vi.mock('../src/config.js', () => ({ config: cfg }))
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn(async () => ({
    allowed: true,
    remaining: 29,
    resetMs: Date.now() + 60000,
  })),
}))

function makeApp(adminId: string | null = 'admin-1') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { adminAuth?: { sub: string } }).adminAuth = adminId
      ? { sub: adminId }
      : undefined
    next()
  })
  app.use(createAdminRegistryRouter())
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  cfg.registryAuthEnabled = true
  vi.mocked(checkAndIncrement).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetMs: Date.now() + 60000,
  } as never)
  vi.mocked(resolvePublishScope).mockResolvedValue({
    curator: false,
    orgName: 'acme',
    scope: '@acme',
  } as never)
})

// Safety net: a failing wire-shape test below stubs global fetch + sets
// registry env vars directly (not via the mocked wrapper), so a thrown
// assertion partway through would otherwise leak the stub/env into later
// tests. Individual tests still do their own inline cleanup; this is the backstop.
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CLERUM_REGISTRY_URL
  delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
})

describe('POST /admin/registry/grants', () => {
  it('201 forwards {pluginName,granteeOrg,actingUserId=sub} to the resolved org', async () => {
    vi.mocked(createOrgGrant).mockResolvedValue({ id: 'g1' } as never)
    const res = await request(makeApp('admin-1'))
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'g1' })
    expect(createOrgGrant).toHaveBeenCalledWith('acme', {
      pluginName: '@acme/p',
      granteeOrg: 'beta',
      actingUserId: 'admin-1',
    })
  })

  it('400 registry_self_service_unavailable on a curator deploy (never calls the wrapper)', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({
      curator: true,
      orgName: null,
      scope: null,
    } as never)
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'registry_self_service_unavailable' })
    expect(createOrgGrant).not.toHaveBeenCalled()
  })

  it('400 registry_self_service_unavailable when org is unbound (orgName null, not curator)', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({
      curator: false,
      orgName: null,
      scope: null,
    } as never)
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'registry_self_service_unavailable' })
  })

  it('forwards the upstream status AND {error:<code>} body verbatim', async () => {
    vi.mocked(createOrgGrant).mockRejectedValue(
      new RegistryProxyError(400, { error: 'grantee_not_found' })
    )
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'ghost' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'grantee_not_found' })
  })

  it('400 when pluginName/granteeOrg missing (before any registry call)', async () => {
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'missing_fields' })
    expect(createOrgGrant).not.toHaveBeenCalled()
  })

  it('409 registry_auth_disabled when registry auth is off', async () => {
    cfg.registryAuthEnabled = false
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'registry_auth_disabled' })
    expect(resolvePublishScope).not.toHaveBeenCalled()
  })

  it('401 when the admin claim is missing', async () => {
    const res = await request(makeApp(null))
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(401)
  })
})

describe('handleRegistryProxyError — a 502 RegistryProxyError forwards verbatim', () => {
  it('502 registry_integration_error when the wrapper rejects with a 502 RegistryProxyError', async () => {
    // The 401→502 remap now happens at the transport (orgRegistryFetch), not the
    // route — this exercises that handleRegistryProxyError still forwards an
    // already-502'd RegistryProxyError (e.g. from a persistent upstream 401,
    // or a non-JSON body) verbatim to the UI.
    vi.mocked(createOrgGrant).mockRejectedValue(
      new RegistryProxyError(502, { error: 'registry_integration_error' })
    )
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'registry_integration_error' })
  })

  it('403 is forwarded verbatim (not remapped — real authz signal)', async () => {
    vi.mocked(createOrgGrant).mockRejectedValue(new RegistryProxyError(403, { error: 'forbidden' }))
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })
})

describe('GET /admin/registry/grants + granted-to-me', () => {
  it('200 lists issued grants for the resolved org', async () => {
    // Real registry envelope: { grants: OrgGrant[] }.
    vi.mocked(listOrgGrants).mockResolvedValue({ grants: [{ id: 'g1' }] } as never)
    const res = await request(makeApp()).get('/admin/registry/grants')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ grants: [{ id: 'g1' }] })
    expect(listOrgGrants).toHaveBeenCalledWith('acme')
  })

  it('200 lists granted-to-me', async () => {
    // Real registry envelope: { grants: GrantedToMeItem[] }.
    vi.mocked(listGrantedToMe).mockResolvedValue({ grants: [] } as never)
    const res = await request(makeApp()).get('/admin/registry/granted-to-me')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ grants: [] })
    expect(listGrantedToMe).toHaveBeenCalledWith('acme')
  })
})

describe('DELETE /admin/registry/grants/:id', () => {
  it('204 revoke forwards actingUserId=sub', async () => {
    vi.mocked(revokeOrgGrant).mockResolvedValue(undefined as never)
    const res = await request(makeApp('admin-9')).delete('/admin/registry/grants/g1')
    expect(res.status).toBe(204)
    expect(revokeOrgGrant).toHaveBeenCalledWith('acme', 'g1', 'admin-9')
  })

  it('forwards a typed 404 body verbatim', async () => {
    vi.mocked(revokeOrgGrant).mockRejectedValue(
      new RegistryProxyError(404, { error: 'plugin_not_found' })
    )
    const res = await request(makeApp()).delete('/admin/registry/grants/gX')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'plugin_not_found' })
  })
})

describe('GET /admin/registry/owned-entries', () => {
  it('200 lists the org owned entries with pagination passthrough', async () => {
    vi.mocked(listOrgEntries).mockResolvedValue({ data: [], meta: { total: 0 } } as never)
    const res = await request(makeApp()).get('/admin/registry/owned-entries?limit=50&offset=10')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: [], meta: { total: 0 } })
    expect(listOrgEntries).toHaveBeenCalledWith('acme', { limit: 50, offset: 10 })
  })

  // The registry's /org/:org/entries actually returns { entries: [...] }, not
  // { data: [...] }. The route must normalize that to { data } so control-ui —
  // which reads response.data — never receives an undefined array.
  it('200 normalizes the registry { entries } shape to { data }', async () => {
    vi.mocked(listOrgEntries).mockResolvedValue({
      entries: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
      meta: { total: 1 },
    } as never)
    const res = await request(makeApp()).get('/admin/registry/owned-entries')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
      meta: { total: 1 },
    })
  })

  it('200 coalesces an empty/absent registry body to { data: [] }', async () => {
    vi.mocked(listOrgEntries).mockResolvedValue(undefined as never)
    const res = await request(makeApp()).get('/admin/registry/owned-entries')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: [] })
  })

  it('400 registry_self_service_unavailable on a curator deploy', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({
      curator: true,
      orgName: null,
      scope: null,
    } as never)
    const res = await request(makeApp()).get('/admin/registry/owned-entries')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'registry_self_service_unavailable' })
  })
})

describe('org isolation (G5) — org + actingUserId are never client-controlled', () => {
  it('ignores a client-supplied org/actingUserId in the POST body; uses resolvePublishScope org + sub', async () => {
    vi.mocked(createOrgGrant).mockResolvedValue({ id: 'g1' } as never)
    await request(makeApp('admin-1'))
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'beta', org: 'victim', actingUserId: 'spoof' })
    expect(createOrgGrant).toHaveBeenCalledWith('acme', {
      pluginName: '@acme/p',
      granteeOrg: 'beta',
      actingUserId: 'admin-1',
    })
  })

  it('ignores a client-supplied org in the DELETE query; uses resolvePublishScope org + sub', async () => {
    vi.mocked(revokeOrgGrant).mockResolvedValue(undefined as never)
    await request(makeApp('admin-9')).delete(
      '/admin/registry/grants/g1?org=victim&actingUserId=spoof'
    )
    expect(revokeOrgGrant).toHaveBeenCalledWith('acme', 'g1', 'admin-9')
  })
})

// ── Non-mocked wire shape (real wrappers + RegistryProxyError; only fetch stubbed) ──
// A mocked-wrapper test would hide the body-forwarding gap. This exercises the REAL
// createOrgGrant/revokeOrgGrant/orgRegistryFetch through the route with a stubbed
// registry, asserting the exact status+body control-ui receives.
describe('wire shape (real wrappers, stubbed registry fetch)', () => {
  function stubFetch(map: (url: string, init: RequestInit) => Response) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => map(url, init))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  // registry auth OFF so authedFetch's mintToken() returns '' (no token round trip);
  // every stubbed fetch call is the /org/... endpoint. The route's own
  // registry_auth_disabled guard is bypassed because we only unmock the WRAPPERS
  // here — config stays mocked with registryAuthEnabled true for the route guard,
  // while the wrapper's mintToken reads process.env (set below) = auth off.

  it('POST self_grant → 400 with {error:"self_grant"} verbatim', async () => {
    process.env.CLERUM_REGISTRY_URL = 'https://example.com'
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'false'
    // Use the REAL wrapper for exactly this one request; mockImplementationOnce
    // ensures it does not leak into any later test in this file.
    const real = await vi.importActual<typeof import('../src/services/registryClient.js')>(
      '../src/services/registryClient.js'
    )
    vi.mocked(createOrgGrant).mockImplementationOnce(real.createOrgGrant)
    real.__resetTokenCacheForTests()
    stubFetch(() => new Response(JSON.stringify({ error: 'self_grant' }), { status: 400 }))
    const res = await request(makeApp())
      .post('/admin/registry/grants')
      .send({ pluginName: '@acme/p', granteeOrg: 'acme' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'self_grant' })
    vi.unstubAllGlobals()
    delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
    delete process.env.CLERUM_REGISTRY_URL
  })

  it('DELETE 204 → 204 (no 500 from res.json on empty body)', async () => {
    process.env.CLERUM_REGISTRY_URL = 'https://example.com'
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'false'
    const real = await vi.importActual<typeof import('../src/services/registryClient.js')>(
      '../src/services/registryClient.js'
    )
    // mockImplementationOnce ensures the real wrapper is used for exactly this
    // one request and does not leak into any later test in this file.
    vi.mocked(revokeOrgGrant).mockImplementationOnce(real.revokeOrgGrant)
    real.__resetTokenCacheForTests()
    stubFetch(() => new Response(null, { status: 204 }))
    const res = await request(makeApp()).delete('/admin/registry/grants/g1')
    expect(res.status).toBe(204)
    vi.unstubAllGlobals()
    delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
    delete process.env.CLERUM_REGISTRY_URL
  })
})

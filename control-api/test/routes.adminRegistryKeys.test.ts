// control-api/test/routes.adminRegistryKeys.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { findAdminById } from '../src/services/adminAuthService.js'
import { createKey, listKeys, revokeKey } from '../src/services/orgApiKeyClient.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { resolvePublishScope } from '../src/services/registryClient.js'

vi.mock('../src/services/orgApiKeyClient.js', () => ({
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  // Re-export a matching error class so the route's instanceof/status mapping works.
  RegistryStatusError: class RegistryStatusError extends Error {
    status: number
    constructor(code: string, status: number) {
      super(code)
      this.status = status
    }
  },
}))
// The router imports many registryClient fns at module load; provide the surface.
vi.mock('../src/services/registryClient.js', () => ({
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
}))
vi.mock('../src/services/adminAuthService.js', () => ({ findAdminById: vi.fn() }))
// registryConnectionMode is required: the routes now call isRegistryAuthActive(),
// which branches on mode first. 'managed' makes it return registryAuthEnabled
// verbatim, which is the behaviour these tests intend to exercise.
const { cfg } = vi.hoisted(() => ({
  cfg: { registryAuthEnabled: true, registryConnectionMode: 'managed' },
}))
vi.mock('../src/config.js', () => ({ config: cfg }))
// Narrow mock: registry.ts imports nothing else from registryConnectionDb, so
// stubbing only the accessor it now consumes is safe.
const connDb = vi.hoisted(() => ({ isRegistryAuthActive: vi.fn() }))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)
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
  cfg.registryConnectionMode = 'managed'
  // Default mirrors the real accessor's managed-mode branch (registryAuthEnabled
  // verbatim) so the pre-existing tests below — which only flip
  // cfg.registryAuthEnabled, not this mock — still reach the same 200/409 they did
  // before this module was mocked. Reading cfg at call time (not a captured
  // literal) also means vi.clearAllMocks() can never silently freeze this to a
  // stale value. The self-hosted test overrides this per-call via
  // mockResolvedValue, independent of cfg.registryAuthEnabled.
  connDb.isRegistryAuthActive.mockImplementation(async () => cfg.registryAuthEnabled)
  vi.mocked(checkAndIncrement).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetMs: Date.now() + 60000,
  } as never)
  vi.mocked(findAdminById).mockResolvedValue({
    id: 'admin-1',
    username: 'alice',
    status: 'active',
  } as never)
  vi.mocked(resolvePublishScope).mockResolvedValue({
    curator: false,
    orgName: 'acme',
    scope: '@acme',
  } as never)
})

describe('GET /admin/registry/keys', () => {
  it('returns { org, keys } on success', async () => {
    vi.mocked(listKeys).mockResolvedValue({ keys: [{ id: 'k1' }] } as never)
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ org: 'acme', keys: [{ id: 'k1' }] })
  })

  it('409 registry_auth_disabled when auth disabled (before any registry call)', async () => {
    cfg.registryAuthEnabled = false
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'registry_auth_disabled' })
    expect(resolvePublishScope).not.toHaveBeenCalled()
  })

  it('self-hosted: keys work with NO auth env var once credentials exist', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.registryAuthEnabled = false // deliberately off — must be ignored
    connDb.isRegistryAuthActive.mockResolvedValue(true) // credentials exist
    vi.mocked(listKeys).mockResolvedValue({ keys: [{ id: 'k1' }] } as never)
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ org: 'acme', keys: [{ id: 'k1' }] })
  })

  // isRegistryAuthActive() can now reject (self-hosted reaches a raw pool.query
  // in getRegistryConnection with no try/catch of its own). The guard must catch
  // it and degrade to the same 502 used for a resolvePublishScope failure one
  // line below, rather than let the rejection escape uncaught — Express 4 does
  // not forward async rejections to error middleware, so an uncaught one here
  // would crash the process instead of producing a response.
  it('502 registry_integration_error when isRegistryAuthActive rejects (does not throw)', async () => {
    connDb.isRegistryAuthActive.mockRejectedValue(new Error('pg blip'))
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'registry_integration_error' })
    expect(resolvePublishScope).not.toHaveBeenCalled()
  })

  it('401 when admin missing/inactive', async () => {
    vi.mocked(findAdminById).mockResolvedValue(null as never)
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(401)
  })

  it('409 no_org when the client is not org-bound (after a force refresh)', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({
      curator: true,
      orgName: null,
      scope: null,
    } as never)
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'no_org' })
    expect(resolvePublishScope).toHaveBeenCalledWith({ force: true })
  })

  it('forwards a 403 with org included', async () => {
    const { RegistryStatusError } = await import('../src/services/orgApiKeyClient.js')
    vi.mocked(listKeys).mockRejectedValue(new RegistryStatusError('forbidden', 403))
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden', org: 'acme' })
  })

  it('429 when the per-admin rate limit is exceeded', async () => {
    vi.mocked(checkAndIncrement).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60000,
    } as never)
    const res = await request(makeApp()).get('/admin/registry/keys')
    expect(res.status).toBe(429)
  })
})

describe('POST /admin/registry/keys', () => {
  it('201 returns the one-time key payload', async () => {
    vi.mocked(createKey).mockResolvedValue({
      id: 'k1',
      key: 'efrk_x',
      key_prefix: 'efrk_x',
      scopes: [],
      expires_at: null,
    } as never)
    const res = await request(makeApp()).post('/admin/registry/keys').send({ description: 'ci' })
    expect(res.status).toBe(201)
    expect(res.body.key).toBe('efrk_x')
  })

  it('passes through dockerconfigjson/registry/username when the registry returns them', async () => {
    vi.mocked(createKey).mockResolvedValue({
      id: 'k2',
      key: 'efrk_pub',
      key_prefix: 'efrk_pub',
      scopes: ['registry:read', 'registry:publish'],
      expires_at: null,
      dockerconfigjson: 'eyJhdXRocyI6e30=',
      registry: 'registry.evenfire.ai',
      username: '_',
    } as never)
    const res = await request(makeApp())
      .post('/admin/registry/keys')
      .send({ description: 'ci-push' })
    expect(res.status).toBe(201)
    expect(res.body.dockerconfigjson).toBe('eyJhdXRocyI6e30=')
    expect(res.body.registry).toBe('registry.evenfire.ai')
    expect(res.body.username).toBe('_')
  })

  it('forwards a 409 too_many_keys code', async () => {
    const { RegistryStatusError } = await import('../src/services/orgApiKeyClient.js')
    vi.mocked(createKey).mockRejectedValue(new RegistryStatusError('too_many_keys', 409))
    const res = await request(makeApp()).post('/admin/registry/keys').send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'too_many_keys' })
  })

  it('maps a 502 integration error (not 500)', async () => {
    const { RegistryStatusError } = await import('../src/services/orgApiKeyClient.js')
    vi.mocked(createKey).mockRejectedValue(
      new RegistryStatusError('registry_integration_error', 502)
    )
    const res = await request(makeApp()).post('/admin/registry/keys').send({})
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'registry_integration_error' })
  })
})

describe('DELETE /admin/registry/keys/:id', () => {
  it('204 on revoke', async () => {
    vi.mocked(revokeKey).mockResolvedValue(undefined as never)
    const res = await request(makeApp()).delete('/admin/registry/keys/k1')
    expect(res.status).toBe(204)
  })
})

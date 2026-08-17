import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  // R1-H3 fase 1: the reductor gate now runs inside a carrier transaction. Route
  // the transaction client's queries through the SAME `mockPoolQuery` so the
  // sequenced expectations are unchanged; the advisory lock / idle-timeout guards
  // are no-ops here (serialization is covered by the real-Postgres race test).
  withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
    work({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
  advisoryLockModelName: async () => {},
  advisoryLockModelNames: async () => {},
  boundCarrierTransactionIdleTimeout: async () => {},
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

const mockSyncDiscoveredModels = vi.fn()
const mockGetLastCatalogSyncRun = vi.fn()

vi.mock('../src/services/llmCatalogSync.js', () => ({
  syncDiscoveredModels: (...args: unknown[]) => mockSyncDiscoveredModels(...args),
  getLastCatalogSyncRun: (...args: unknown[]) => mockGetLastCatalogSyncRun(...args),
}))

const ADMIN_CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: Math.floor(Date.now() / 1000) + 3600,
}

const ACTIVE_ADMIN = {
  id: ADMIN_CLAIMS.sub,
  username: 'admin',
  email: 'admin@example.com',
  passwordHash: 'hash',
  sessionVersion: 0,
  role: 'admin' as const,
  status: 'active' as const,
  failedAttempts: 0,
  lockedUntil: null,
}

const MODEL_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: null,
  context_window_tokens: 200000,
  enabled: true,
  source: 'manual',
  discovered_at: null,
  last_seen_at: null,
  stale: false,
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
}

function app(gateway: MockGateway = new MockGateway('mcp-server')) {
  return createApp(gateway as never)
}

function authed(method: 'get' | 'post' | 'put' | 'delete', path: string, gateway?: MockGateway) {
  return request(app(gateway))[method](path).set('Cookie', 'control_ui_admin_session=admin-token')
}

describe('admin llm-models routes', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
    mockSyncDiscoveredModels.mockReset()
    mockGetLastCatalogSyncRun.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated requests with 401', async () => {
    await request(app()).get('/api/v1/admin/llm-models').expect(401)
  })

  it('POST /admin/llm-models/discovery/sync runs the sync and does NOT materialize the ConfigMap', async () => {
    const summary = {
      source: 'vendored' as const,
      fetchedAt: '2026-07-13T00:00:00.000Z',
      ranAt: '2026-07-13T00:00:05.000Z',
      added: 3,
      updated: 5,
      staled: 1,
    }
    mockSyncDiscoveredModels.mockResolvedValueOnce(summary)
    const gateway = new MockGateway('mcp-server')
    const materialize = vi.fn(async () => {})
    gateway.setLlmAllowedModelsConfigMapMaterialize(materialize)

    const res = await authed('post', '/api/v1/admin/llm-models/discovery/sync', gateway).expect(200)
    expect(res.body).toEqual(summary)
    expect(mockSyncDiscoveredModels).toHaveBeenCalledTimes(1)
    // Discovery writes enabled=false rows → the allowlist ConfigMap must NOT be
    // re-materialized (it would be a no-op, but the invariant is asserted here).
    expect(materialize).not.toHaveBeenCalled()
  })

  it('POST /admin/llm-models/discovery/sync requires admin auth (401 unauthenticated)', async () => {
    await request(app()).post('/api/v1/admin/llm-models/discovery/sync').expect(401)
    expect(mockSyncDiscoveredModels).not.toHaveBeenCalled()
  })

  it('GET /admin/llm-models/discovery/status returns the last run summary', async () => {
    const lastRun = {
      id: 'run-1',
      ranAt: '2026-07-13T00:00:00.000Z',
      source: 'live' as const,
      added: 2,
      updated: 0,
      staled: 0,
    }
    mockGetLastCatalogSyncRun.mockResolvedValueOnce(lastRun)
    const res = await authed('get', '/api/v1/admin/llm-models/discovery/status').expect(200)
    expect(res.body.lastRun).toEqual(lastRun)
  })

  it('GET /admin/llm-models/discovery/status returns null lastRun when none has run', async () => {
    mockGetLastCatalogSyncRun.mockResolvedValueOnce(null)
    const res = await authed('get', '/api/v1/admin/llm-models/discovery/status').expect(200)
    expect(res.body.lastRun).toBeNull()
  })

  it('GET /admin/llm-models returns rows (including disabled for pickers)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        MODEL_ROW,
        {
          ...MODEL_ROW,
          id: '2',
          enabled: false,
          source: 'discovery',
          discovered_at: new Date('2026-07-10T00:00:00Z'),
          last_seen_at: new Date('2026-07-11T00:00:00Z'),
          stale: true,
        },
      ],
      rowCount: 2,
    })
    const res = await authed('get', '/api/v1/admin/llm-models').expect(200)
    expect(res.body.rows).toHaveLength(2)
    expect(res.body.rows[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      vendor: 'Anthropic',
      context_window_tokens: 200000,
      enabled: true,
      // F1 catalog lifecycle fields surface read-only on the admin table.
      source: 'manual',
      discovered_at: null,
      last_seen_at: null,
      stale: false,
    })
    expect(res.body.rows[1]).toMatchObject({
      enabled: false,
      source: 'discovery',
      discovered_at: '2026-07-10T00:00:00.000Z',
      last_seen_at: '2026-07-11T00:00:00.000Z',
      stale: true,
    })
  })

  it('GET /admin/llm-models/:id returns 404 for a non-UUID id without hitting the DB', async () => {
    await authed('get', '/api/v1/admin/llm-models/not-a-uuid').expect(404)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/llm-models creates a model and materializes the ConfigMap', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // INSERT ... RETURNING
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
    const res = await authed('post', '/api/v1/admin/llm-models')
      .send({ provider: 'claude', model: 'claude-haiku-4-5', vendor: 'Anthropic' })
      .expect(201)
    expect(res.body.provider).toBe('claude')
    // insert + audit
    expect(mockPoolQuery.mock.calls.length).toBeGreaterThanOrEqual(2)
    const auditCall = mockPoolQuery.mock.calls.find(c =>
      /llm_allowed_models_audit/.test(String(c[0]))
    )
    expect(auditCall).toBeDefined()
    expect((auditCall![1] as unknown[])[1]).toBe('create')
  })

  it('POST /admin/llm-models rejects an empty provider with 400', async () => {
    await authed('post', '/api/v1/admin/llm-models').send({ model: 'x' }).expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/llm-models maps a unique violation to 409', async () => {
    mockPoolQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await authed('post', '/api/v1/admin/llm-models')
      .send({ provider: 'claude', model: 'claude-haiku-4-5' })
      .expect(409)
    expect(res.body.error).toBe('conflict')
  })

  it('POST /admin/llm-models returns 503 when the ConfigMap write fails (row still saved)', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.setLlmAllowedModelsConfigMapMaterialize(async () => {
      throw new Error('apiserver down')
    })
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
    const res = await authed('post', '/api/v1/admin/llm-models', gateway)
      .send({ provider: 'claude', model: 'claude-haiku-4-5' })
      .expect(503)
    expect(res.body.error).toBe('configmap_write_failed')
  })

  it('PUT /admin/llm-models/:id updates and returns 200', async () => {
    // A disable (enabled true→false) now runs the availability-reduction gate
    // first: gate read + grant-impact query + the update's own read/UPDATE/audit.
    // Hosts come from the (empty) MockGateway store, so there is no impact and
    // the write proceeds.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // gate getAllowedModel
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // grant-impact query → none
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // updateAllowedModel read
      .mockResolvedValueOnce({ rows: [{ ...MODEL_ROW, enabled: false }], rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
    const res = await authed('put', `/api/v1/admin/llm-models/${MODEL_ROW.id}`)
      .send({ enabled: false })
      .expect(200)
    expect(res.body.enabled).toBe(false)
    const auditCall = mockPoolQuery.mock.calls.find(c =>
      /llm_allowed_models_audit/.test(String(c[0]))
    )
    expect((auditCall![1] as unknown[])[1]).toBe('disable')
  })

  it('PUT /admin/llm-models/:id rejects an empty body with 400', async () => {
    await authed('put', `/api/v1/admin/llm-models/${MODEL_ROW.id}`).send({}).expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('PUT /admin/llm-models/:id returns 404 when the row is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getAllowedModel → none
    await authed('put', `/api/v1/admin/llm-models/${MODEL_ROW.id}`)
      .send({ enabled: false })
      .expect(404)
  })

  it('DELETE /admin/llm-models/:id returns 204 on success', async () => {
    // A DELETE always runs the impact gate first: gate read + grant-impact query,
    // then the delete's own read/DELETE/audit. Empty MockGateway → no impact.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // gate getAllowedModel
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // grant-impact query → none
      .mockResolvedValueOnce({ rows: [MODEL_ROW], rowCount: 1 }) // deleteAllowedModel read
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ROW.id}`).expect(204)
  })

  it('DELETE /admin/llm-models/:id returns 404 when the row is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getAllowedModel → none
    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ROW.id}`).expect(404)
  })
})

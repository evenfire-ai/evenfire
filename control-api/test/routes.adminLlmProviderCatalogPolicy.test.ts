import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { PROVIDER_KEY_MAP } from '../src/services/modelsDevClient.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockTxQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
    work({ query: (...args: unknown[]) => mockTxQuery(...args) }),
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
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

const UPDATED_AT = new Date('2026-10-30T12:00:00.000Z')

function authed(method: 'get' | 'put', path: string) {
  return request(createApp(new MockGateway('mcp-server') as never))
    [method](path)
    .set('Cookie', 'control_ui_admin_session=admin-token')
}

// Route the tx client by statement: the lock, the pre-read, the upsert.
function stubToggleTx(previous: { auto_enable: boolean } | null, autoEnable: boolean) {
  mockTxQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }
    if (sql.includes('INSERT INTO llm_provider_catalog_settings')) {
      return {
        rows: [
          {
            provider: params[0],
            auto_enable: autoEnable,
            updated_at: UPDATED_AT,
            updated_by: params[2],
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM llm_provider_catalog_settings')) {
      return previous
        ? {
            rows: [{ provider: params[0], ...previous, updated_at: UPDATED_AT, updated_by: 'x' }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected tx query: ${sql}`)
  })
}

describe('admin llm-provider catalog-policy routes', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockTxQuery.mockReset()
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated requests with 401', async () => {
    await request(createApp(new MockGateway('mcp-server') as never))
      .get('/api/v1/admin/llm-providers/catalog-policy')
      .expect(401)
    await request(createApp(new MockGateway('mcp-server') as never))
      .put('/api/v1/admin/llm-providers/openai/catalog-policy')
      .send({ auto_enable: false })
      .expect(401)
  })

  it('GET lists every catalog-mapped provider with effective, default and overridden', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { provider: 'openai', auto_enable: false, updated_at: UPDATED_AT, updated_by: 'admin-1' },
        { provider: 'groq', auto_enable: true, updated_at: UPDATED_AT, updated_by: 'admin-2' },
        // A row for a provider no longer in the code is ignored, not surfaced.
        { provider: 'retired', auto_enable: true, updated_at: UPDATED_AT, updated_by: null },
      ],
      rowCount: 3,
    })

    const res = await authed('get', '/api/v1/admin/llm-providers/catalog-policy').expect(200)
    const providers = res.body.providers as Array<Record<string, unknown>>

    expect(providers.map(p => p.provider)).toEqual(Object.keys(PROVIDER_KEY_MAP))
    expect(providers.find(p => p.provider === 'openai')).toEqual({
      provider: 'openai',
      auto_enable: false,
      default: true,
      overridden: true,
      updated_at: UPDATED_AT.toISOString(),
      updated_by: 'admin-1',
    })
    expect(providers.find(p => p.provider === 'groq')).toMatchObject({
      auto_enable: true,
      default: false,
      overridden: true,
    })
    for (const entry of providers.filter(p => p.provider !== 'openai' && p.provider !== 'groq')) {
      const id = entry.provider as keyof typeof PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT
      expect(entry).toEqual({
        provider: id,
        auto_enable: PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[id],
        default: PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[id],
        overridden: false,
        updated_at: null,
        updated_by: null,
      })
    }
    expect(providers.some(p => String(p.provider).endsWith('-subscription'))).toBe(false)
  })

  it.each([false, true])(
    'GET reports whether this replica has auto-enable switched on (%s)',
    async flag => {
      const previous = config.llmCatalogAutoEnableEnabled
      config.llmCatalogAutoEnableEnabled = flag
      try {
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
        const res = await authed('get', '/api/v1/admin/llm-providers/catalog-policy').expect(200)
        expect(res.body.auto_enable_enabled).toBe(flag)
        expect(Array.isArray(res.body.providers)).toBe(true)
      } finally {
        config.llmCatalogAutoEnableEnabled = previous
      }
    }
  )

  it('PUT upserts under the catalog-sync lock and returns the updated entry', async () => {
    stubToggleTx(null, false)

    const res = await authed('put', '/api/v1/admin/llm-providers/openai/catalog-policy')
      .send({ auto_enable: false })
      .expect(200)

    expect(res.body).toEqual({
      provider: 'openai',
      auto_enable: false,
      default: true,
      overridden: true,
      updated_at: UPDATED_AT.toISOString(),
      updated_by: ADMIN_CLAIMS.sub,
    })
    const sqls = mockTxQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls[0]).toContain('pg_advisory_xact_lock')
    expect(mockTxQuery.mock.calls[0]![1]).toEqual(['llm-catalog-sync-v1'])
    const upsert = mockTxQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO llm_provider_catalog_settings')
    )!
    expect(upsert[1]).toEqual(['openai', false, ADMIN_CLAIMS.sub])
  })

  it.each([
    'codex-subscription',
    'grok-subscription',
    'not-a-provider',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ])('PUT 404s %s without touching the database', async provider => {
    const res = await authed('put', `/api/v1/admin/llm-providers/${provider}/catalog-policy`)
      .send({ auto_enable: true })
      .expect(404)
    expect(res.body.error).toBe('not_found')
    expect(mockTxQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['missing field', {}],
    ['non-boolean', { auto_enable: 'true' }],
    ['unknown key', { auto_enable: true, provider: 'groq' }],
  ])('PUT 400s a body with a %s', async (_label, body) => {
    const res = await authed('put', '/api/v1/admin/llm-providers/openai/catalog-policy')
      .send(body)
      .expect(400)
    expect(res.body.error).toBe('invalid_request')
    expect(mockTxQuery).not.toHaveBeenCalled()
  })

  it('PUT maps a lock-wait statement timeout to a retryable 503', async () => {
    mockTxQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        throw Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        })
      }
      throw new Error(`unexpected tx query: ${sql}`)
    })

    const res = await authed('put', '/api/v1/admin/llm-providers/claude/catalog-policy')
      .send({ auto_enable: false })
      .expect(503)
    expect(res.body.error).toBe('catalog_sync_in_progress')
  })

  it.each([
    ['the pre-read', 'FROM llm_provider_catalog_settings'],
    ['the upsert', 'INSERT INTO llm_provider_catalog_settings'],
  ])(
    'PUT does not map a timeout in %s (after the lock) to the retryable 503',
    async (_label, failing) => {
      mockTxQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }
        if (sql.includes(failing)) {
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          })
        }
        if (sql.includes('FROM llm_provider_catalog_settings')) return { rows: [], rowCount: 0 }
        throw new Error(`unexpected tx query: ${sql} ${String(params)}`)
      })

      const res = await authed('put', '/api/v1/admin/llm-providers/claude/catalog-policy')
        .send({ auto_enable: false })
        .expect(500)
      expect(res.body.error).not.toBe('catalog_sync_in_progress')
      expect(mockTxQuery.mock.calls.some(([sql]) => String(sql).includes(failing))).toBe(true)
    }
  )
})

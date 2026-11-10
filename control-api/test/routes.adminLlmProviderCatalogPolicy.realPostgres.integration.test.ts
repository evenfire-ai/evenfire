import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The catalog-policy routes over real PostgreSQL: the JSON an operator sees
// comes from rows Postgres actually stored, including the NULL a reset writes.
// Only the admin session check is stubbed. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

const mockVerifyAdminToken = vi.fn()
vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: async () => ({
    id: ADMIN_SUB,
    username: 'admin',
    email: 'admin@example.com',
    passwordHash: 'hash',
    sessionVersion: 0,
    role: 'admin',
    status: 'active',
    failedAttempts: 0,
    lockedUntil: null,
  }),
  isAdminTokenRevoked: async () => false,
}))

const ADMIN_SUB = '00000000-0000-4000-8000-000000000001'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`

describeRealPostgres('admin catalog-policy routes on real PostgreSQL', () => {
  const database = `control_api_catalog_policy_route_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING
  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let app: Parameters<typeof request>[0]

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await endPoolAndWaitForClients(migratePool)

    // Imported only now: config captures the connection string when first loaded.
    const { MockGateway } = await import('./mockGateway.js')
    const { createApp } = await import('../src/app.js')
    app = createApp(new MockGateway('mcp-server') as never)
  })

  afterEach(async () => {
    await corePool.query('DELETE FROM llm_provider_catalog_settings')
  })

  afterAll(async () => {
    try {
      if (corePool) await endPoolAndWaitForClients(corePool)
      if (limiterPool) await endPoolAndWaitForClients(limiterPool)
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  function authed(method: 'get' | 'put', path: string) {
    mockVerifyAdminToken.mockReturnValue({
      sub: ADMIN_SUB,
      typ: 'user',
      role: 'admin',
      jti: 'admin-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    return request(app)[method](path).set('Cookie', 'control_ui_admin_session=admin-token')
  }

  const put = (provider: string, body: unknown) =>
    authed('put', `/api/v1/admin/llm-providers/${provider}/catalog-policy`).send(body as object)

  async function listed(provider: string) {
    const res = await authed('get', '/api/v1/admin/llm-providers/catalog-policy').expect(200)
    return (res.body.providers as Array<Record<string, unknown>>).find(p => p.provider === provider)
  }

  it.each([
    ['claude', false],
    ['groq', true],
  ] as const)(
    'PUT null on %s resets to the code default and GET agrees',
    async (provider, against) => {
      const codeDefault = PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[provider]
      expect(against).toBe(!codeDefault)
      const set = await put(provider, { auto_enable: against }).expect(200)
      expect(set.body).toMatchObject({ auto_enable: against, overridden: true })

      const reset = await put(provider, { auto_enable: null }).expect(200)
      expect(reset.body).toEqual({
        provider,
        auto_enable: codeDefault,
        default: codeDefault,
        overridden: false,
        updated_at: expect.any(String),
        updated_by: ADMIN_SUB,
      })
      expect(await listed(provider)).toEqual(reset.body)
    }
  )

  it('PUT with the default value itself still reports an override', async () => {
    const res = await put('claude', { auto_enable: true }).expect(200)
    expect(res.body).toMatchObject({ auto_enable: true, default: true, overridden: true })
    expect(await listed('claude')).toEqual(res.body)
  })

  it.each([
    ['missing field', {}],
    ['a string', { auto_enable: 'x' }],
  ])('PUT 400s %s and stores nothing', async (_label, body) => {
    const res = await put('claude', body).expect(400)
    expect(res.body.error).toBe('invalid_request')
    const { rowCount } = await corePool.query('SELECT 1 FROM llm_provider_catalog_settings')
    expect(rowCount).toBe(0)
  })
})

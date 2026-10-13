import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createPublicKey, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const quotaHeaders = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit',
  'ratelimit-policy',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
]
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('RP-003 complete password admission response metadata', () => {
  const database = `rp003_${randomBytes(6).toString('hex')}`
  const email = 'shadow@example.invalid'
  const serviceToken = `synthetic-${randomBytes(16).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let engine: typeof import('../src/services/auth/passwordCredentialVerification.js')
  let app: express.Express, edge: express.Express, server: Server
  let externalConfig: (typeof import('../../external-rest-api/src/config.js'))['config']
  let previousUrl: string, previousToken: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', url.toString())
    vi.stubEnv('CONTROL_API_INTERNAL_SERVICE_TOKENS', `external-rest-api=${serviceToken}`)
    vi.stubEnv(
      'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
      createPublicKey(process.env.CONTROL_API_SESSION_JWT_PRIVATE_KEY!)
        .export({ type: 'spki', format: 'pem' })
        .toString()
    )
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    engine = await import('../src/services/auth/passwordCredentialVerification.js')
    const { requireInternalToken } = await import('../src/middleware/internalServiceAuth.js')
    const { createExternalAuthRouter } = await import('../src/routes/external/auth.js')
    app = express()
    app.use(express.json())
    app.use(requireInternalToken)
    app.use(createExternalAuthRouter({} as Parameters<typeof createExternalAuthRouter>[0]))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    externalConfig = (await import('../../external-rest-api/src/config.js')).config
    previousUrl = externalConfig.controlApiBaseUrl
    previousToken = externalConfig.controlApiServiceToken
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    externalConfig.controlApiServiceToken = serviceToken
    const { withExternalRequestContext } =
      await import('../../external-rest-api/src/requestContext.js')
    const { createAuthRouter } = await import('../../external-rest-api/src/routes/auth.js')
    edge = express()
    edge.set('trust proxy', 1)
    edge.use(express.json())
    edge.use(withExternalRequestContext)
    edge.use('/api/v1', createAuthRouter())
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.pool.query(
      'TRUNCATE password_identifier_state, password_verification_pace, rate_limit_buckets'
    )
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      if (externalConfig) {
        externalConfig.controlApiBaseUrl = previousUrl
        externalConfig.controlApiServiceToken = previousToken
      }
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      if (db) {
        await endPoolAndWaitForClients(db.pool)
        await endPoolAndWaitForClients(db.rateLimitPool)
      }
      if (admin) await admin.query(`DROP DATABASE "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })
  async function cooldown() {
    for (let i = 0; i < 5; i++)
      await engine.completePasswordEvaluation(
        await engine.capturePasswordEvaluation(email, false),
        false
      )
  }
  function assertDenial(response: request.Response, status: number) {
    expect(response.status).toBe(status)
    for (const header of quotaHeaders) expect(response.headers[header], header).toBeUndefined()
    expect(response.body.retryAfterSeconds).toBe(Number(response.headers['retry-after']))
    expect(response.headers['cache-control']).toBe('no-store')
  }
  function internalLogin() {
    return request(app)
      .post('/external/auth/password-login')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-external-client-ip', '192.0.2.18')
      .send({ email, password: 'synthetic-wrong' })
  }
  it('removes every source quota family when identifier cooldown denies internally', async () => {
    await cooldown()
    assertDenial(await internalLogin(), 429)
  })
  it('preserves sanitized retry metadata through the authenticated two-service seam', async () => {
    await cooldown()
    assertDenial(
      await request(edge)
        .post('/api/v1/auth/password-login')
        .set('X-Forwarded-For', '192.0.2.19')
        .send({ email, password: 'synthetic-wrong' }),
      429
    )
  })
  it('removes every source quota family on credential authority unavailability', async () => {
    const query = db.pool.query.bind(db.pool)
    vi.spyOn(db.pool, 'query').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('FROM users WHERE email'))
        return Promise.reject(new Error('synthetic backend failure'))
      return (query as Function)(...args)
    })
    assertDenial(await internalLogin(), 503)
  })
})

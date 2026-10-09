import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const flow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => flow)

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('R2-H1 invitation admission identity on PostgreSQL', () => {
  const database = `r2h1_invite_${randomBytes(6).toString('hex')}`
  const serviceToken = `synthetic-external-rest-${randomBytes(20).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let controlApp: express.Express
  let controlServer: Server
  let edge: express.Express
  let externalConfig: (typeof import('../../external-rest-api/src/config.js'))['config']
  let previousBaseUrl: string
  let previousServiceToken: string

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(adminUrl!)
    databaseUrl.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', databaseUrl.toString())
    vi.stubEnv('CONTROL_API_INTERNAL_SERVICE_TOKENS', `external-rest-api=${serviceToken}`)
    vi.stubEnv('EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN', serviceToken)
    vi.stubEnv('EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME', 'external-rest-api')
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    vi.stubEnv(
      'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    )
    vi.resetModules()

    db = await import('../src/db.js')
    await db.initDb()
    const { requireInternalService, requireInternalToken } =
      await import('../src/middleware/internalServiceAuth.js')
    const { createExternalInvitationsRouter } =
      await import('../src/routes/external/invitations.js')
    controlApp = express()
    controlApp.use(express.json())
    controlApp.use(requireInternalToken)
    const api = express.Router()
    api.use('/external', requireInternalService('external-rest-api'))
    api.use(createExternalInvitationsRouter())
    controlApp.use('/api/v1', api)
    controlServer = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => controlServer.once('listening', resolve))

    externalConfig = (await import('../../external-rest-api/src/config.js')).config
    previousBaseUrl = externalConfig.controlApiBaseUrl
    previousServiceToken = externalConfig.controlApiServiceToken
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${(controlServer.address() as { port: number }).port}/api/v1`
    externalConfig.controlApiServiceToken = serviceToken
    const { ControlApiError, controlApiRequest } =
      await import('../../external-rest-api/src/controlApiClient.js')
    const { withExternalRequestContext } =
      await import('../../external-rest-api/src/requestContext.js')

    // This test edge uses the production request-context middleware and
    // Control API client. The client, rather than the test, produces the
    // authenticated x-external-client-ip header consumed by Control API.
    edge = express()
    edge.set('trust proxy', 1)
    edge.use(express.json())
    edge.use(withExternalRequestContext)
    edge.get('/probe/preview/:token', async (req, res, next) => {
      try {
        res
          .status(200)
          .json(await controlApiRequest('GET', `/external/invitations/token/${req.params.token}`))
      } catch (error) {
        if (error instanceof ControlApiError) {
          res.status(error.status).json(error.body)
          return
        }
        next(error)
      }
    })
    edge.post('/probe/complete', async (req, res, next) => {
      try {
        res.status(200).json(
          await controlApiRequest('POST', '/external/invitations/password-token', {
            body: req.body,
          })
        )
      } catch (error) {
        if (error instanceof ControlApiError) {
          res.status(error.status).json(error.body)
          return
        }
        next(error)
      }
    })
  }, 60_000)

  beforeEach(async () => {
    flow.validateInvitationFlowToken.mockReset().mockRejectedValue(new Error('invalid proof'))
    await db.pool.query('TRUNCATE rate_limit_buckets')
  })

  afterAll(async () => {
    try {
      if (externalConfig) {
        externalConfig.controlApiBaseUrl = previousBaseUrl
        externalConfig.controlApiServiceToken = previousServiceToken
      }
      if (controlServer) {
        await new Promise<void>((resolve, reject) =>
          controlServer.close(error => (error ? reject(error) : resolve()))
        )
      }
      if (db) {
        await endPoolAndWaitForClients(db.pool)
        await endPoolAndWaitForClients(db.rateLimitPool)
      }
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })

  async function preview(source: string) {
    return request(edge)
      .get('/probe/preview/not-a-signed-flow-token')
      .set('X-Forwarded-For', source)
  }

  async function complete(source: string) {
    return request(edge).post('/probe/complete').set('X-Forwarded-For', source).send({
      email: 'synthetic-member@example.invalid',
      token: 'invalid',
      invitationId: '00000000-0000-4000-8000-000000000001',
      password: 'Synthetic-Password-12',
    })
  }

  it('keeps preview traffic out of the same source completion budget', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await preview('198.51.100.11')
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_invitation' })
    }

    const response = await complete('198.51.100.11')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_invitation' })
    expect(flow.validateInvitationFlowToken).toHaveBeenCalledTimes(11)
  })

  it('isolates completion budgets by the trusted external client identity', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await complete('198.51.100.21')
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_invitation' })
    }

    const response = await complete('198.51.100.22')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_invitation' })
    expect(flow.validateInvitationFlowToken).toHaveBeenCalledTimes(11)
  })

  it('does not trust an asserted source when the internal service gate rejects the caller', async () => {
    const response = await request(controlApp)
      .post('/api/v1/external/invitations/password-token')
      .set('x-external-client-ip', '198.51.100.99')
      .send({})

    expect(response.status).toBe(401)
    expect(await db.pool.query('SELECT bucket_key FROM rate_limit_buckets')).toMatchObject({
      rows: [],
    })
    expect(flow.validateInvitationFlowToken).not.toHaveBeenCalled()
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
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
  let edge: string
  let publicProcess: ExternalRestHttpProcess
  let completionPosts = 0
  let invitationId: string
  let invitationToken: string
  const email = 'synthetic-member@example.invalid'
  const completionProof = 'synthetic-owned-completion-proof'

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
    await db.pool.query('INSERT INTO users(email) VALUES ($1)', [email])
    const { createSilentPasswordResetInvitation } =
      await import('../src/services/directory/passwordResetInvitations.js')
    const invitation = await createSilentPasswordResetInvitation({
      email,
      inviteeName: 'Synthetic admission principal',
    })
    invitationId = invitation.id
    invitationToken = invitation.token
    const { requireInternalService, requireInternalToken } =
      await import('../src/middleware/internalServiceAuth.js')
    const { createExternalInvitationsRouter } =
      await import('../src/routes/external/invitations.js')
    controlApp = express()
    controlApp.use(express.json())
    controlApp.use(requireInternalToken)
    controlApp.use((req, _res, next) => {
      if (req.method === 'POST' && req.path === '/api/v1/external/invitations/password-token')
        completionPosts++
      next()
    })
    const api = express.Router()
    api.use('/external', requireInternalService('external-rest-api'))
    api.use(createExternalInvitationsRouter())
    controlApp.use('/api/v1', api)
    controlServer = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => controlServer.once('listening', resolve))

    publicProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: `http://127.0.0.1:${(controlServer.address() as { port: number }).port}/api/v1`,
      controlApiServiceToken: serviceToken,
      jwtPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    })
    edge = publicProcess.baseUrl
  }, 60_000)

  beforeEach(async () => {
    completionPosts = 0
    flow.validateInvitationFlowToken
      .mockReset()
      .mockImplementation(async (token: string, claimedEmail?: string) => {
        if (token === completionProof && claimedEmail === undefined) {
          return { email, invitationUuid: invitationToken }
        }
        throw new Error('invalid proof')
      })
    await db.pool.query('TRUNCATE rate_limit_buckets')
  })

  afterAll(async () => {
    let childCleanup: PromiseSettledResult<void | undefined> | undefined
    try {
      ;[childCleanup] = await Promise.allSettled([publicProcess?.stop()])
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
    if (childCleanup?.status === 'rejected') throw childCleanup.reason
  })

  async function preview(source: string) {
    return request(edge)
      .get('/api/v1/invitations/token/not-a-signed-flow-token')
      .set('X-Forwarded-For', source)
  }

  async function complete(source: string) {
    return request(edge).post('/api/v1/invitations/password').set('X-Forwarded-For', source).send({
      email,
      token: completionProof,
      invitationId,
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
    expect(completionPosts).toBe(1)
    const buckets = (await db.pool.query('SELECT bucket_key FROM rate_limit_buckets')).rows.map(
      row => row.bucket_key
    )
    expect(buckets).toContain('invite-token:password-token:external-client-ip:198.51.100.11')
    expect(buckets).toContain('invite-token:preview:external-client-ip:198.51.100.11')
    expect(flow.validateInvitationFlowToken).toHaveBeenCalledTimes(12)
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
    expect(completionPosts).toBe(11)
    const buckets = (await db.pool.query('SELECT bucket_key FROM rate_limit_buckets')).rows.map(
      row => row.bucket_key
    )
    expect(buckets).toContain('invite-token:password-token:external-client-ip:198.51.100.21')
    expect(buckets).toContain('invite-token:password-token:external-client-ip:198.51.100.22')
    expect(flow.validateInvitationFlowToken).toHaveBeenCalledTimes(22)
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

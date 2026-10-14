import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { type Server } from 'node:http'
import { Pool } from 'pg'
import { config as controlConfig } from '../src/config.js'
import { initDb } from '../src/db.js'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { createSilentPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const flow = vi.hoisted(() => ({ validateInvitationFlowToken: vi.fn() }))

vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    corePool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      fn: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(fn, holder.pool, options),
  }
})

vi.mock('../src/services/invitationFlowRegistrationService.js', async importOriginal => {
  const real =
    await importOriginal<typeof import('../src/services/invitationFlowRegistrationService.js')>()
  return { ...real, validateInvitationFlowToken: flow.validateInvitationFlowToken }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const internalToken = 'Synthetic-R6-Retired-Route-Internal-Token'
const originalPassword = 'R6-Synthetic-Original-Password'
const resetPassword = 'R6-Synthetic-Replacement-Password'

realPg('R6 retired-user password reset route and public mapping (PostgreSQL)', () => {
  const database = `r6_retired_${randomBytes(6).toString('hex')}`
  const email = `r6-retired-${randomUUID()}@example.invalid`
  let admin: Pool
  let server: Server
  let producerApp: express.Express
  let app: string
  let publicProcess: ExternalRestHttpProcess
  let userId: string
  let invitationId: string
  let invitationToken: string
  let initialHash: string
  let publicAddress: string
  const oldInternalToken = controlConfig.internalServiceTokens['external-rest-api']
  const oldExternalJwtPublicKey = process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: url.toString() })
    await initDb(holder.pool)
    initialHash = await bcrypt.hash(originalPassword, 12)
    const user = await holder.pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, initialHash]
    )
    userId = String(user.rows[0].id)
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'R6 synthetic retired member',
      email,
    })
    invitationId = invitation.id
    invitationToken = invitation.token
    const actor = await holder.pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
      [`r6-retirement-actor-${randomUUID()}@example.invalid`, initialHash]
    )
    await retireDesktopUser(
      { kind: 'platform_user', desktopUserId: String(actor.rows[0].id) },
      userId,
      'R6 synthetic test retirement',
      `r6-retire-${randomUUID()}`,
      `r6-request-${randomUUID()}`,
      { retainWithoutLinkHistory: true }
    )
    controlConfig.internalServiceTokens['external-rest-api'] = internalToken
    flow.validateInvitationFlowToken.mockImplementation(
      async (token: string, claimedEmail?: string) => {
        if (token !== 'r6-synthetic-retired-reset-proof') throw new Error('invalid proof')
        if (claimedEmail && claimedEmail.toLowerCase() !== email) throw new Error('wrong email')
        return { email, invitationUuid: invitationToken }
      }
    )

    producerApp = express()
    producerApp.use(express.json())
    producerApp.use('/api/v1', requireInternalToken, createExternalInvitationsRouter())
    server = producerApp.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Control API did not bind TCP')
    publicAddress = `http://127.0.0.1:${address.port}`

    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = createPublicKey(
      controlConfig.sessionJwtPrivateKey
    )
      .export({ type: 'spki', format: 'pem' })
      .toString()
    publicProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: `${publicAddress}/api/v1`,
      controlApiServiceToken: internalToken,
      jwtPrivateKey: controlConfig.sessionJwtPrivateKey,
    })
    app = publicProcess.baseUrl
  }, 60_000)

  afterAll(async () => {
    let childCleanup: PromiseSettledResult<void | undefined> | undefined
    try {
      ;[childCleanup] = await Promise.allSettled([publicProcess?.stop()])
      if (server) await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldExternalJwtPublicKey === undefined) {
        delete process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY
      } else {
        process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = oldExternalJwtPublicKey
      }
      controlConfig.internalServiceTokens['external-rest-api'] = oldInternalToken || ''
      holder.pool && (await endPoolAndWaitForClients(holder.pool))
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
    if (childCleanup?.status === 'rejected') throw childCleanup.reason
  })

  it('emits user_retired at Control API and maps it to a non-enumerating public result', async () => {
    const preview = await request(app)
      .get('/api/v1/invitations/token/r6-synthetic-retired-reset-proof')
      .expect(200)
    expect(preview.body).toMatchObject({
      id: invitationId,
      email,
      purpose: 'password_reset',
      status: 'pending',
    })

    await request(producerApp)
      .post('/api/v1/external/invitations/password-token')
      .set('authorization', `Bearer ${internalToken}`)
      .set('x-service-token', 'external-rest-api')
      .send({
        token: 'r6-synthetic-retired-reset-proof',
        email,
        invitationId,
        password: resetPassword,
      })
      .expect(401, { error: 'user_retired' })

    const response = await request(app)
      .post('/api/v1/invitations/password')
      .send({
        token: 'r6-synthetic-retired-reset-proof',
        email,
        invitationId,
        password: resetPassword,
      })
      .expect(400)

    expect(response.body).toEqual({ error: 'invalid_invitation' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/retired|r6-|example\.invalid|reset proof/i)
    expect(
      (
        await holder.pool.query('SELECT lifecycle_state, password_hash FROM users WHERE id = $1', [
          userId,
        ])
      ).rows[0]
    ).toMatchObject({ lifecycle_state: 'retired', password_hash: initialHash })
    expect(
      (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitationId]))
        .rows[0]
    ).toEqual({ status: 'pending' })
  }, 30_000)
})

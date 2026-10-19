import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { type Server } from 'node:http'
import { Pool } from 'pg'
import { config as controlConfig } from '../src/config.js'
import { initDb } from '../src/db.js'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalUsersRouter } from '../src/routes/external/users.js'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))

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
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const internalToken = 'Synthetic-R6-Credential-Route-Internal-Token'
const currentPassword = 'R6-Synthetic-Current-Password'
const competingPassword = 'R6-Synthetic-Competing-Password'
const submittedPassword = 'R6-Synthetic-Submitted-Password'

realPg('R6 credential-generation update fence (Control API + External REST, PostgreSQL)', () => {
  const database = `r6_credential_${randomBytes(6).toString('hex')}`
  const email = `r6-credential-${randomUUID()}@example.invalid`
  let admin: Pool
  let server: Server
  let publicApp: string
  let publicProcess: ExternalRestHttpProcess
  let userId: string
  let sessionToken: string
  let initialHash: string
  const oldExternalJwtPublicKey = process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY
  const oldInternalToken = controlConfig.internalServiceTokens['external-rest-api']

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: url.toString() })
    await initDb(holder.pool)
    initialHash = await bcrypt.hash(currentPassword, 12)
    const inserted = await holder.pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id, lifecycle_version',
      [email, initialHash]
    )
    userId = String(inserted.rows[0].id)
    sessionToken = (
      await import('../src/utils/auth/externalSessionAuthToken.js')
    ).signExternalSessionToken({
      userId,
      email,
      teamId: null,
      role: 'member',
      authGeneration: Number(inserted.rows[0].lifecycle_version),
    })
    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = createPublicKey(
      controlConfig.sessionJwtPrivateKey
    )
      .export({ type: 'spki', format: 'pem' })
      .toString()
    controlConfig.internalServiceTokens['external-rest-api'] = internalToken

    const producer = express()
    producer.use(express.json())
    producer.use('/api/v1', requireInternalToken, createExternalUsersRouter({} as never))
    server = producer.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Control API did not bind TCP')

    publicProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      controlApiServiceToken: internalToken,
      jwtPrivateKey: controlConfig.sessionJwtPrivateKey,
    })
    publicApp = publicProcess.baseUrl
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
      if (holder.pool) await endPoolAndWaitForClients(holder.pool)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
    if (childCleanup?.status === 'rejected') throw childCleanup.reason
  })

  it('returns 409 without overwriting the concurrent credential and preserves public guidance', async () => {
    let compareEntered!: () => void
    let releaseCompare!: () => void
    const compareIsPaused = new Promise<void>(resolve => {
      compareEntered = resolve
    })
    const continueCompare = new Promise<void>(resolve => {
      releaseCompare = resolve
    })
    const realCompare = bcrypt.compare.bind(bcrypt)
    let paused = false
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (candidate, encoded) => {
      const matches = await realCompare(candidate, encoded)
      if (!paused) {
        paused = true
        compareEntered()
        await continueCompare
      }
      return matches
    })

    const change = request(publicApp)
      .put('/api/v1/me/password')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ currentPassword, newPassword: submittedPassword })
      .then(response => response)
    try {
      const firstOutcome = await Promise.race([
        compareIsPaused.then(() => ({ kind: 'compare' as const })),
        change.then(response => ({ kind: 'response' as const, response })),
      ])
      if (firstOutcome.kind === 'response') {
        throw new Error(
          `public password route returned ${firstOutcome.response.status} before bcrypt compare`
        )
      }
      const newerHash = await bcrypt.hash(competingPassword, 12)
      await holder.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        userId,
        newerHash,
      ])
      releaseCompare()

      const response = await change
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        error: 'Your password changed during this request. Sign in again with your new password.',
      })
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toMatch(/credential_changed|password_hash|r6-/i)
      const stored = (
        await holder.pool.query(
          'SELECT password_hash, password_auth_generation FROM users WHERE id = $1',
          [userId]
        )
      ).rows[0]
      expect(Number(stored.password_auth_generation)).toBeGreaterThan(1)
      expect(await bcrypt.compare(competingPassword, stored.password_hash)).toBe(true)
      expect(await bcrypt.compare(submittedPassword, stored.password_hash)).toBe(false)
    } finally {
      releaseCompare()
      vi.restoreAllMocks()
    }
  }, 30_000)
})

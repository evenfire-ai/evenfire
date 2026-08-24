import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import type { AuthClaims } from '../src/profileTypes.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { exchangeLegacyExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { validateLegacyUserSession } from '../src/services/auth/userSessionService.js'
import { verifyUserPassword } from '../src/services/directory/login.js'
import {
  setInvitationPasswordForUser,
  updateUserPassword,
} from '../src/services/directory/membership.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

const producerDatabase = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const pool = {
    query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
  }
  const withTransaction = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = await producerDatabase.pool!.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client as unknown as DbClient)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  return { ...actual, pool, withTransaction }
})

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(value => {
    resolve = value
  })
  return { promise, resolve }
}

describeRealPostgres('legacy replacement exchange serialization on real PostgreSQL', () => {
  const database = `control_api_legacy_exchange_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const policy = {
    policyVersion: '1',
    policyRevision: 'legacy-exchange-race',
    acceptV1: true,
    issueV1: true,
    acceptV2: false,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
  } as EffectiveUserAccessPolicy
  let adminPool: Pool
  let databasePool: Pool
  const currentPassword = 'Legacy-Password-1!'

  async function backendPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return result.rows[0]!.pid
  }

  async function waitForBlock(blockedPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await databasePool.query<{ blocked: boolean }>(
        `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
        [blockedPid, blockerPid]
      )
      if (result.rows[0]?.blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('expected legacy exchange to block on the user security boundary')
  }

  async function waitForBlockedBy(blockerPid: number): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await databasePool.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_stat_activity activity
          WHERE activity.datname = current_database()
            AND $1::int = ANY(pg_blocking_pids(activity.pid))
          ORDER BY activity.pid
          LIMIT 1`,
        [blockerPid]
      )
      if (result.rows[0]?.pid) return result.rows[0].pid
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('expected real password producer to block on the user security boundary')
  }

  async function principal(label: string): Promise<{
    userId: string
    teamId: string
    email: string
    token: string
    claims: AuthClaims
  }> {
    const userId = randomUUID()
    const teamId = randomUUID()
    const email = `${label}-${userId}@example.test`
    const passwordHash = await bcrypt.hash(currentPassword, 12)
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, email, label, passwordHash]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    const token = signExternalSessionToken({
      userId,
      email,
      teamId,
      role: 'admin',
      authGeneration: 1,
    })
    const claims = verifyExternalSessionToken(token)
    if (!claims) throw new Error('test producer failed to verify its V1 token')
    return { userId, teamId, email, token, claims }
  }

  async function passwordProducer(
    label: 'normal password change' | 'password reset',
    source: Awaited<ReturnType<typeof principal>>
  ): Promise<{
    newPassword: string
    run: () => Promise<unknown>
    assertSuccess: (result: unknown) => void
  }> {
    const newPassword = `Changed-${randomBytes(8).toString('hex')}!`
    if (label === 'normal password change') {
      return {
        newPassword,
        run: () => updateUserPassword(source.userId, source.email, currentPassword, newPassword),
        assertSuccess: result => expect(result).toEqual({ updated: true }),
      }
    }
    const invitation = await databasePool.query<{ id: string }>(
      `INSERT INTO invitations(
         email, role, status, purpose, accepted_user_id, invitee_name, expires_at
       ) VALUES ($1, 'member', 'pending', 'password_reset', $2, 'Reset User', NOW() + INTERVAL '1 hour')
       RETURNING id::text`,
      [source.email, source.userId]
    )
    return {
      newPassword,
      run: () =>
        setInvitationPasswordForUser(
          source.userId,
          source.email,
          invitation.rows[0]!.id,
          newPassword
        ),
      assertSuccess: result => expect(result).toMatchObject({ data: { passwordUpdated: true } }),
    }
  }

  async function holdSecurityEpoch(userId: string): Promise<PoolClient> {
    await databasePool.query(
      `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason)
       VALUES ($1, to_timestamp(0), 'test-baseline')
       ON CONFLICT (user_id) DO UPDATE
         SET valid_after = EXCLUDED.valid_after, reason = EXCLUDED.reason`,
      [userId]
    )
    const gate = await databasePool.connect()
    await gate.query('BEGIN')
    await gate.query(
      `SELECT user_id
         FROM external_user_session_security_epochs
        WHERE user_id = $1
        FOR UPDATE`,
      [userId]
    )
    return gate
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it.each(['normal password change', 'password reset'] as const)(
    'fails %s exchange when invalidation wins the lock order',
    async label => {
      const source = await principal(`invalidation-first-${label.replaceAll(' ', '-')}`)
      const producer = await passwordProducer(label, source)
      const epochGate = await holdSecurityEpoch(source.userId)
      const exchangeStarted = deferred<number>()
      try {
        const epochGatePid = await backendPid(epochGate)
        const producerWork = producer.run()
        const producerPid = await waitForBlockedBy(epochGatePid)

        const exchange = exchangeLegacyExternalUserSession(
          {
            token: source.token,
            claims: source.claims,
            userId: source.userId,
            email: source.email,
            teamId: source.teamId,
          },
          {
            policy,
            transaction: async work => {
              const client = await databasePool.connect()
              try {
                await client.query('BEGIN')
                exchangeStarted.resolve(await backendPid(client))
                const result = await work(client as unknown as DbClient)
                await client.query('COMMIT')
                return result
              } catch (error) {
                await client.query('ROLLBACK')
                throw error
              } finally {
                client.release()
              }
            },
          }
        )
        const exchangePid = await exchangeStarted.promise
        await waitForBlock(exchangePid, producerPid)
        await epochGate.query('COMMIT')

        producer.assertSuccess(await producerWork)
        await expect(exchange).resolves.toEqual({ status: 'invalid_session' })
        await expect(
          validateLegacyUserSession(source.token, source.claims, { db: databasePool })
        ).resolves.toMatchObject({ status: 'revoked' })
        await expect(
          exchangeLegacyExternalUserSession(
            {
              token: source.token,
              claims: source.claims,
              userId: source.userId,
              email: source.email,
              teamId: source.teamId,
            },
            { policy }
          )
        ).resolves.toEqual({ status: 'invalid_session' })
        await expect(
          verifyUserPassword({
            userId: source.userId,
            email: source.email,
            password: producer.newPassword,
          })
        ).resolves.toBe(true)
      } finally {
        await epochGate.query('ROLLBACK').catch(() => undefined)
        epochGate.release()
      }
    }
  )

  it.each(['normal password change', 'password reset'] as const)(
    'invalidates the replacement from %s when exchange wins the lock order',
    async label => {
      const source = await principal(`exchange-first-${label.replaceAll(' ', '-')}`)
      const producer = await passwordProducer(label, source)
      const exchangeReady = deferred<{ result: { status: string; token?: string }; pid: number }>()
      const releaseExchange = deferred()
      const exchange = exchangeLegacyExternalUserSession(
        {
          token: source.token,
          claims: source.claims,
          userId: source.userId,
          email: source.email,
          teamId: source.teamId,
        },
        {
          policy,
          transaction: async work => {
            const client = await databasePool.connect()
            try {
              await client.query('BEGIN')
              const result = await work(client as unknown as DbClient)
              exchangeReady.resolve({ result, pid: await backendPid(client) })
              await releaseExchange.promise
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            } finally {
              client.release()
            }
          },
        }
      )
      const lockedExchange = await exchangeReady.promise
      expect(lockedExchange.result.status).toBe('issued')

      try {
        const producerWork = producer.run()
        await waitForBlockedBy(lockedExchange.pid)
        releaseExchange.resolve()
        const issued = await exchange
        producer.assertSuccess(await producerWork)
        expect(issued.status).toBe('issued')
        if (issued.status !== 'issued') throw new Error('exchange did not issue a token')
        const replacementClaims = verifyExternalSessionToken(issued.token)
        if (!replacementClaims) throw new Error('replacement token was not producer-shaped')
        await expect(
          validateLegacyUserSession(issued.token, replacementClaims, { db: databasePool })
        ).resolves.toMatchObject({ status: 'revoked' })
        await expect(
          validateLegacyUserSession(source.token, source.claims, { db: databasePool })
        ).resolves.toMatchObject({ status: 'revoked' })
        await expect(
          exchangeLegacyExternalUserSession(
            {
              token: source.token,
              claims: source.claims,
              userId: source.userId,
              email: source.email,
              teamId: source.teamId,
            },
            { policy }
          )
        ).resolves.toEqual({ status: 'invalid_session' })
        await expect(
          verifyUserPassword({
            userId: source.userId,
            email: source.email,
            password: producer.newPassword,
          })
        ).resolves.toBe(true)
      } finally {
        releaseExchange.resolve()
      }
    }
  )
})

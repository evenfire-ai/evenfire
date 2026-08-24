import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import type { AuthClaims } from '../src/profileTypes.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { exchangeLegacyExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  revokeAllUserSessions,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
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
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_hash) VALUES ($1, $2, $3, 'old-hash')`,
      [userId, email, label]
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

  async function beginSecurityMutation(
    client: PoolClient,
    userId: string,
    label: string,
    validAfter: Date
  ): Promise<void> {
    await client.query('BEGIN')
    await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
      userId,
      `${label}-new-hash`,
    ])
    await revokeAllUserSessions(userId, 'password_changed', client, validAfter)
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
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

  it.each(['normal password change', 'password reset'])(
    'fails %s exchange when invalidation wins the lock order',
    async label => {
      const source = await principal(`invalidation-first-${label.replaceAll(' ', '-')}`)
      const invalidation = await databasePool.connect()
      const exchangeStarted = deferred<number>()
      try {
        const validAfter = new Date((source.claims.iat! + 60) * 1000)
        await beginSecurityMutation(invalidation, source.userId, label, validAfter)
        const invalidationPid = await backendPid(invalidation)

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
        await waitForBlock(exchangePid, invalidationPid)
        await invalidation.query('COMMIT')

        await expect(exchange).resolves.toEqual({ status: 'invalid_session' })
      } finally {
        await invalidation.query('ROLLBACK').catch(() => undefined)
        invalidation.release()
      }
    }
  )

  it.each(['normal password change', 'password reset'])(
    'invalidates the replacement from %s when exchange wins the lock order',
    async label => {
      const source = await principal(`exchange-first-${label.replaceAll(' ', '-')}`)
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

      const invalidation = await databasePool.connect()
      try {
        const invalidationStarted = deferred<number>()
        const invalidationWork = (async () => {
          invalidationStarted.resolve(await backendPid(invalidation))
          await beginSecurityMutation(
            invalidation,
            source.userId,
            label,
            new Date((source.claims.iat! + 60) * 1000)
          )
          await invalidation.query('COMMIT')
        })()
        const invalidationPid = await invalidationStarted.promise
        await waitForBlock(invalidationPid, lockedExchange.pid)
        releaseExchange.resolve()
        const issued = await exchange
        await invalidationWork
        expect(issued.status).toBe('issued')
        if (issued.status !== 'issued') throw new Error('exchange did not issue a token')
        const replacementClaims = verifyExternalSessionToken(issued.token)
        if (!replacementClaims) throw new Error('replacement token was not producer-shaped')
        await expect(
          validateLegacyUserSession(issued.token, replacementClaims, { db: databasePool })
        ).resolves.toMatchObject({ status: 'revoked' })
      } finally {
        releaseExchange.resolve()
        await invalidation.query('ROLLBACK').catch(() => undefined)
        invalidation.release()
      }
    }
  )
})

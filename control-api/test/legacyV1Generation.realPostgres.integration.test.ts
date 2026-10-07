import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { isCurrentExternalSession as isCurrentBaseExternalSession } from '../../../base/control-api/src/middleware/externalSessionAuth.js'
import {
  signExternalSessionToken as signBaseExternalSessionToken,
  verifyExternalSessionToken as verifyBaseExternalSessionToken,
} from '../../../base/control-api/src/utils/auth/externalSessionAuthToken.js'
import { initDb } from '../src/db.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  revokeAllUserSessions,
  revokeLegacyUserSession,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const baseDatabase = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../../../base/control-api/src/db.js', () => ({
  pool: { query: baseDatabase.query },
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const legacyPolicy = { issueV1: true, acceptV1: true } as EffectiveUserAccessPolicy

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function alignToFreshDatabaseSecond(pool: Pool): Promise<void> {
  await pool.query(`SELECT pg_sleep(
    EXTRACT(EPOCH FROM date_trunc('second', clock_timestamp()) + interval '1 second' - clock_timestamp())
    + 0.05
  )`)
}

describeRealPostgres('legacy V1 generation ordering on real PostgreSQL', () => {
  const database = `control_api_legacy_v1_generation_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  async function principal(label: string): Promise<{
    userId: string
    email: string
    teamId: string
  }> {
    const userId = randomUUID()
    const teamId = randomUUID()
    const email = `${label}-${userId}@example.test`
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      email,
      label,
    ])
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    return { userId, email, teamId }
  }

  async function issueLegacy(source: Awaited<ReturnType<typeof principal>>): Promise<string> {
    return (
      await issueExternalUserSession(
        {
          contract: 'v1',
          userId: source.userId,
          email: source.email,
          teamId: source.teamId,
          role: 'member',
          authenticationMethods: ['password'],
        },
        { db: databasePool, policy: legacyPolicy }
      )
    ).token
  }

  function verified(token: string) {
    const claims = verifyExternalSessionToken(token)
    if (!claims) throw new Error('real V1 issuer did not create a verifiable representation')
    return claims
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    baseDatabase.query.mockImplementation((text: string, values?: unknown[]) =>
      databasePool.query(text, values)
    )
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('orders same-second revoke-all and replacement issuance by lifecycle generation', async () => {
    const source = await principal('same-second-security-event')
    await alignToFreshDatabaseSecond(databasePool)
    const predecessor = await issueLegacy(source)
    const predecessorClaims = verified(predecessor)

    await revokeAllUserSessions(source.userId, 'password_changed', databasePool)
    const successor = await issueLegacy(source)
    const successorClaims = verified(successor)
    const authority = await databasePool.query<{
      lifecycle_version: number
      valid_after: Date
    }>(
      `SELECT u.lifecycle_version, epoch.valid_after
         FROM users u
         JOIN external_user_session_security_epochs epoch ON epoch.user_id = u.id
        WHERE u.id = $1`,
      [source.userId]
    )

    expect(predecessorClaims.iat).toBe(successorClaims.iat)
    expect(successorClaims.authGeneration).toBe(Number(authority.rows[0]?.lifecycle_version))
    expect(successorClaims.authGeneration).toBe(predecessorClaims.authGeneration! + 1)
    expect(successorClaims.iat).toBeGreaterThan(
      Math.floor(authority.rows[0]!.valid_after.getTime() / 1000)
    )
    expect(successorClaims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    await expect(
      validateLegacyUserSession(predecessor, predecessorClaims, { db: databasePool })
    ).resolves.toEqual({ status: 'revoked', reason: 'security_event' })
    await expect(
      validateLegacyUserSession(successor, successorClaims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })
    const baseClaims = verifyBaseExternalSessionToken(successor)
    expect(baseClaims).toMatchObject({
      userId: source.userId,
      authGeneration: successorClaims.authGeneration,
    })
    await expect(isCurrentBaseExternalSession(baseClaims!)).resolves.toBe(true)
  })

  it('keeps fingerprint logout scoped to one same-second V1 representation', async () => {
    const source = await principal('same-second-fingerprint')
    await alignToFreshDatabaseSecond(databasePool)
    const first = await issueLegacy(source)
    const firstClaims = verified(first)
    await expect(revokeLegacyUserSession(first, firstClaims, 'logout', databasePool)).resolves.toBe(
      true
    )
    const successor = await issueLegacy(source)
    const successorClaims = verified(successor)
    const lifecycle = await databasePool.query<{ lifecycle_version: number }>(
      `SELECT lifecycle_version FROM users WHERE id = $1`,
      [source.userId]
    )

    expect(successor).not.toBe(first)
    expect(successorClaims.jti).toEqual(expect.any(String))
    expect(Number(lifecycle.rows[0]?.lifecycle_version)).toBe(1)
    await expect(
      validateLegacyUserSession(first, firstClaims, { db: databasePool })
    ).resolves.toEqual({ status: 'revoked', reason: 'logout' })
    await expect(
      validateLegacyUserSession(successor, successorClaims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })
  })

  it('keeps the deployed base writer compatible with the candidate reader', async () => {
    const source = await principal('base-writer-compatibility')
    const baseToken = signBaseExternalSessionToken({
      userId: source.userId,
      email: source.email,
      teamId: source.teamId,
      role: 'member',
      authGeneration: 1,
    })
    const baseClaims = verifyBaseExternalSessionToken(baseToken)
    const candidateClaims = verifyExternalSessionToken(baseToken)
    expect(baseClaims).not.toBeNull()
    expect(candidateClaims).not.toBeNull()
    await expect(isCurrentBaseExternalSession(baseClaims!)).resolves.toBe(true)
    await expect(
      validateLegacyUserSession(baseToken, candidateClaims!, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })
  })
})

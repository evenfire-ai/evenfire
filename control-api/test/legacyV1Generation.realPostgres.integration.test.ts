import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { initDb, withTransaction } from '../src/db.js'
import type { DbClient } from '../src/db.js'
import { backfillLegacyPasswordSecurityEpochs } from '../src/services/access/userAccessFoundationSchema.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  revokeAllUserSessions,
  revokeLegacyUserSession,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { isCurrentExternalSession as isCurrentBaseExternalSession } from './fixtures/legacyV1Base/src/middleware/externalSessionAuth.js'
import {
  signExternalSessionToken as signBaseExternalSessionToken,
  verifyExternalSessionToken as verifyBaseExternalSessionToken,
} from './fixtures/legacyV1Base/src/utils/auth/externalSessionAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const baseDatabase = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('./fixtures/legacyV1Base/src/db.js', () => ({
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

// These full source snapshots are verbatim from the deployed reader/writer base
// at 74e0d81d9b70bbc0e123ed2bad89f08d3e13e99e; the hashes prevent drift.
describe('pinned deployed-base V1 source snapshot at 74e0d81d9b70bbc0e123ed2bad89f08d3e13e99e', () => {
  it('matches the exact synchronized-dev reader and signer sources', () => {
    const snapshots = [
      [
        './fixtures/legacyV1Base/src/middleware/externalSessionAuth.ts',
        '4b7e1368f6a9cf3c71d3c1c0bca409a8c458e51f8ccd3f6a07e01173873d87ab',
      ],
      [
        './fixtures/legacyV1Base/src/utils/auth/externalSessionAuthToken.ts',
        '57663b8d7538a30c2dbf3235bc3faf45faeefcdfd73f2328ae8ff1ec8e2b9494',
      ],
      [
        './fixtures/legacyV1Base/src/profileTypes.ts',
        '85703bd09e4c584a55c4a0bd8c797ba7f62653f49df197f40068a0706a8bcd2e',
      ],
    ] as const

    for (const [path, expectedSha256] of snapshots) {
      const source = readFileSync(new URL(path, import.meta.url))
      expect(createHash('sha256').update(source).digest('hex')).toBe(expectedSha256)
    }
  })
})

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

async function alignToDatabaseSecondFraction(pool: Pool, fractionSeconds: number): Promise<void> {
  await pool.query(
    `SELECT pg_sleep(
       GREATEST(
         0,
         EXTRACT(EPOCH FROM date_trunc('second', clock_timestamp())
           + interval '1 second' - clock_timestamp()) + $1::double precision
       )
     )`,
    [fractionSeconds]
  )
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
      lifecycle_version: number | string
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
    expect(successorClaims.exp - successorClaims.iat).toBeGreaterThan(0)
    expect(successorClaims.exp - successorClaims.iat).toBeLessThanOrEqual(60 * 60 * 12)
    const basePredecessorClaims = verifyBaseExternalSessionToken(predecessor)
    expect(basePredecessorClaims).not.toBeNull()
    await expect(
      validateLegacyUserSession(predecessor, predecessorClaims, { db: databasePool })
    ).resolves.toEqual({ status: 'revoked', reason: 'security_event' })
    await expect(isCurrentBaseExternalSession(basePredecessorClaims!)).resolves.toBe(false)
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
    expect(createHash('sha256').update(successor).digest('hex')).not.toBe(
      createHash('sha256').update(first).digest('hex')
    )
    expect(successorClaims.jti).toEqual(expect.any(String))
    expect(Number(lifecycle.rows[0]?.lifecycle_version)).toBe(1)
    await expect(
      validateLegacyUserSession(first, firstClaims, { db: databasePool })
    ).resolves.toEqual({ status: 'revoked', reason: 'logout' })
    await expect(
      validateLegacyUserSession(successor, successorClaims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })
  })

  it('does not publish V1 issuance behind a retained historical password cutoff', async () => {
    const source = await principal('historical-cutoff-issuance')
    await alignToDatabaseSecondFraction(databasePool, 0.65)

    const predecessor = await withTransaction(async db => {
      const issued = await issueExternalUserSession(
        {
          contract: 'v1',
          userId: source.userId,
          email: source.email,
          teamId: source.teamId,
          role: 'member',
          authenticationMethods: ['password'],
        },
        { db, policy: legacyPolicy }
      )
      return issued.token
    }, databasePool)
    const predecessorClaims = verified(predecessor)
    const historical = await databasePool.query<{ password_set_at: Date }>(
      `UPDATE users
          SET password_set_at = date_trunc('second', clock_timestamp()) + interval '200 milliseconds'
        WHERE id = $1
      RETURNING password_set_at`,
      [source.userId]
    )
    const cutoff = historical.rows[0]?.password_set_at
    expect(cutoff).toBeInstanceOf(Date)
    expect(predecessorClaims.iat! * 1000).toBeLessThan(cutoff!.getTime())

    // Use the production historical backfill writer, then the canonical
    // security-event writer and the same transactional V1 issuer.
    await backfillLegacyPasswordSecurityEpochs(databasePool as unknown as DbClient)
    await withTransaction(
      db => revokeAllUserSessions(source.userId, 'password_changed', db),
      databasePool
    )
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
    expect(authority.rows[0]?.valid_after).toEqual(cutoff)
    expect(Number(authority.rows[0]?.lifecycle_version)).toBe(predecessorClaims.authGeneration! + 1)
    expect(Math.floor(authority.rows[0]!.valid_after.getTime() / 1000)).toBe(predecessorClaims.iat)
    await expect(
      validateLegacyUserSession(predecessor, predecessorClaims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'revoked' })
    await expect(
      isCurrentBaseExternalSession(verifyBaseExternalSessionToken(predecessor)!)
    ).resolves.toBe(false)

    let issuedToken: string | null = null
    let issuanceError: unknown
    try {
      issuedToken = await withTransaction(async db => {
        const issued = await issueExternalUserSession(
          {
            contract: 'v1',
            userId: source.userId,
            email: source.email,
            teamId: source.teamId,
            role: 'member',
            authenticationMethods: ['password'],
          },
          { db, policy: legacyPolicy }
        )
        return issued.token
      }, databasePool)
    } catch (error) {
      issuanceError = error
    }

    if (issuedToken) {
      const claims = verified(issuedToken)
      const validation = await validateLegacyUserSession(issuedToken, claims, {
        db: databasePool,
      })
      expect(
        validation,
        'successful issuance must be accepted by the canonical validator'
      ).toMatchObject({ status: 'valid' })
    } else {
      expect(issuanceError).toMatchObject({
        name: 'ExternalSessionIssuanceUnavailableError',
        code: 'session_issuance_temporarily_unavailable',
        status: 503,
      })
    }

    await databasePool.query(`SELECT pg_sleep(
      GREATEST(
        0,
        EXTRACT(EPOCH FROM date_trunc('second', clock_timestamp())
          + interval '1 second' - clock_timestamp()) + 0.2
      )
    )`)
    const nextSecond = await withTransaction(async db => {
      const issued = await issueExternalUserSession(
        {
          contract: 'v1',
          userId: source.userId,
          email: source.email,
          teamId: source.teamId,
          role: 'member',
          authenticationMethods: ['password'],
        },
        { db, policy: legacyPolicy }
      )
      return issued.token
    }, databasePool)
    const nextClaims = verified(nextSecond)
    expect(nextClaims.iat! * 1000).toBeGreaterThan(cutoff!.getTime())
    expect(nextClaims.iat! * 1000).toBeLessThanOrEqual(Date.now())
    expect(Number(nextClaims.authGeneration)).toBe(Number(authority.rows[0]?.lifecycle_version))
    await expect(
      validateLegacyUserSession(nextSecond, nextClaims, { db: databasePool })
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

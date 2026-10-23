import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import type { AuthClaims } from '../src/profileTypes.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import type { ExternalSessionAuthentication } from '../src/services/auth/externalSessionAuthentication.js'
import { observeExternalSessionCurrentness } from '../src/services/auth/externalSessionCurrentnessObserver.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  legacySecurityCutoffRejects,
  legacySecurityCutoffRejectsSql,
} from '../src/services/auth/legacySecurityCutoff.js'
import {
  validateExternalSessionAuthorityContext,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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

// A fixed whole second, 2030-03-17T17:46:40Z.
const S = 1_900_000_000

function at(second: number, fraction: string): string {
  return `${new Date(second * 1000).toISOString().slice(0, 19)}.${fraction}Z`
}

// Cutoffs on and around a second boundary, with microsecond fractions that the
// pg parser truncates to milliseconds before the TypeScript comparators see them.
const PARITY_CASES = [
  { cutoff: at(S, '000000'), iat: S - 1, rejected: true },
  { cutoff: at(S, '000000'), iat: S, rejected: true },
  { cutoff: at(S, '000000'), iat: S + 1, rejected: false },
  { cutoff: at(S, '000001'), iat: S, rejected: true },
  { cutoff: at(S, '000001'), iat: S + 1, rejected: false },
  { cutoff: at(S, '500000'), iat: S, rejected: true },
  { cutoff: at(S, '999999'), iat: S, rejected: true },
  { cutoff: at(S, '999999'), iat: S + 1, rejected: false },
  { cutoff: at(S - 1, '999999'), iat: S - 1, rejected: true },
  { cutoff: at(S - 1, '999999'), iat: S, rejected: false },
] as const

// Every comparator case keeps the token's lifecycle generation current and the token
// unrevoked, so the security cutoff is the only reason any site can reject it.
describeRealPostgres('V1 security cutoff at every comparator on real PostgreSQL', () => {
  const database = `control_api_v1_cutoff_sites_${randomBytes(6).toString('hex')}`
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
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, $3, 'active', 1)`,
      [userId, email, label]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    return { userId, email, teamId }
  }

  async function databaseSecond(offsetSeconds: number): Promise<number> {
    const result = await databasePool.query(
      `SELECT EXTRACT(EPOCH FROM date_trunc('second', clock_timestamp()))::bigint + $1::bigint
                AS second`,
      [offsetSeconds]
    )
    return Number((result.rows[0] as { second: string }).second)
  }

  async function setCutoff(userId: string, second: number): Promise<void> {
    await databasePool.query(
      `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason, updated_at)
       VALUES ($1, to_timestamp($2), 'cutoff_site_test', to_timestamp($2))
       ON CONFLICT (user_id) DO UPDATE SET valid_after = EXCLUDED.valid_after`,
      [userId, second]
    )
  }

  function legacyToken(source: { userId: string; email: string }, iat: number) {
    const token = signExternalSessionToken({
      userId: source.userId,
      email: source.email,
      teamId: null,
      role: 'member',
      authGeneration: 1,
      iat,
    })
    const claims = verifyExternalSessionToken(token)
    if (!claims || claims.iat !== iat) throw new Error('test token does not carry the chosen iat')
    return { token, claims }
  }

  function v1Context(token: string, claims: AuthClaims) {
    return {
      contract: 'v1' as const,
      userId: claims.userId,
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      issuedAt: claims.iat!,
      authGeneration: 1,
    }
  }

  function authenticated(
    token: string,
    claims: AuthClaims
  ): Extract<ExternalSessionAuthentication, { status: 'authenticated' }> {
    return {
      status: 'authenticated',
      contract: 'v1',
      claims,
      tokenClaims: claims,
      authorityContext: v1Context(token, claims),
      policy: legacyPolicy,
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
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

  it('gives the same decision in TypeScript and SQL for every boundary case', async () => {
    const result = await databasePool.query(
      `SELECT c.ord,
              c.cutoff::timestamptz AS valid_after,
              (${legacySecurityCutoffRejectsSql('c.iat', 'c.cutoff::timestamptz')}) AS sql_rejects
         FROM unnest($1::int[], $2::text[], $3::bigint[]) AS c(ord, cutoff, iat)
        ORDER BY c.ord`,
      [
        PARITY_CASES.map((_, index) => index),
        PARITY_CASES.map(c => c.cutoff),
        PARITY_CASES.map(c => c.iat),
      ]
    )
    const rows = result.rows as { ord: number; valid_after: Date; sql_rejects: boolean }[]

    expect(rows).toHaveLength(PARITY_CASES.length)
    expect(PARITY_CASES.some(c => c.rejected)).toBe(true)
    expect(PARITY_CASES.some(c => !c.rejected)).toBe(true)
    const decisions = rows.map(row => {
      const testCase = PARITY_CASES[row.ord]!
      return {
        cutoff: testCase.cutoff,
        iat: testCase.iat,
        expected: testCase.rejected,
        sql: row.sql_rejects,
        ts: legacySecurityCutoffRejects(testCase.iat, row.valid_after),
      }
    })
    expect(decisions).toEqual(
      PARITY_CASES.map(c => ({
        cutoff: c.cutoff,
        iat: c.iat,
        expected: c.rejected,
        sql: c.rejected,
        ts: c.rejected,
      }))
    )
  })

  it('rejects the cutoff second and accepts the next one in request validation and authority', async () => {
    const user = await principal('cutoff-validators')
    const cutoff = await databaseSecond(-60)
    await setCutoff(user.userId, cutoff)
    const atCutoff = legacyToken(user, cutoff)
    const afterCutoff = legacyToken(user, cutoff + 1)

    await expect(
      validateLegacyUserSession(atCutoff.token, atCutoff.claims, { db: databasePool })
    ).resolves.toEqual({ status: 'revoked', reason: 'security_event' })
    await expect(
      validateLegacyUserSession(afterCutoff.token, afterCutoff.claims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })

    await expect(
      validateExternalSessionAuthorityContext(v1Context(atCutoff.token, atCutoff.claims), {
        db: databasePool,
      })
    ).resolves.toEqual({ status: 'revoked', reason: 'security_event' })
    await expect(
      validateExternalSessionAuthorityContext(v1Context(afterCutoff.token, afterCutoff.claims), {
        db: databasePool,
      })
    ).resolves.toMatchObject({ status: 'valid' })
  })

  it('denies currentness for the cutoff second and keeps the next one current', async () => {
    const user = await principal('cutoff-currentness')
    const cutoff = await databaseSecond(-60)
    await setCutoff(user.userId, cutoff)
    const atCutoff = legacyToken(user, cutoff)
    const afterCutoff = legacyToken(user, cutoff + 1)

    await expect(
      observeExternalSessionCurrentness(authenticated(atCutoff.token, atCutoff.claims), {
        db: databasePool,
      })
    ).resolves.toEqual({ status: 'denied', reason: 'legacy_security_cutoff' })
    await expect(
      observeExternalSessionCurrentness(authenticated(afterCutoff.token, afterCutoff.claims), {
        db: databasePool,
      })
    ).resolves.toEqual({ status: 'current' })
  })

  it('refuses issuance while the database second is at or before the cutoff', async () => {
    const user = await principal('cutoff-issuance')
    const issue = () =>
      issueExternalUserSession(
        {
          contract: 'v1',
          userId: user.userId,
          email: user.email,
          teamId: user.teamId,
          role: 'member',
          authenticationMethods: ['password'],
        },
        { db: databasePool, policy: legacyPolicy }
      )

    // An hour ahead, so the cutoff cannot pass before issuance reads the clock.
    await setCutoff(user.userId, await databaseSecond(3_600))
    await expect(issue()).rejects.toMatchObject({
      name: 'ExternalSessionIssuanceUnavailableError',
      code: 'session_issuance_temporarily_unavailable',
      status: 503,
    })

    const pastCutoff = await databaseSecond(-1)
    await setCutoff(user.userId, pastCutoff)
    const issued = await issue()
    const claims = verifyExternalSessionToken(issued.token)
    expect(claims?.userId).toBe(user.userId)
    expect(claims!.iat!).toBeGreaterThan(pastCutoff)
  })

  // PostgreSQL stores timestamps that a JavaScript Date cannot hold. No writer
  // produces them; the TypeScript comparators must still refuse rather than
  // compare against NaN and accept.
  it('fails closed on a stored cutoff outside the JavaScript Date range', async () => {
    const user = await principal('cutoff-out-of-range')
    const token = legacyToken(user, await databaseSecond(-60))
    const issue = () =>
      issueExternalUserSession(
        {
          contract: 'v1',
          userId: user.userId,
          email: user.email,
          teamId: user.teamId,
          role: 'member',
          authenticationMethods: ['password'],
        },
        { db: databasePool, policy: legacyPolicy }
      )

    for (const stored of ['infinity', '-infinity', '294000-01-01 00:00:00+00']) {
      await databasePool.query(
        `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason, updated_at)
         VALUES ($1, $2::timestamptz, 'cutoff_site_test', now())
         ON CONFLICT (user_id) DO UPDATE SET valid_after = EXCLUDED.valid_after`,
        [user.userId, stored]
      )
      await expect(
        validateLegacyUserSession(token.token, token.claims, { db: databasePool }),
        stored
      ).rejects.toThrow('invalid V1 security cutoff')
      await expect(
        validateExternalSessionAuthorityContext(v1Context(token.token, token.claims), {
          db: databasePool,
        }),
        stored
      ).rejects.toThrow('invalid V1 security cutoff')
      await expect(
        observeExternalSessionCurrentness(authenticated(token.token, token.claims), {
          db: databasePool,
        }),
        stored
      ).resolves.toMatchObject({ status: 'unavailable' })
      await expect(issue(), stored).rejects.toThrow('invalid V1 security cutoff')
    }

    // Liveness witness: with a finite past cutoff the same token and user pass
    // every comparator above.
    await setCutoff(user.userId, await databaseSecond(-120))
    await expect(
      validateLegacyUserSession(token.token, token.claims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })
    await expect(
      validateExternalSessionAuthorityContext(v1Context(token.token, token.claims), {
        db: databasePool,
      })
    ).resolves.toMatchObject({ status: 'valid' })
    await expect(
      observeExternalSessionCurrentness(authenticated(token.token, token.claims), {
        db: databasePool,
      })
    ).resolves.toEqual({ status: 'current' })
    await expect(issue()).resolves.toMatchObject({ token: expect.any(String) })
  })
})

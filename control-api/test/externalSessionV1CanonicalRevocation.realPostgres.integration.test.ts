import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import { revokeLegacyUserSession } from '../src/services/auth/userSessionService.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'
import { jwsAliasVariants } from './helpers/jwsBase64UrlAliases.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const producerDatabase = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  transaction: undefined as (<T>(work: (db: DbClient) => Promise<T>) => Promise<T>) | undefined,
}))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
    },
    withTransaction: <T>(work: (db: DbClient) => Promise<T>) => producerDatabase.transaction!(work),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const policy = {
  policyVersion: '1',
  policyRevision: 'canonical-v1-token-test',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: true,
  computeCatalogShadow: false,
  serveCatalog: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
  advertisedCatalogFamilies: [],
} as EffectiveUserAccessPolicy

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

describeRealPostgres('V1 canonical external session token on real PostgreSQL', () => {
  const database = `control_api_v1_canonical_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  async function createPrincipal(label: string): Promise<{ userId: string; email: string }> {
    const userId = randomUUID()
    const email = `${label}-${userId}@example.test`
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, $3, 'active', 1)`,
      [userId, email, label]
    )
    return { userId, email }
  }

  function signFor(principal: { userId: string; email: string }): string {
    return signExternalSessionToken({
      userId: principal.userId,
      email: principal.email,
      teamId: null,
      role: 'member',
      authGeneration: 1,
    })
  }

  async function authenticate(token: string) {
    return authenticateExternalUserSession(token, { purpose: 'protected', policy })
  }

  async function transaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
    const client = await databasePool.connect()
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

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    producerDatabase.transaction = transaction
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

  it('denies every base64url alias of a revoked token and keeps an unrevoked token valid', async () => {
    const principal = await createPrincipal('v1-canonical')
    const token = signFor(principal)
    const claims = verifyExternalSessionToken(token)
    if (!claims) throw new Error('the canonical token did not verify')

    const variants = jwsAliasVariants(token)
    expect(variants.length).toBeGreaterThan(0)
    const canonicalHash = tokenHash(token)
    for (const variant of variants) {
      expect(variant.token).not.toBe(token)
      // Revocation is keyed by the exact string hash, which is why each alias
      // could escape the record before canonical verification.
      expect(tokenHash(variant.token)).not.toBe(canonicalHash)
    }

    // Liveness witness: canonical authentication reaches the database.
    await expect(authenticate(token)).resolves.toMatchObject({
      status: 'authenticated',
      contract: 'v1',
    })

    for (const variant of variants) {
      await expect(
        authenticate(variant.token),
        `${variant.segment}/${variant.kind} alias`
      ).resolves.toEqual({
        status: 'invalid',
        reason: 'invalid_representation',
      })
    }

    await expect(revokeLegacyUserSession(token, claims, 'logout')).resolves.toBe(true)
    await expect(authenticate(token)).resolves.toEqual({ status: 'revoked', reason: 'logout' })

    for (const variant of variants) {
      await expect(
        authenticate(variant.token),
        `${variant.segment}/${variant.kind} alias`
      ).resolves.toEqual({
        status: 'invalid',
        reason: 'invalid_representation',
      })
    }

    // Witness: revocation stays per exact token; another canonical token is valid.
    await expect(authenticate(signFor(principal))).resolves.toMatchObject({
      status: 'authenticated',
      contract: 'v1',
    })
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import {
  type OidcProtocolAttemptBinding,
  cancelOidcProtocolAttempt,
  claimOidcProtocolAttempt,
  finishOidcProtocolAttempt,
  insertOidcProtocolAttempt,
} from '../src/oidc/protocolAttemptStore.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const CLAIM_TEST_APPLICATION_NAME = 'oidc-protocol-attempt-claim-test'
const CLAIM_CONCURRENCY = 12
const ENCRYPTION_KEY = 'ab'.repeat(32)
const BINDING: OidcProtocolAttemptBinding = {
  registrationId: 'company-login',
  configurationGeneration: 'v1:generation-one',
  issuer: 'https://issuer.example.test',
  clientId: 'test-client',
  redirectUri: 'https://api.example.test/oidc/callback',
  responseMode: 'query',
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function waitForBlockedClaimers(
  adminPool: Pool,
  database: string,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await adminPool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = $2
          AND wait_event_type = 'Lock'
          AND query ILIKE '%WITH candidate AS%'`,
      [database, CLAIM_TEST_APPLICATION_NAME]
    )
    if (result.rows[0]?.count === expected) return
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Expected ${expected} OIDC claim queries blocked on the attempt row`)
}

describeRealPostgres('OIDC protocol attempts on real PostgreSQL', () => {
  const database = `oidc_attempts_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({
      connectionString: databaseUrl(adminUrl, database),
      max: CLAIM_CONCURRENCY + 1,
      application_name: CLAIM_TEST_APPLICATION_NAME,
    })
    await initDb({ connect: () => pool!.connect() })
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(pool)
      if (adminPool) {
        await adminPool
          .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
          .catch(() => undefined)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('stores only a state hash and encrypted verifier/nonce, and claims a state once under race', async () => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    const created = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      pkceVerifier: 'secret-pkce-verifier',
      nonce: 'secret-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const stored = await pool!.query<{
      state_hash: string
      pkce_verifier_encrypted: string
      nonce_encrypted: string
    }>(
      `SELECT state_hash, pkce_verifier_encrypted, nonce_encrypted
         FROM oidc_protocol_attempts WHERE id = $1`,
      [created.id]
    )
    expect(stored.rows[0]?.state_hash).not.toBe(state)
    expect(stored.rows[0]?.pkce_verifier_encrypted).not.toContain('secret-pkce-verifier')
    expect(stored.rows[0]?.nonce_encrypted).not.toContain('secret-nonce')

    const blocker = await pool!.connect()
    let claimsPromise: Promise<Awaited<ReturnType<typeof claimOidcProtocolAttempt>>[]> | undefined
    let claims: Awaited<ReturnType<typeof claimOidcProtocolAttempt>>[] = []
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM oidc_protocol_attempts WHERE id = $1 FOR UPDATE', [
        created.id,
      ])
      claimsPromise = Promise.all(
        Array.from({ length: CLAIM_CONCURRENCY }, () =>
          claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BINDING)
        )
      )
      await waitForBlockedClaimers(adminPool!, database, CLAIM_CONCURRENCY)
      await blocker.query('COMMIT')
      claims = await claimsPromise
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
      if (claimsPromise) await Promise.allSettled([claimsPromise])
    }
    const winners = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({
      id: created.id,
      pkceVerifier: 'secret-pkce-verifier',
      nonce: 'secret-nonce',
      ...BINDING,
    })
    expect(await finishOidcProtocolAttempt(pool!, created.id, 'completed')).toBe(true)
    expect(await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BINDING)).toBeNull()
  })

  it('fails closed for an altered binding, expired state, and cancellation', async () => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      pkceVerifier: 'verifier-two',
      nonce: 'nonce-two',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, {
        ...BINDING,
        clientId: 'different-client',
      })
    ).toBeNull()
    expect(await cancelOidcProtocolAttempt(pool!, state, BINDING)).toBe(true)
    expect(await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BINDING)).toBeNull()

    const expiredState = `state-${randomBytes(32).toString('base64url')}`
    await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state: expiredState,
      pkceVerifier: 'expired-verifier',
      nonce: 'expired-nonce',
      expiresAt: new Date(Date.now() - 60_000),
    })
    expect(await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, expiredState, BINDING)).toBeNull()
  })

  it('does not consume an attempt when only its configuration generation is stale', async () => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    const created = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      pkceVerifier: 'generation-bound-verifier',
      nonce: 'generation-bound-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, {
        ...BINDING,
        configurationGeneration: 'v1:generation-after-rotation',
      })
    ).toBeNull()
    expect(
      (
        await pool!.query<{ status: string }>(
          'SELECT status FROM oidc_protocol_attempts WHERE id = $1',
          [created.id]
        )
      ).rows
    ).toEqual([{ status: 'pending' }])

    const original = await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BINDING)
    expect(original).toMatchObject({
      id: created.id,
      configurationGeneration: BINDING.configurationGeneration,
      pkceVerifier: 'generation-bound-verifier',
      nonce: 'generation-bound-nonce',
    })
  })

  it('adopts the original feature migration receipt without rerunning its schema', async () => {
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0131_oidc_protocol_attempts'
    )
    expect(migration?.legacyVersions).toEqual(['0130_oidc_protocol_attempts'])

    await pool!.query('DROP TABLE oidc_protocol_attempts')
    await pool!.query('DELETE FROM schema_migrations WHERE version = $1', [migration!.version])
    await pool!.query(
      `INSERT INTO schema_migrations(version) VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      ['0130_oidc_protocol_attempts']
    )

    await initDb({ connect: () => pool!.connect() })

    const receipt = await pool!.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [migration!.version]
    )
    const relation = await pool!.query<{ relation: string | null }>(
      "SELECT to_regclass('public.oidc_protocol_attempts') AS relation"
    )
    expect(receipt.rows).toEqual([{ version: '0131_oidc_protocol_attempts' }])
    expect(relation.rows[0]?.relation).toBeNull()
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import {
  type OidcProtocolAttemptBinding,
  applyOidcProtocolAttemptExpiryIndexMigration,
  applyOidcProtocolAttemptSchema,
  cancelOidcProtocolAttempt,
  claimOidcProtocolAttempt,
  finishOidcProtocolAttempt,
  insertOidcProtocolAttempt,
  preflightOidcProtocolAttempt,
} from '../src/oidc/protocolAttemptStore.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const CLAIM_TEST_APPLICATION_NAME = 'oidc-protocol-attempt-claim-test'
const CLAIM_CONCURRENCY = 12
const ENCRYPTION_KEY = 'ab'.repeat(32)
const BROWSER_BINDING = randomBytes(32).toString('base64url')
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
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'secret-pkce-verifier',
      nonce: 'secret-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const stored = await pool!.query<{
      state_hash: string
      browser_binding_hash: string
      pkce_verifier_encrypted: string
      nonce_encrypted: string
    }>(
      `SELECT state_hash, browser_binding_hash, pkce_verifier_encrypted, nonce_encrypted
         FROM oidc_protocol_attempts WHERE id = $1`,
      [created.id]
    )
    expect(stored.rows[0]?.state_hash).not.toBe(state)
    expect(stored.rows[0]?.browser_binding_hash).toBe(
      createHash('sha256').update(BROWSER_BINDING, 'utf8').digest('hex')
    )
    expect(stored.rows[0]?.browser_binding_hash).not.toBe(BROWSER_BINDING)
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
          claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, BINDING)
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
    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, BINDING)
    ).toBeNull()
  })

  it('fails closed for an altered binding, expired state, and cancellation', async () => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'verifier-two',
      nonce: 'nonce-two',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, {
        ...BINDING,
        clientId: 'different-client',
      })
    ).toBeNull()
    expect(
      await claimOidcProtocolAttempt(
        pool!,
        ENCRYPTION_KEY,
        state,
        randomBytes(32).toString('base64url'),
        BINDING
      )
    ).toBeNull()
    expect(
      await preflightOidcProtocolAttempt(
        pool!,
        state,
        randomBytes(32).toString('base64url'),
        BINDING
      )
    ).toBe(false)
    expect(await preflightOidcProtocolAttempt(pool!, state, BROWSER_BINDING, BINDING)).toBe(true)
    expect(await cancelOidcProtocolAttempt(pool!, state, BROWSER_BINDING, BINDING)).toBe(true)
    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, BINDING)
    ).toBeNull()

    const expiredState = `state-${randomBytes(32).toString('base64url')}`
    await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state: expiredState,
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'expired-verifier',
      nonce: 'expired-nonce',
      expiresAt: new Date(Date.now() - 60_000),
    })
    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, expiredState, BROWSER_BINDING, BINDING)
    ).toBeNull()
  })

  it('does not consume an attempt when only its configuration generation is stale', async () => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    const created = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'generation-bound-verifier',
      nonce: 'generation-bound-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, {
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

    const original = await claimOidcProtocolAttempt(
      pool!,
      ENCRYPTION_KEY,
      state,
      BROWSER_BINDING,
      BINDING
    )
    expect(original).toMatchObject({
      id: created.id,
      configurationGeneration: BINDING.configurationGeneration,
      pkceVerifier: 'generation-bound-verifier',
      nonce: 'generation-bound-nonce',
    })
  })

  it.each([
    ['registration', { registrationId: 'different-registration' }],
    ['configuration generation', { configurationGeneration: 'rotated-generation' }],
    ['issuer', { issuer: 'https://other-issuer.example.test' }],
    ['client', { clientId: 'other-client' }],
    ['callback URI', { redirectUri: 'https://other.example.test/callback' }],
    ['response mode', { responseMode: 'fragment' as 'query' }],
  ])('keeps a pending attempt unconsumed when its %s binding differs', async (_label, mismatch) => {
    const state = `state-${randomBytes(32).toString('base64url')}`
    const created = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'mismatch-bound-verifier',
      nonce: 'mismatch-bound-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const mismatchedBinding = { ...BINDING, ...mismatch } as OidcProtocolAttemptBinding

    expect(
      await preflightOidcProtocolAttempt(pool!, state, BROWSER_BINDING, mismatchedBinding)
    ).toBe(false)
    expect(
      await claimOidcProtocolAttempt(
        pool!,
        ENCRYPTION_KEY,
        state,
        BROWSER_BINDING,
        mismatchedBinding
      )
    ).toBeNull()
    expect(
      (
        await pool!.query<{ status: string; pkce_verifier_encrypted: string | null }>(
          'SELECT status, pkce_verifier_encrypted FROM oidc_protocol_attempts WHERE id = $1',
          [created.id]
        )
      ).rows
    ).toMatchObject([{ status: 'pending', pkce_verifier_encrypted: expect.any(String) }])

    expect(
      await claimOidcProtocolAttempt(pool!, ENCRYPTION_KEY, state, BROWSER_BINDING, BINDING)
    ).toMatchObject({
      id: created.id,
      pkceVerifier: 'mismatch-bound-verifier',
      nonce: 'mismatch-bound-nonce',
    })
  })

  it('upgrades legacy attempt rows and requires browser binding for new pending attempts', async () => {
    await pool!.query('DROP TABLE oidc_protocol_attempts')
    await pool!.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
      [
        '0131_oidc_protocol_attempts',
        '0132_oidc_protocol_attempt_expiry_index',
        '0133_oidc_protocol_attempt_browser_binding',
      ],
    ])
    await applyOidcProtocolAttemptSchema(pool!)
    await applyOidcProtocolAttemptExpiryIndexMigration(pool!)

    const pendingId = randomUUID()
    const redeemingId = randomUUID()
    const completedId = randomUUID()
    const cancelledId = randomUUID()
    const now = new Date()
    const stateHash = (value: string) => createHash('sha256').update(value).digest('hex')
    const insertLegacy = async (
      id: string,
      status: 'pending' | 'redeeming' | 'completed' | 'cancelled'
    ) => {
      const claimedAt = status === 'redeeming' || status === 'completed' ? now : null
      const finishedAt = status === 'completed' || status === 'cancelled' ? now : null
      await pool!.query(
        `INSERT INTO oidc_protocol_attempts (
           id, state_hash, registration_id, configuration_generation, issuer,
           client_id, redirect_uri, response_mode, purpose, pkce_verifier_encrypted,
           nonce_encrypted, status, expires_at, claimed_at, finished_at
         ) VALUES (
           $1, $2, 'company-login', 'legacy-generation', 'https://issuer.example.test',
           'test-client', 'https://api.example.test/oidc/callback', 'query',
           'identity-proof-v1', $3, $4, $5, $6, $7, $8
         )`,
        [
          id,
          stateHash(id),
          status === 'pending' ? 'legacy-pkce' : null,
          status === 'pending' ? 'legacy-nonce' : null,
          status,
          new Date(Date.now() + 60_000),
          claimedAt,
          finishedAt,
        ]
      )
    }
    await insertLegacy(pendingId, 'pending')
    await insertLegacy(redeemingId, 'redeeming')
    await insertLegacy(completedId, 'completed')
    await insertLegacy(cancelledId, 'cancelled')
    await pool!.query(
      `INSERT INTO schema_migrations(version) VALUES ('0130_oidc_protocol_attempts')`
    )

    await initDb({ connect: () => pool!.connect() })

    const rows = await pool!.query<{
      id: string
      status: string
      browser_binding_hash: string | null
      pkce_verifier_encrypted: string | null
      nonce_encrypted: string | null
      claimed_at: Date | null
      finished_at: Date | null
    }>(
      `SELECT id, status, browser_binding_hash, pkce_verifier_encrypted,
              nonce_encrypted, claimed_at, finished_at
         FROM oidc_protocol_attempts
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[pendingId, redeemingId, completedId, cancelledId]]
    )
    const byId = new Map(rows.rows.map(row => [row.id, row]))
    const pending = byId.get(pendingId)
    const redeeming = byId.get(redeemingId)
    const completed = byId.get(completedId)
    const cancelled = byId.get(cancelledId)

    expect(pending).toMatchObject({
      status: 'cancelled',
      browser_binding_hash: null,
      pkce_verifier_encrypted: null,
      nonce_encrypted: null,
    })
    expect(pending?.finished_at).toBeInstanceOf(Date)
    expect(redeeming).toMatchObject({
      status: 'failed',
      browser_binding_hash: null,
      pkce_verifier_encrypted: null,
      nonce_encrypted: null,
    })
    expect(redeeming?.claimed_at).toBeInstanceOf(Date)
    expect(redeeming?.finished_at).toBeInstanceOf(Date)
    expect(completed).toMatchObject({ status: 'completed', browser_binding_hash: null })
    expect(cancelled).toMatchObject({ status: 'cancelled', browser_binding_hash: null })

    const version = await pool!.query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version = ANY($1::text[])
        ORDER BY version`,
      [
        [
          '0130_oidc_protocol_attempts',
          '0131_oidc_protocol_attempts',
          '0132_oidc_protocol_attempt_expiry_index',
          '0133_oidc_protocol_attempt_browser_binding',
        ],
      ]
    )
    expect(version.rows.map(row => row.version)).toEqual([
      '0130_oidc_protocol_attempts',
      '0131_oidc_protocol_attempts',
      '0132_oidc_protocol_attempt_expiry_index',
      '0133_oidc_protocol_attempt_browser_binding',
    ])

    await expect(
      pool!.query(
        `INSERT INTO oidc_protocol_attempts (
           id, state_hash, registration_id, configuration_generation, issuer,
           client_id, redirect_uri, response_mode, purpose, pkce_verifier_encrypted,
           nonce_encrypted, status, expires_at
         ) VALUES (
           $1, $2, 'company-login', 'new-generation', 'https://issuer.example.test',
           'test-client', 'https://api.example.test/oidc/callback', 'query',
           'identity-proof-v1', 'encrypted-pkce', 'encrypted-nonce', 'pending', now() + interval '5 minutes'
         )`,
        [randomUUID(), stateHash(randomUUID())]
      )
    ).rejects.toMatchObject({ code: '23514' })

    const newAttempt = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      ...BINDING,
      state: `new-${randomBytes(32).toString('base64url')}`,
      browserBinding: BROWSER_BINDING,
      pkceVerifier: 'new-bound-verifier',
      nonce: 'new-bound-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const privilege = await pool!.query<{ can_select: boolean; can_update: boolean }>(
      `SELECT has_table_privilege('control_api_runtime', 'oidc_protocol_attempts', 'SELECT') AS can_select,
              has_table_privilege('control_api_runtime', 'oidc_protocol_attempts', 'UPDATE') AS can_update`
    )
    expect(privilege.rows[0]).toEqual({ can_select: true, can_update: true })
    const storedBinding = await pool!.query<{ browser_binding_hash: string }>(
      `SELECT browser_binding_hash FROM oidc_protocol_attempts WHERE id = $1`,
      [newAttempt.id]
    )
    expect(storedBinding.rows[0]?.browser_binding_hash).toBe(
      createHash('sha256').update(BROWSER_BINDING).digest('hex')
    )
    await initDb({ connect: () => pool!.connect() })
    expect(
      await pool!.query(`SELECT version FROM schema_migrations WHERE version = $1`, [
        '0133_oidc_protocol_attempt_browser_binding',
      ])
    ).toMatchObject({ rowCount: 1 })
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

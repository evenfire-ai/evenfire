import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { insertOidcProtocolAttempt } from '../src/oidc/protocolAttemptStore.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const ENCRYPTION_KEY = 'cd'.repeat(32)
const CLEANUP_BATCH_SIZE = 100
const ATTEMPT_STATUSES = ['pending', 'redeeming', 'completed', 'failed', 'cancelled'] as const

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('OIDC attempt expiry cleanup on real PostgreSQL', () => {
  const database = `oidc_attempt_cleanup_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
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

  it('upgrades an existing attempt table and receipt without recreating its rows', async () => {
    // Recreate the pre-0133 table shape in this disposable database to prove the real
    // upgrade path for a pending attempt that never had browser-possession binding.
    await pool!.query(`
      ALTER TABLE oidc_protocol_attempts
        DROP CONSTRAINT oidc_protocol_attempts_pending_requires_browser_binding,
        DROP CONSTRAINT oidc_protocol_attempts_browser_binding_hash_format,
        DROP COLUMN browser_binding_hash
    `)
    await pool!.query(
      `DELETE FROM schema_migrations WHERE version = '0133_oidc_protocol_attempt_browser_binding'`
    )
    const attemptId = randomUUID()
    await pool!.query(
      `INSERT INTO oidc_protocol_attempts (
         id, state_hash, registration_id, configuration_generation, issuer, client_id,
         redirect_uri, response_mode, purpose, pkce_verifier_encrypted,
         nonce_encrypted, status, expires_at
       ) VALUES (
         $1, $2, 'company-login', 'g1', 'https://issuer.example.test', 'test-client',
         'https://api.example.test/oidc/callback', 'query', 'identity-proof-v1',
         'encrypted-pkce', 'encrypted-nonce', 'pending', now() + INTERVAL '1 hour'
       )`,
      [attemptId, createHash('sha256').update(attemptId).digest('hex')]
    )
    await pool!.query('DROP INDEX IF EXISTS oidc_protocol_attempts_expiry_idx')
    await pool!.query(`
      CREATE INDEX oidc_protocol_attempts_pending_expiry_idx
        ON oidc_protocol_attempts (expires_at)
        WHERE status = 'pending'
    `)
    await pool!.query(
      `DELETE FROM schema_migrations WHERE version = '0132_oidc_protocol_attempt_expiry_index'`
    )

    await initDb({ connect: () => pool!.connect() })

    const row = await pool!.query<{
      id: string
      status: string
      pkce_verifier_encrypted: string | null
      nonce_encrypted: string | null
      browser_binding_hash: string | null
      finished_at: Date | null
    }>(
      `SELECT id, status, pkce_verifier_encrypted, nonce_encrypted,
              browser_binding_hash, finished_at
         FROM oidc_protocol_attempts WHERE id = $1`,
      [attemptId]
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]).toMatchObject({
      id: attemptId,
      status: 'cancelled',
      pkce_verifier_encrypted: null,
      nonce_encrypted: null,
      browser_binding_hash: null,
    })
    expect(row.rows[0]?.finished_at).toBeInstanceOf(Date)
    const receipt = await pool!.query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version = '0132_oidc_protocol_attempt_expiry_index'`
    )
    expect(receipt.rows).toEqual([{ version: '0132_oidc_protocol_attempt_expiry_index' }])
    const browserBindingReceipt = await pool!.query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version = '0133_oidc_protocol_attempt_browser_binding'`
    )
    expect(browserBindingReceipt.rows).toEqual([
      { version: '0133_oidc_protocol_attempt_browser_binding' },
    ])
  }, 60_000)

  it('uses a non-partial ordered expiry index for all lifecycle states', async () => {
    const result = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'oidc_protocol_attempts'
          AND indexname = 'oidc_protocol_attempts_expiry_idx'`
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.indexdef).toMatch(/USING btree \(expires_at, id\)(?!.*\bWHERE\b)/i)

    const legacy = await pool!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'oidc_protocol_attempts'
          AND indexname = 'oidc_protocol_attempts_pending_expiry_idx'`
    )
    expect(legacy.rows).toHaveLength(0)
  })

  it('deletes expired attempts in deterministic bounded batches across every state', async () => {
    const expiredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const claimedAt = new Date(Date.now() - 90 * 60 * 1000)
    const finishedAt = new Date(Date.now() - 60 * 60 * 1000)

    for (let index = 0; index < CLEANUP_BATCH_SIZE + 50; index += 1) {
      const status = ATTEMPT_STATUSES[index % ATTEMPT_STATUSES.length]
      const id = randomUUID()
      const stateHash = createHash('sha256').update(id).digest('hex')
      const pending = status === 'pending'
      const claimed = status === 'redeeming' || status === 'completed' || status === 'failed'
      const finished = status === 'completed' || status === 'failed' || status === 'cancelled'

      await pool!.query(
        `INSERT INTO oidc_protocol_attempts (
           id, state_hash, registration_id, configuration_generation, issuer, client_id,
           redirect_uri, response_mode, purpose, browser_binding_hash,
           pkce_verifier_encrypted, nonce_encrypted,
           status, expires_at, claimed_at, finished_at
         ) VALUES (
           $1, $2, 'company-login', 'g1', 'https://issuer.example.test', 'test-client',
           'https://api.example.test/oidc/callback', 'query', 'identity-proof-v1',
           $3, $4, $5, $6, $7, $8, $9
         )`,
        [
          id,
          stateHash,
          status === 'pending' ? createHash('sha256').update('x'.repeat(43)).digest('hex') : null,
          pending ? 'encrypted-pkce' : null,
          pending ? 'encrypted-nonce' : null,
          status,
          expiredAt,
          claimed ? claimedAt : null,
          finished ? finishedAt : null,
        ]
      )
    }

    const client = await pool!.connect()
    try {
      await client.query('SET enable_seqscan = off')
      const plan = await client.query(
        `EXPLAIN (COSTS OFF)
         SELECT id
           FROM oidc_protocol_attempts
          WHERE expires_at < now() - INTERVAL '1 day'
          ORDER BY expires_at, id
          LIMIT ${CLEANUP_BATCH_SIZE}`
      )
      expect(plan.rows.map(row => Object.values(row).join(' ')).join('\n')).toContain(
        'oidc_protocol_attempts_expiry_idx'
      )
    } finally {
      await client.query('RESET enable_seqscan')
      client.release()
    }

    const liveBinding = {
      registrationId: 'company-login',
      configurationGeneration: 'g1',
      issuer: 'https://issuer.example.test',
      clientId: 'test-client',
      redirectUri: 'https://api.example.test/oidc/callback',
      responseMode: 'query' as const,
    }
    const insert = (state: string) =>
      insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
        ...liveBinding,
        state,
        browserBinding: randomBytes(32).toString('base64url'),
        pkceVerifier: 'test-pkce-verifier',
        nonce: 'test-nonce',
        expiresAt: new Date(Date.now() + 60_000),
      })

    await insert(`live-${randomBytes(12).toString('hex')}`)
    const afterFirstBatch = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM oidc_protocol_attempts
        WHERE expires_at < now() - INTERVAL '1 day'`
    )
    expect(afterFirstBatch.rows[0]?.count).toBe(50)

    await insert(`live-${randomBytes(12).toString('hex')}`)
    const afterSecondBatch = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM oidc_protocol_attempts
        WHERE expires_at < now() - INTERVAL '1 day'`
    )
    expect(afterSecondBatch.rows[0]?.count).toBe(0)
    const liveRows = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM oidc_protocol_attempts
        WHERE expires_at > now()`
    )
    expect(liveRows.rows[0]?.count).toBe(3)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { insertInitialCodexSubscriptionConnection } from '../src/services/codexSubscriptionConnection.js'
import { insertInitialGrokSubscriptionConnection } from '../src/services/grokSubscriptionConnection.js'
import {
  type LlmProviderAttemptInsert,
  applyLlmProviderAttemptConnectionIntegritySchema,
  countDanglingLlmProviderAttemptConnections,
  insertLlmProviderAttempt,
} from '../src/services/llmProviderAttemptStore.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function attempt(overrides: Partial<LlmProviderAttemptInsert>): LlmProviderAttemptInsert {
  return {
    callerKind: 'host',
    hostRef: 'research-host',
    invocationId: `invocation-${randomBytes(8).toString('hex')}`,
    attemptGeneration: 1,
    providerAttemptIndex: 1,
    model: 'gpt-5.1',
    requestHash: 'd'.repeat(64),
    policyRevision: 1,
    policyHash: 'e'.repeat(64),
    budgetReservationId: 'unbudgeted',
    connectionRevision: 1,
    ...overrides,
  }
}

describeRealPostgres('0114 llm_provider_attempts connection integrity on real PostgreSQL', () => {
  const database = `attempt_integrity_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let codexConnectionId: string
  let grokConnectionId: string

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => pool.connect() })
    codexConnectionId = (
      await insertInitialCodexSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-codex', accountFingerprint: 'fp-codex-integrity' },
        'team-codex-integrity'
      )
    ).id
    grokConnectionId = (
      await insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-grok', accountFingerprint: 'fp-grok-integrity' },
        'team-grok-integrity'
      )
    ).id
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  it('accepts attempts whose connection_id exists in the provider table', async () => {
    const codex = await insertLlmProviderAttempt(
      pool,
      attempt({ provider: 'codex-subscription', connectionId: codexConnectionId })
    )
    expect(codex.connectionId).toBe(codexConnectionId)
    const grok = await insertLlmProviderAttempt(
      pool,
      attempt({ provider: 'grok-subscription', model: 'grok-4.6', connectionId: grokConnectionId })
    )
    expect(grok.connectionId).toBe(grokConnectionId)
    // Pre-0103 Codex rows (and old pods) may still carry no connection id.
    const legacy = await insertLlmProviderAttempt(
      pool,
      attempt({ provider: 'codex-subscription', connectionId: null })
    )
    expect(legacy.connectionId).toBeNull()
  })

  it('rejects a Codex attempt that names a Grok connection id', async () => {
    await expect(
      insertLlmProviderAttempt(
        pool,
        attempt({ provider: 'codex-subscription', connectionId: grokConnectionId })
      )
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'llm_provider_attempts_connection_integrity',
    })
  })

  it('rejects a Grok attempt with a connection id that exists nowhere or only for Codex', async () => {
    for (const connectionId of [randomUUID(), codexConnectionId]) {
      await expect(
        insertLlmProviderAttempt(
          pool,
          attempt({ provider: 'grok-subscription', model: 'grok-4.6', connectionId })
        )
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'llm_provider_attempts_connection_integrity',
      })
    }
  })

  it('rejects a Codex attempt with a random connection id', async () => {
    await expect(
      insertLlmProviderAttempt(
        pool,
        attempt({ provider: 'codex-subscription', connectionId: randomUUID() })
      )
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('rejects updates that point connection_id or provider at another table', async () => {
    const row = await insertLlmProviderAttempt(
      pool,
      attempt({ provider: 'codex-subscription', connectionId: codexConnectionId })
    )
    await expect(
      pool.query(`UPDATE llm_provider_attempts SET connection_id = $1 WHERE id = $2`, [
        randomUUID(),
        row.id,
      ])
    ).rejects.toMatchObject({ code: '23503' })
    await expect(
      pool.query(`UPDATE llm_provider_attempts SET provider = 'grok-subscription' WHERE id = $1`, [
        row.id,
      ])
    ).rejects.toMatchObject({ code: '23503' })
    // Lifecycle updates that do not touch provider/connection_id still work.
    await expect(
      pool.query(`UPDATE llm_provider_attempts SET status = 'redeemed' WHERE id = $1`, [row.id])
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('re-applies idempotently and never fails on historic dangling rows', async () => {
    await pool.query(
      `DROP TRIGGER IF EXISTS llm_provider_attempts_connection_integrity ON llm_provider_attempts`
    )
    const dangling = await insertLlmProviderAttempt(
      pool,
      attempt({ provider: 'codex-subscription', connectionId: randomUUID() })
    )
    await expect(applyLlmProviderAttemptConnectionIntegritySchema(pool)).resolves.toBeUndefined()
    await expect(applyLlmProviderAttemptConnectionIntegritySchema(pool)).resolves.toBeUndefined()
    expect(await countDanglingLlmProviderAttemptConnections(pool)).toBe(1)
    const triggers = await pool.query<{ tgname: string; tgconstraint: string }>(
      `SELECT tgname, tgconstraint::text
         FROM pg_trigger
        WHERE tgrelid = 'llm_provider_attempts'::regclass
          AND tgname = 'llm_provider_attempts_connection_integrity'`
    )
    expect(triggers.rows).toHaveLength(1)
    expect(triggers.rows[0]?.tgconstraint).not.toBe('0')
    // The historic row stays readable and finalizable (status-only update).
    await expect(
      pool.query(`UPDATE llm_provider_attempts SET status = 'redeemed' WHERE id = $1`, [
        dangling.id,
      ])
    ).resolves.toMatchObject({ rowCount: 1 })
    // New writes are enforced again.
    await expect(
      insertLlmProviderAttempt(
        pool,
        attempt({ provider: 'codex-subscription', connectionId: randomUUID() })
      )
    ).rejects.toMatchObject({ code: '23503' })
  })
})

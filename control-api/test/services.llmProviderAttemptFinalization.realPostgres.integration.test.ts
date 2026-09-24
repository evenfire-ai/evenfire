import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { reserveInDangerZone } from '../src/services/budgets/reservations.js'
import {
  insertInitialCodexSubscriptionConnection,
  loadCodexSubscriptionSecrets,
} from '../src/services/codexSubscriptionConnection.js'
import { CODEX_ATTEMPT_RESERVATION_TTL_SECONDS } from '../src/services/llmProviderAttemptEnvelope.js'
import { finalizeLlmProviderAttempt } from '../src/services/llmProviderAttemptFinalization.js'
import { opaqueAttemptReceipt } from '../src/services/llmProviderAttemptRedemption.js'
import { redeemLlmProviderAttempt } from '../src/services/llmProviderAttemptRedemption.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from '../src/services/llmProviderAttemptTicket.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
if (process.env.CONTROL_API_REAL_PG_REQUIRED === '1' && !adminUrl) {
  throw new Error(
    'REAL_PG_REQUIRED_BUT_UNAVAILABLE: CONTROL_API_REAL_PG_ADMIN_URL is required for Codex finalize ledger proof'
  )
}
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

describeRealPostgres('Codex attempt finalization on real PostgreSQL', () => {
  const database = `llm_attempt_final_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool
  let connectionId: string

  async function runTx<T>(work: (tx: Pool) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client as never)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // keep the original error
      }
      throw error
    } finally {
      client.release()
    }
  }

  function txDeps() {
    return {
      enabled: true as const,
      encryptionKey: KEY,
      loadSecrets: loadCodexSubscriptionSecrets,
      withTransaction: runTx,
    }
  }

  beforeAll(async () => {
    config.codexSubscriptionEnabled = true
    config.oauthEncryptionKey = 'ab'.repeat(32)
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    const connection = await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'refresh-secret',
      accessToken: 'access-usable',
      chatgptAccountId: 'acct_test_1',
      accountFingerprint: 'fp-final',
    })
    connectionId = connection.id
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

  it('accepts repeated finalize calls as one terminal outcome and does not invent usage', async () => {
    const attempt = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      model: 'gpt-5.1',
      requestHash: 'f'.repeat(64),
      policyRevision: 1,
      policyHash: 'e'.repeat(64),
      budgetReservationId: 'unbudgeted',
      connectionRevision: 1,
      connectionId,
    })
    const issued = await issueRegisteredCodexExecutionTicket(pool, {
      sub: 'host/research-host',
      hostRef: attempt.hostRef,
      invocationId: attempt.invocationId,
      attemptGeneration: attempt.attemptGeneration,
      providerAttemptId: attempt.id,
      providerAttemptIndex: attempt.providerAttemptIndex,
      model: attempt.model,
      requestHash: attempt.requestHash,
      policyRevision: attempt.policyRevision,
      policyHash: attempt.policyHash,
      budgetReservationId: attempt.budgetReservationId,
      connectionRevision: attempt.connectionRevision,
    })
    await redeemLlmProviderAttempt(
      {
        executionTicket: issued.executionTicket,
        requestHash: attempt.requestHash,
      },
      txDeps()
    )
    const attemptReceipt = opaqueAttemptReceipt({
      jti: issued.claims.jti,
      providerAttemptId: attempt.id,
      requestHash: attempt.requestHash,
    })
    const receipt = {
      schemaVersion: 'codex-attempt-receipt.v1' as const,
      providerAttemptId: attempt.id,
      requestHash: attempt.requestHash,
      outcome: 'unknown' as const,
    }

    const first = await finalizeLlmProviderAttempt({ attemptReceipt, receipt }, runTx)
    const repeats = await Promise.all(
      Array.from({ length: 8 }, () =>
        finalizeLlmProviderAttempt({ attemptReceipt, receipt }, runTx)
      )
    )
    expect(first).toMatchObject({
      providerAttemptId: attempt.id,
      outcome: 'unknown',
      duplicate: false,
    })
    expect(repeats.every(result => result.duplicate && result.outcome === 'unknown')).toBe(true)

    const stored = await pool.query<{
      outcome: string
      usage_input_tokens: number | null
      usage_output_tokens: number | null
    }>(
      `SELECT outcome, usage_input_tokens, usage_output_tokens
         FROM llm_provider_attempts
        WHERE id = $1`,
      [attempt.id]
    )
    expect(stored.rows[0]).toEqual({
      outcome: 'unknown',
      usage_input_tokens: null,
      usage_output_tokens: null,
    })

    await expect(
      finalizeLlmProviderAttempt(
        {
          attemptReceipt,
          receipt: { ...receipt, outcome: 'success' },
        },
        runTx
      )
    ).rejects.toMatchObject({ code: 'conflict' })

    const unknownLedger = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM usage_events WHERE request_id = $1::uuid`,
      [attempt.id]
    )
    expect(unknownLedger.rows[0]?.count).toBe(0)
  })

  it('writes exactly one usage_events row with a null user_id on success finalize', async () => {
    const attempt = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      model: 'gpt-5.1',
      requestHash: 'c'.repeat(64),
      policyRevision: 1,
      policyHash: 'd'.repeat(64),
      budgetReservationId: 'unbudgeted',
      connectionRevision: 1,
      connectionId,
    })
    const issued = await issueRegisteredCodexExecutionTicket(pool, {
      sub: 'host/research-host',
      hostRef: attempt.hostRef,
      invocationId: attempt.invocationId,
      attemptGeneration: attempt.attemptGeneration,
      providerAttemptId: attempt.id,
      providerAttemptIndex: attempt.providerAttemptIndex,
      model: attempt.model,
      requestHash: attempt.requestHash,
      policyRevision: attempt.policyRevision,
      policyHash: attempt.policyHash,
      budgetReservationId: attempt.budgetReservationId,
      connectionRevision: attempt.connectionRevision,
    })
    await redeemLlmProviderAttempt(
      {
        executionTicket: issued.executionTicket,
        requestHash: attempt.requestHash,
      },
      txDeps()
    )
    const attemptReceipt = opaqueAttemptReceipt({
      jti: issued.claims.jti,
      providerAttemptId: attempt.id,
      requestHash: attempt.requestHash,
    })
    const receipt = {
      schemaVersion: 'codex-attempt-receipt.v1' as const,
      providerAttemptId: attempt.id,
      requestHash: attempt.requestHash,
      outcome: 'success' as const,
      usage: { inputTokens: 12, outputTokens: 4 },
    }

    const first = await finalizeLlmProviderAttempt({ attemptReceipt, receipt }, runTx)
    const repeat = await finalizeLlmProviderAttempt({ attemptReceipt, receipt }, runTx)
    expect(first).toMatchObject({
      providerAttemptId: attempt.id,
      outcome: 'success',
      duplicate: false,
    })
    expect(repeat.duplicate).toBe(true)

    const ledger = await pool.query<{
      count: number
      user_id: string | null
      source_kind: string
      llm_secret_name: string | null
      provider: string
    }>(
      `SELECT COUNT(*)::int AS count,
              MIN(user_id::text) AS user_id,
              MIN(source_kind) AS source_kind,
              MIN(llm_secret_name) AS llm_secret_name,
              MIN(provider) AS provider
         FROM usage_events
        WHERE request_id = $1::uuid`,
      [attempt.id]
    )
    expect(ledger.rows[0]).toEqual({
      count: 1,
      user_id: null,
      source_kind: 'channel',
      llm_secret_name: null,
      provider: 'codex-subscription',
    })
  })

  it('releases the attempt-lifetime budget reservation when the attempt finalizes', async () => {
    const budget = await pool.query<{ id: string }>(
      `INSERT INTO token_budgets
         (name, scope, unit, limit_amount, period, timezone,
          min_start_amount, max_task_amount, enforcement)
       VALUES ('attempt-envelope', '{}'::jsonb, 'tokens', 1000, 'monthly', 'UTC', 0, 2000, 'block')
       RETURNING id`
    )
    const budgetId = budget.rows[0]!.id
    try {
      const invocationId = `invocation-${randomUUID()}`
      const reserved = await reserveInDangerZone(
        {
          budgetId,
          limit: 1000,
          spent: 0,
          minStart: 0,
          estAmount: 2000,
          taskRef: `${invocationId}:1:1`,
          hostRef: 'research-host',
          ttlSeconds: CODEX_ATTEMPT_RESERVATION_TTL_SECONDS,
        },
        pool
      )
      if (reserved.decision !== 'allow') throw new Error('expected the reservation to be allowed')

      const attempt = await insertLlmProviderAttempt(pool, {
        callerKind: 'host',
        hostRef: 'research-host',
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        model: 'gpt-5.1',
        requestHash: 'b'.repeat(64),
        policyRevision: 1,
        policyHash: 'a'.repeat(64),
        budgetReservationId: reserved.reservationId,
        connectionRevision: 1,
        connectionId,
      })
      const issued = await issueRegisteredCodexExecutionTicket(pool, {
        sub: 'host/research-host',
        hostRef: attempt.hostRef,
        invocationId: attempt.invocationId,
        attemptGeneration: attempt.attemptGeneration,
        providerAttemptId: attempt.id,
        providerAttemptIndex: attempt.providerAttemptIndex,
        model: attempt.model,
        requestHash: attempt.requestHash,
        policyRevision: attempt.policyRevision,
        policyHash: attempt.policyHash,
        budgetReservationId: attempt.budgetReservationId,
        connectionRevision: attempt.connectionRevision,
      })
      await redeemLlmProviderAttempt(
        { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
        txDeps()
      )

      // Witness: the reservation is live, with the attempt-lifetime TTL, right
      // before finalize, so its absence afterwards is the release.
      const before = await pool.query<{ ttl_seconds: number }>(
        `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl_seconds
           FROM budget_pending_reservations
          WHERE id = $1 AND expires_at > NOW()`,
        [reserved.reservationId]
      )
      expect(before.rows).toEqual([{ ttl_seconds: CODEX_ATTEMPT_RESERVATION_TTL_SECONDS }])

      const finalized = await finalizeLlmProviderAttempt(
        {
          attemptReceipt: opaqueAttemptReceipt({
            jti: issued.claims.jti,
            providerAttemptId: attempt.id,
            requestHash: attempt.requestHash,
          }),
          receipt: {
            schemaVersion: 'codex-attempt-receipt.v1' as const,
            providerAttemptId: attempt.id,
            requestHash: attempt.requestHash,
            outcome: 'success' as const,
            usage: { inputTokens: 7, outputTokens: 3 },
          },
        },
        runTx
      )
      expect(finalized).toMatchObject({ outcome: 'success', duplicate: false })

      const after = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM budget_pending_reservations WHERE id = $1`,
        [reserved.reservationId]
      )
      expect(after.rows[0]?.count).toBe(0)
    } finally {
      await pool.query('DELETE FROM token_budgets WHERE id = $1', [budgetId])
    }
  })
})

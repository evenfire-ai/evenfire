import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  insertInitialCodexSubscriptionConnection,
  loadCodexSubscriptionSecrets,
} from '../src/services/codexSubscriptionConnection.js'
import { finalizeLlmProviderAttempt } from '../src/services/llmProviderAttemptFinalization.js'
import { opaqueAttemptReceipt } from '../src/services/llmProviderAttemptRedemption.js'
import { redeemLlmProviderAttempt } from '../src/services/llmProviderAttemptRedemption.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from '../src/services/llmProviderAttemptTicket.js'

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

describeRealPostgres('Codex attempt finalization on real PostgreSQL', () => {
  const database = `llm_attempt_final_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool

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
    await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'refresh-secret',
      accessToken: 'access-usable',
      chatgptAccountId: 'acct_test_1',
      accountFingerprint: 'fp-final',
    })
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
  })
})

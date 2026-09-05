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

describeRealPostgres('Codex ticket redemption on real PostgreSQL', () => {
  const database = `llm_attempt_redeem_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool
  let connectionId: string

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
      accountFingerprint: 'fp-redeem',
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

  it('lets exactly one of 20 concurrent redeems win', async () => {
    const attempt = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      model: 'gpt-5.1',
      requestHash: 'd'.repeat(64),
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

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        redeemLlmProviderAttempt(
          {
            executionTicket: issued.executionTicket,
            requestHash: attempt.requestHash,
          },
          {
            enabled: true,
            encryptionKey: KEY,
            loadSecrets: loadCodexSubscriptionSecrets,
            withTransaction: async work => {
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
            },
          }
        )
      )
    )
    const wins = results.filter(result => result.status === 'fulfilled')
    const losses = results.filter(result => result.status === 'rejected')
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(19)
    if (wins[0]?.status === 'fulfilled') {
      expect(wins[0].value.accessToken).toBe('access-usable')
      expect(wins[0].value.chatgptAccountId).toBe('acct_test_1')
      expect(JSON.stringify(wins[0].value)).not.toContain('refresh-secret')
      expect(wins[0].value.attemptReceipt).toBe(
        opaqueAttemptReceipt({
          jti: issued.claims.jti,
          providerAttemptId: attempt.id,
          requestHash: attempt.requestHash,
        })
      )
    }
    for (const loss of losses) {
      if (loss.status === 'rejected') {
        expect((loss.reason as { code?: string }).code).toBe('ticket_replayed')
      }
    }
  })
})

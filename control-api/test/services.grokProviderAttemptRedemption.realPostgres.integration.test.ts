import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { redeemGrokProviderAttempt } from '../src/services/grokProviderAttemptRedemption.js'
import { issueRegisteredGrokExecutionTicket } from '../src/services/grokProviderAttemptTicket.js'
import {
  getSafeGrokSubscriptionConnectionById,
  insertInitialGrokSubscriptionConnection,
  loadGrokSubscriptionSecrets,
} from '../src/services/grokSubscriptionConnection.js'
import { opaqueAttemptReceipt } from '../src/services/llmProviderAttemptRedemption.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))
const CONNECTION_KEY = 'team-grok-redeem'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('Grok ticket redemption on real PostgreSQL', () => {
  const database = `grok_attempt_redeem_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool
  let connectionId: string
  const previousFlag = config.grokSubscriptionEnabled

  beforeAll(async () => {
    config.grokSubscriptionEnabled = true
    config.oauthEncryptionKey = 'ab'.repeat(32)
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    const connection = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      {
        refreshToken: 'refresh-secret',
        accessToken: 'access-usable',
        accountFingerprint: 'fp-grok-redeem',
      },
      CONNECTION_KEY
    )
    connectionId = connection.id
  }, 60_000)

  afterAll(async () => {
    config.grokSubscriptionEnabled = previousFlag
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  async function issueRedeemableTicket() {
    const attempt = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      provider: 'grok-subscription',
      model: 'grok-4.6',
      requestHash: 'd'.repeat(64),
      policyRevision: 1,
      policyHash: 'e'.repeat(64),
      budgetReservationId: 'unbudgeted',
      connectionRevision: 1,
      connectionId,
    })
    const issued = await issueRegisteredGrokExecutionTicket(pool, {
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
      connectionId,
    })
    return { attempt, issued }
  }

  function redeemDeps() {
    return {
      enabled: true as const,
      db: pool,
      encryptionKey: KEY,
      loadSecrets: loadGrokSubscriptionSecrets,
      getConnectionById: getSafeGrokSubscriptionConnectionById,
      withTransaction: async (work: (tx: Pool) => Promise<unknown>) => {
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
  }

  it('redeems an issued Grok ticket once and returns the access token', async () => {
    const { attempt, issued } = await issueRedeemableTicket()
    const redeemed = await redeemGrokProviderAttempt(
      {
        executionTicket: issued.executionTicket,
        requestHash: attempt.requestHash,
      },
      redeemDeps()
    )
    expect(redeemed.accessToken).toBe('access-usable')
    expect(JSON.stringify(redeemed)).not.toContain('refresh-secret')
    expect(redeemed.attemptReceipt).toBe(
      opaqueAttemptReceipt({
        jti: issued.claims.jti,
        providerAttemptId: attempt.id,
        requestHash: attempt.requestHash,
      })
    )
  })

  it('lets exactly one of 20 concurrent redeems win', async () => {
    const { attempt, issued } = await issueRedeemableTicket()
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        redeemGrokProviderAttempt(
          {
            executionTicket: issued.executionTicket,
            requestHash: attempt.requestHash,
          },
          redeemDeps()
        )
      )
    )
    const wins = results.filter(result => result.status === 'fulfilled')
    const losses = results.filter(result => result.status === 'rejected')
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(19)
    for (const loss of losses) {
      if (loss.status === 'rejected') {
        expect((loss.reason as { code?: string }).code).toBe('ticket_replayed')
      }
    }
  })
})

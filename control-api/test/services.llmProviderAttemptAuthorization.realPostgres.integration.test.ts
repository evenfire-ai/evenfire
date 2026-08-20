import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { getActiveReservation } from '../src/services/budgets/reservations.js'
import {
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  recordCodexCatalogOutcome,
} from '../src/services/codexSubscriptionConnection.js'
import { getModelAllowlistState } from '../src/services/llmAllowedModels.js'
import {
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
  computeCodexPolicyHash,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import {
  getMaxLlmProviderAttemptGeneration,
  insertLlmProviderAttempt,
} from '../src/services/llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from '../src/services/llmProviderAttemptTicket.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

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

const REQUEST = {
  schemaVersion: 'codex-completion-request.v1' as const,
  requestId: 'req-pg-1',
  idempotencyKey: 'idem-pg-1',
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello from postgres' }],
}

function claims(): McpHostAccessClaims {
  return {
    sub: 'default/research-host',
    recipeNamespace: 'default',
    recipeName: 'research-host',
    hostRefs: ['research-host'],
    scope: 'workflow:approval:request',
    workflowControlScopes: ['llm:codex:execute'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 60,
  }
}

describeRealPostgres('Codex provider-attempt authorization on real PostgreSQL', () => {
  const database = `llm_attempt_authz_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool

  function dbClient() {
    return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
  }

  function testDeps(
    overrides: Partial<LlmProviderAttemptAuthorizerDeps> = {}
  ): LlmProviderAttemptAuthorizerDeps {
    const db = dbClient()
    return {
      enabled: true,
      db,
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
      getConnection: getSafeCodexSubscriptionConnection,
      getModelState: getModelAllowlistState,
      evaluateBudget: evaluateBudgetCheck,
      getActiveReservation,
      getMaxGeneration: getMaxLlmProviderAttemptGeneration,
      insertAttempt: insertLlmProviderAttempt,
      issueTicket: issueRegisteredCodexExecutionTicket,
      ...overrides,
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'refresh-authz',
      accountFingerprint: 'fp-authz',
    })
    await recordCodexCatalogOutcome(pool, {
      catalogStatus: 'ready',
      expectedCredentialRevision: 1,
      expectedCatalogRevision: 0,
    })
    await pool.query(
      `INSERT INTO llm_allowed_models (provider, model, enabled, source, stale)
       VALUES ('codex-subscription', 'gpt-5.1', true, 'discovery', false)`
    )
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

  it('lets only one concurrent authorization win for the same invocation binding', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    expect(current?.status).toBe('connected')
    const payload = {
      request: REQUEST,
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      policyRevision: current!.catalogRevision,
      policyHash: computeCodexPolicyHash({
        model: REQUEST.model,
        catalogRevision: current!.catalogRevision,
        credentialRevision: current!.credentialRevision,
      }),
    }
    const deps = testDeps()
    const [first, second] = await Promise.allSettled([
      authorizeLlmProviderAttempt(claims(), payload, deps),
      authorizeLlmProviderAttempt(claims(), payload, deps),
    ])
    const wins = [first, second].filter(result => result.status === 'fulfilled')
    const losses = [first, second].filter(result => result.status === 'rejected')
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    if (losses[0]?.status === 'rejected') {
      expect((losses[0].reason as { code?: string }).code).toBe('idempotency_conflict')
    }

    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM llm_provider_attempts
        WHERE invocation_id = $1`,
      [payload.invocationId]
    )
    expect(count.rows[0]?.count).toBe('1')
    expect(JSON.stringify(wins[0])).not.toContain('hello from postgres')
  })

  it('rolls budget reservation, attempt, and ticket back together when ticket issue fails', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    const invocationId = `invocation-rollback-${randomUUID()}`
    const payload = {
      request: { ...REQUEST, requestId: 'req-pg-2', idempotencyKey: 'idem-pg-2' },
      invocationId,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      policyRevision: current!.catalogRevision,
      policyHash: computeCodexPolicyHash({
        model: REQUEST.model,
        catalogRevision: current!.catalogRevision,
        credentialRevision: current!.credentialRevision,
      }),
    }

    await expect(
      authorizeLlmProviderAttempt(
        claims(),
        payload,
        testDeps({
          issueTicket: async () => {
            throw new Error('ticket registration failed')
          },
        })
      )
    ).rejects.toThrow(/ticket registration failed/)

    const leftover = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM llm_provider_attempts
        WHERE invocation_id = $1`,
      [invocationId]
    )
    expect(leftover.rows[0]?.count).toBe('0')
  })
})

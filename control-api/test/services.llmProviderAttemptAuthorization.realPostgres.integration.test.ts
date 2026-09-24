import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { LIMITS } from '@clerum/llm-provider-attempt-contract'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { __resetBudgetCheckCache, evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { getActiveReservation } from '../src/services/budgets/reservations.js'
import { getCodexCatalogModelState } from '../src/services/codexSubscriptionCatalog.js'
import {
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  recordCodexCatalogOutcome,
} from '../src/services/codexSubscriptionConnection.js'
import {
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
  computeCodexPolicyHash,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import { CODEX_ATTEMPT_RESERVATION_TTL_SECONDS } from '../src/services/llmProviderAttemptEnvelope.js'
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
    mcpCapabilities: [],
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
      getModelState: getCodexCatalogModelState,
      resolveAssignment: async () => ({
        liveBrokerProviders: ['codex-subscription'],
        liveConnectionRef: 'deployment-default',
      }),
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
    const created = await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'refresh-authz',
      accountFingerprint: 'fp-authz',
    })
    await recordCodexCatalogOutcome(pool, {
      catalogStatus: 'ready',
      expectedCredentialRevision: 1,
      expectedCatalogRevision: 0,
    })
    await pool.query(
      `INSERT INTO codex_catalog_models
         (connection_id, model, enabled, source, discovered_at, last_seen_at, stale)
       VALUES ($1, 'gpt-5.1', true, 'discovery', NOW(), NOW(), false)`,
      [created.id]
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
        connectionKey: current!.connectionKey,
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
        connectionKey: current!.connectionKey,
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

  it('reserves a danger-zone token budget for the whole attempt lifetime', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    // remaining (1000) < max_task_amount (2000) puts the budget in the danger
    // zone, and min_start 0 lets the attempt through with a reservation.
    const budget = await pool.query<{ id: string }>(
      `INSERT INTO token_budgets
         (name, scope, unit, limit_amount, period, timezone,
          min_start_amount, max_task_amount, enforcement)
       VALUES ('attempt-envelope', '{}'::jsonb, 'tokens', 1000, 'monthly', 'UTC', 0, 2000, 'block')
       RETURNING id`
    )
    const budgetId = budget.rows[0]!.id
    __resetBudgetCheckCache()
    try {
      const invocationId = `invocation-envelope-${randomUUID()}`
      const authorized = await authorizeLlmProviderAttempt(
        claims(),
        {
          request: { ...REQUEST, requestId: 'req-pg-3', idempotencyKey: 'idem-pg-3' },
          invocationId,
          attemptGeneration: 1,
          providerAttemptIndex: 1,
          policyRevision: current!.catalogRevision,
          policyHash: computeCodexPolicyHash({
            model: REQUEST.model,
            catalogRevision: current!.catalogRevision,
            credentialRevision: current!.credentialRevision,
            connectionKey: current!.connectionKey,
          }),
        },
        testDeps()
      )
      expect(authorized.providerAttemptId).toEqual(expect.any(String))

      // created_at and expires_at come from the same statement's NOW(), so
      // their difference is exactly the TTL the reservation was written with.
      const reservations = await pool.query<{
        id: string
        task_ref: string
        ttl_seconds: number
      }>(
        `SELECT id, task_ref,
                EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl_seconds
           FROM budget_pending_reservations
          WHERE budget_id = $1`,
        [budgetId]
      )
      expect(reservations.rows).toEqual([
        {
          id: expect.any(String),
          task_ref: `${invocationId}:1:1`,
          ttl_seconds: CODEX_ATTEMPT_RESERVATION_TTL_SECONDS,
        },
      ])
      expect(CODEX_ATTEMPT_RESERVATION_TTL_SECONDS).toBe(2160)

      const attempt = await pool.query<{ budget_reservation_id: string }>(
        `SELECT budget_reservation_id FROM llm_provider_attempts WHERE invocation_id = $1`,
        [invocationId]
      )
      expect(attempt.rows).toEqual([{ budget_reservation_id: reservations.rows[0]!.id }])
    } finally {
      await pool.query('DELETE FROM token_budgets WHERE id = $1', [budgetId])
      __resetBudgetCheckCache()
    }
  })

  it.each([false, true])(
    'rolls back an oversized signed V2 envelope without losing an existing reservation (presented=%s)',
    async presented => {
      const current = await getSafeCodexSubscriptionConnection(pool)
      const invocationId = `visual-envelope-${randomUUID()}`
      const request = {
        ...REQUEST,
        schemaVersion: 'codex-completion-request.v2',
        messages: [{ role: 'user', content: '' }],
      }
      const budgetId = randomUUID()
      const existingReservationId = randomUUID()
      // Force the real danger-zone path without relying on rollup timing. The
      // configured maximum task is greater than the remaining period allowance.
      await pool.query(
        `INSERT INTO token_budgets
        (id, name, scope, unit, limit_amount, period, min_start_amount, max_task_amount, enforcement)
       VALUES ($1, 'visual envelope rollback', $2::jsonb, 'tokens', 100, 'daily', 1, 200, 'block')`,
        [budgetId, JSON.stringify({ provider: ['codex-subscription'], model: [REQUEST.model] })]
      )
      await pool.query(
        `INSERT INTO budget_pending_reservations
        (id, budget_id, est_amount, task_ref, host_ref, expires_at)
       VALUES ($1, $2, 5, 'preexisting-visual-task', 'research-host', NOW() + INTERVAL '15 minutes')`,
        [existingReservationId, budgetId]
      )
      __resetBudgetCheckCache()
      const payload = {
        request,
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: current!.catalogRevision,
        policyHash: computeCodexPolicyHash({
          model: REQUEST.model,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
        ...(presented ? { budgetReservationId: existingReservationId } : {}),
      }
      request.messages[0].content = 'x'.repeat(
        LIMITS.maxRequestBodyBytes - Buffer.byteLength(JSON.stringify(payload)) - 16
      )
      const counts = () =>
        pool.query(`SELECT
      (SELECT count(*)::text FROM llm_provider_attempts) AS attempts,
      (SELECT count(*)::text FROM llm_provider_attempt_tickets) AS tickets,
      (SELECT count(*)::text FROM budget_pending_reservations) AS reservations`)
      const readExisting = () =>
        pool.query('SELECT * FROM budget_pending_reservations WHERE id = $1', [
          existingReservationId,
        ])
      const before = (await counts()).rows[0]
      const existingBefore = (await readExisting()).rows[0]
      let observedReservationId: string | undefined
      let signed = false
      try {
        await expect(
          authorizeLlmProviderAttempt(
            claims(),
            payload,
            testDeps({
              issueTicket: async (db, input) => {
                observedReservationId = input.budgetReservationId
                const active = await db.query(
                  'SELECT id FROM budget_pending_reservations WHERE budget_id = $1',
                  [budgetId]
                )
                expect(active.rows).toHaveLength(presented ? 1 : 2)
                if (presented) expect(input.budgetReservationId).toBe(existingReservationId)
                else {
                  expect(input.budgetReservationId).not.toBe('unbudgeted')
                  expect(input.budgetReservationId).not.toBe(existingReservationId)
                }
                const issued = await issueRegisteredCodexExecutionTicket(db, input)
                const registered = await db.query(
                  'SELECT jti FROM llm_provider_attempt_tickets WHERE provider_attempt_id = $1',
                  [input.providerAttemptId]
                )
                expect(registered.rows).toHaveLength(1)
                signed = true
                // The request's text budget stays at 1 MiB. Inject an oversized
                // return value only after a real ticket/reservation exists in
                // this transaction, to prove the final envelope guard rolls
                // back database writes. This value never leaves the test.
                return {
                  ...issued,
                  executionTicket:
                    issued.executionTicket + 'x'.repeat(LIMITS.maxVisualRequestBodyBytes),
                }
              },
            })
          )
        ).rejects.toMatchObject({ code: 'payload_too_large' })
        expect(signed).toBe(true)
        expect((await counts()).rows[0]).toEqual(before)
        expect((await readExisting()).rows[0]).toEqual(existingBefore)
        if (!presented) {
          expect(observedReservationId).toBeDefined()
          expect(
            (
              await pool.query('SELECT id FROM budget_pending_reservations WHERE id = $1', [
                observedReservationId,
              ])
            ).rows
          ).toHaveLength(0)
        }
        const leftover = await pool.query(
          'SELECT id FROM llm_provider_attempts WHERE invocation_id = $1',
          [invocationId]
        )
        expect(leftover.rows).toHaveLength(0)
        // A failed size check must not burn the invocation/attempt identity.
        // Retrying that same binding with a request that fits must authorize.
        request.messages[0].content = 'A bounded request after rollback'
        const retried = await authorizeLlmProviderAttempt(claims(), payload, testDeps())
        const committed = await pool.query(
          'SELECT id FROM llm_provider_attempts WHERE invocation_id = $1',
          [invocationId]
        )
        expect(committed.rows).toEqual([{ id: retried.providerAttemptId }])
        expect((await readExisting()).rows[0]).toEqual(existingBefore)
      } finally {
        await pool.query('DELETE FROM token_budgets WHERE id = $1', [budgetId])
        __resetBudgetCheckCache()
      }
    }
  )
})

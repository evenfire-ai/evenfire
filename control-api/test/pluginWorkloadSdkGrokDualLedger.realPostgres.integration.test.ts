import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { getActiveReservation } from '../src/services/budgets/reservations.js'
import {
  getSafeGrokSubscriptionConnection,
  insertInitialGrokSubscriptionConnection,
  recordGrokCatalogOutcome,
} from '../src/services/grokSubscriptionConnection.js'
import { authorizeLlmProviderAttempt } from '../src/services/llmProviderAttemptAuthorizer.js'
import {
  getMaxLlmProviderAttemptGeneration,
  insertLlmProviderAttempt,
  loadLlmProviderAttemptBySdkAttemptId,
} from '../src/services/llmProviderAttemptStore.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))
const NS = 'sandbox-recipes'
const RECIPE = 'prompt-notify'
const MODEL = 'grok-4.6'
const CONNECTION_KEY = 'team-grok'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

const REQUEST = {
  schemaVersion: 'grok-completion-request.v1' as const,
  requestId: 'req-sdk-grok-dual',
  idempotencyKey: 'idem-sdk-grok-dual',
  provider: 'grok-subscription' as const,
  model: MODEL,
  messages: [{ role: 'user' as const, content: 'sdk grok dual ledger' }],
}

describeRealPostgres('Plugin Workload SDK Grok dual ledger on real PostgreSQL', () => {
  const database = `sdk_grok_dual_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool
  const previousFlag = config.grokSubscriptionEnabled

  function dbClient() {
    return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
  }

  async function seedSdkAttempt(): Promise<{ invocationId: string; sdkAttemptId: string }> {
    const invocationId = randomUUID()
    await pool.query(
      `INSERT INTO plugin_workload_sdk_invocations (
         id, recipe_namespace, recipe_name, caller_ref, method, detail,
         idempotency_key_hash, status, authorization_decision, contract_version,
         attempt_generation, lease_expires_at
       ) VALUES ($1, $2, $3, 'api', 'promptBridge', 'prompt', $4, 'in_progress',
                 'allow', 2, 1, now() + interval '5 minutes')`,
      [invocationId, NS, RECIPE, randomBytes(32).toString('hex')]
    )
    await pool.query(
      `INSERT INTO plugin_workload_sdk_invocation_attempts (
         invocation_id, recipe_namespace, recipe_name, attempt_generation,
         method, status, lease_expires_at
       ) VALUES ($1, $2, $3, 1, 'promptBridge', 'in_progress',
                 now() + interval '5 minutes')`,
      [invocationId, NS, RECIPE]
    )
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO plugin_workload_sdk_provider_attempts (
         invocation_id, recipe_namespace, recipe_name, attempt_generation,
         attempt_index, target_ref, provider, model, credential_slot, status,
         lease_expires_at
       ) VALUES ($1, $2, $3, 1, 1, 'grok-primary', 'grok-subscription', $4, '',
                 'reserved', now() + interval '5 minutes')
       RETURNING id::text AS id`,
      [invocationId, NS, RECIPE, MODEL]
    )
    return { invocationId, sdkAttemptId: inserted.rows[0]!.id }
  }

  beforeAll(async () => {
    config.grokSubscriptionEnabled = true
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-sdk-grok', accountFingerprint: 'fp-sdk-grok' },
      CONNECTION_KEY
    )
    await recordGrokCatalogOutcome(pool, {
      catalogStatus: 'ready',
      connectionStatus: 'connected',
      expectedCredentialRevision: 1,
      expectedCatalogRevision: 0,
      connectionKey: CONNECTION_KEY,
    })
    await pool.query(
      `INSERT INTO grok_catalog_models
         (connection_id, model, enabled, source, discovered_at, last_seen_at, stale)
       VALUES ($1, $2, true, 'discovery', NOW(), NOW(), false)`,
      [created.id, MODEL]
    )
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

  it('authorizes a recipe Grok attempt bound to a reserved SDK attempt id', async () => {
    const current = await getSafeGrokSubscriptionConnection(pool, CONNECTION_KEY)
    expect(current?.status).toBe('connected')
    const { invocationId, sdkAttemptId } = await seedSdkAttempt()
    const claims: McpHostAccessClaims = {
      sub: `${NS}/${RECIPE}`,
      recipeNamespace: NS,
      recipeName: RECIPE,
      hostRefs: [`${NS}/${RECIPE}`],
      scope: 'workflow:approval:request',
      workflowControlScopes: ['llm:grok:execute'],
      iss: 'control-api',
      aud: 'workflow-approvals',
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 60,
    }
    const authorized = await authorizeLlmProviderAttempt(
      claims,
      {
        request: {
          ...REQUEST,
          requestId: `req-${invocationId}`,
          idempotencyKey: `idem-${invocationId}`,
        },
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: current!.catalogRevision,
        policyHash: computeGrokPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: CONNECTION_KEY,
        }),
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        targetRef: 'grok-primary',
      },
      {
        enabled: true,
        db: dbClient(),
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
        getConnection: async () => current,
        getModelState: async () => ({ enabled: true, stale: false }),
        resolveAssignment: async () => ({
          liveBrokerProviders: ['grok-subscription'],
          liveConnectionRef: CONNECTION_KEY,
        }),
        evaluateBudget: evaluateBudgetCheck,
        getActiveReservation,
        getMaxGeneration: getMaxLlmProviderAttemptGeneration,
        insertAttempt: insertLlmProviderAttempt,
        issueTicket: async () => ({
          executionTicket: 'unused',
          expiresAt: new Date(),
          claims: { jti: randomUUID() },
        }),
      }
    )
    const linked = await loadLlmProviderAttemptBySdkAttemptId(pool, sdkAttemptId)
    expect(linked?.id).toBe(authorized.providerAttemptId)
    expect(linked?.pluginWorkloadSdkProviderAttemptId).toBe(sdkAttemptId)
    expect(linked?.provider).toBe('grok-subscription')
    const promoted = await pool.query<{ status: string; credential_jti: string | null }>(
      `SELECT status, credential_jti
         FROM plugin_workload_sdk_provider_attempts
        WHERE id = $1`,
      [sdkAttemptId]
    )
    expect(promoted.rows[0]).toEqual({ status: 'in_progress', credential_jti: null })
  })
})

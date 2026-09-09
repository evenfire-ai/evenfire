import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { getActiveReservation } from '../src/services/budgets/reservations.js'
import { getCodexCatalogModelState } from '../src/services/codexSubscriptionCatalog.js'
import {
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  recordCodexCatalogOutcome,
} from '../src/services/codexSubscriptionConnection.js'
import {
  LlmProviderAttemptAuthorizeError,
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
  computeCodexPolicyHash,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import {
  type LlmProviderAttemptInsert,
  getMaxLlmProviderAttemptGeneration,
  insertLlmProviderAttempt,
  loadLlmProviderAttemptBySdkAttemptId,
} from '../src/services/llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from '../src/services/llmProviderAttemptTicket.js'
import { prunePluginWorkloadSdkExpiredIdempotencyInTransaction } from '../src/services/pluginWorkloadSdkDb.js'
import { finalizePromptBridgeInTransaction } from '../src/services/pluginWorkloadSdkFinalization.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

const NS = 'sandbox-recipes'
const RECIPE = 'prompt-notify'
const MODEL = 'gpt-5.1'

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
  requestId: 'req-sdk-dual-ledger',
  idempotencyKey: 'idem-sdk-dual-ledger',
  provider: 'codex-subscription' as const,
  model: MODEL,
  messages: [{ role: 'user' as const, content: 'sdk dual ledger' }],
}

function recipeClaims(): McpHostAccessClaims {
  return {
    sub: `${NS}/${RECIPE}`,
    recipeNamespace: NS,
    recipeName: RECIPE,
    hostRefs: [`${NS}/${RECIPE}`],
    scope: 'workflow:approval:request',
    workflowControlScopes: ['llm:codex:execute'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 60,
  }
}

function hostClaims(): McpHostAccessClaims {
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

function attemptInput(overrides: Partial<LlmProviderAttemptInsert> = {}): LlmProviderAttemptInsert {
  return {
    callerKind: 'recipe',
    hostRef: `${NS}/${RECIPE}`,
    recipeNamespace: NS,
    recipeName: RECIPE,
    invocationId: `invocation-${randomUUID()}`,
    attemptGeneration: 1,
    providerAttemptIndex: 1,
    model: MODEL,
    requestHash: 'c'.repeat(64),
    policyRevision: 1,
    policyHash: 'd'.repeat(64),
    budgetReservationId: 'reservation-1',
    connectionRevision: 1,
    ...overrides,
  }
}

describeRealPostgres('Plugin Workload SDK Codex dual ledger on real PostgreSQL', () => {
  const database = `sdk_codex_dual_${randomBytes(6).toString('hex')}`
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
      resolveConnectionKey: async () => 'deployment-default',
      evaluateBudget: evaluateBudgetCheck,
      getActiveReservation,
      getMaxGeneration: getMaxLlmProviderAttemptGeneration,
      insertAttempt: insertLlmProviderAttempt,
      issueTicket: issueRegisteredCodexExecutionTicket,
      ...overrides,
    }
  }

  async function seedSdkAttempt(
    input: {
      invocationId?: string
      status?: string
      provider?: string
      model?: string
      credentialSlot?: string
      targetRef?: string
    } = {}
  ): Promise<{ invocationId: string; sdkAttemptId: string }> {
    const invocationId = input.invocationId ?? randomUUID()
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
       ) VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7, $8, now() + interval '5 minutes')
       RETURNING id::text AS id`,
      [
        invocationId,
        NS,
        RECIPE,
        input.targetRef ?? 'codex-primary',
        input.provider ?? 'codex-subscription',
        input.model ?? MODEL,
        input.credentialSlot ?? '',
        input.status ?? 'reserved',
      ]
    )
    return { invocationId, sdkAttemptId: inserted.rows[0]!.id }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    const created = await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'refresh-sdk-dual',
      accountFingerprint: 'fp-sdk-dual',
    })
    await recordCodexCatalogOutcome(pool, {
      catalogStatus: 'ready',
      expectedCredentialRevision: 1,
      expectedCatalogRevision: 0,
    })
    await pool.query(
      `INSERT INTO codex_catalog_models
         (connection_id, model, enabled, source, discovered_at, last_seen_at, stale)
       VALUES ($1, $2, true, 'discovery', NOW(), NOW(), false)`,
      [created.id, MODEL]
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

  it('adds a unique nullable FK from Codex attempts onto reserved SDK attempts', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'llm_provider_attempts'
          AND column_name = 'plugin_workload_sdk_provider_attempt_id'`
    )
    expect(columns.rows).toHaveLength(1)

    const { sdkAttemptId } = await seedSdkAttempt()
    const first = await insertLlmProviderAttempt(
      pool,
      attemptInput({ pluginWorkloadSdkProviderAttemptId: sdkAttemptId })
    )
    expect(first.pluginWorkloadSdkProviderAttemptId).toBe(sdkAttemptId)
    await expect(
      insertLlmProviderAttempt(
        pool,
        attemptInput({
          invocationId: `invocation-${randomUUID()}`,
          providerAttemptIndex: 2,
          pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        })
      )
    ).rejects.toThrow(/duplicate|unique/i)

    const host = await insertLlmProviderAttempt(
      pool,
      attemptInput({
        callerKind: 'host',
        hostRef: 'research-host',
        recipeNamespace: null,
        recipeName: null,
        invocationId: `host-${randomUUID()}`,
      })
    )
    expect(host.pluginWorkloadSdkProviderAttemptId ?? null).toBeNull()
  })

  it('authorizes a recipe Codex attempt bound to a reserved SDK attempt id', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    expect(current?.status).toBe('connected')
    const { invocationId, sdkAttemptId } = await seedSdkAttempt()
    const authorized = await authorizeLlmProviderAttempt(
      recipeClaims(),
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
        policyHash: computeCodexPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
      },
      testDeps()
    )
    const linked = await loadLlmProviderAttemptBySdkAttemptId(pool, sdkAttemptId)
    expect(linked?.id).toBe(authorized.providerAttemptId)
    expect(linked?.pluginWorkloadSdkProviderAttemptId).toBe(sdkAttemptId)
    expect(linked?.invocationId).toBe(invocationId)
    const promoted = await pool.query<{ status: string; credential_jti: string | null }>(
      `SELECT status, credential_jti
         FROM plugin_workload_sdk_provider_attempts
        WHERE id = $1`,
      [sdkAttemptId]
    )
    expect(promoted.rows[0]).toEqual({ status: 'in_progress', credential_jti: null })
    expect(JSON.stringify(authorized)).not.toContain('refresh-sdk-dual')
  })

  it('authorizes a host Codex attempt without an SDK FK', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    const invocationId = `host-invocation-${randomUUID()}`
    const authorized = await authorizeLlmProviderAttempt(
      hostClaims(),
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
        policyHash: computeCodexPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
      },
      testDeps()
    )
    const stored = await pool.query<{ plugin_workload_sdk_provider_attempt_id: string | null }>(
      `SELECT plugin_workload_sdk_provider_attempt_id
         FROM llm_provider_attempts
        WHERE id = $1`,
      [authorized.providerAttemptId]
    )
    expect(stored.rows[0]?.plugin_workload_sdk_provider_attempt_id).toBeNull()
  })

  it('rejects Codex complete while the reserved SDK attempt has not been authorized', async () => {
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    await expect(
      finalizePromptBridgeInTransaction(
        {
          invocationId,
          recipeNamespace: NS,
          recipeName: RECIPE,
          hostRef: `${NS}/${RECIPE}`,
          attemptGeneration: 1,
          providerAttemptId: sdkAttemptId,
          providerAttemptIndex: 1,
          status: 'complete',
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: MODEL,
            credentialSlot: '',
          },
          reason: 'provider_completed',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        pool
      )
    ).rejects.toMatchObject({
      name: 'PromptBridgeFinalizationError',
      code: 'conflict',
      httpStatus: 409,
    })
  })

  it('refuses Codex complete while the linked attempt is still in flight', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    await authorizeLlmProviderAttempt(
      recipeClaims(),
      {
        request: {
          ...REQUEST,
          requestId: `req-pending-${invocationId}`,
          idempotencyKey: `idem-pending-${invocationId}`,
        },
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: current!.catalogRevision,
        policyHash: computeCodexPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        targetRef: 'codex-primary',
      },
      testDeps()
    )
    const linked = await loadLlmProviderAttemptBySdkAttemptId(pool, sdkAttemptId)
    expect(linked?.status).toBe('authorized')
    expect(linked?.usageInputTokens ?? null).toBeNull()

    await expect(
      finalizePromptBridgeInTransaction(
        {
          invocationId,
          recipeNamespace: NS,
          recipeName: RECIPE,
          hostRef: `${NS}/${RECIPE}`,
          attemptGeneration: 1,
          providerAttemptId: sdkAttemptId,
          providerAttemptIndex: 1,
          status: 'complete',
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: MODEL,
            credentialSlot: '',
          },
          reason: 'provider_completed',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        pool
      )
    ).rejects.toMatchObject({
      name: 'PromptBridgeFinalizationError',
      code: 'ledger_pending',
      httpStatus: 409,
      retryable: true,
    })
    const spend = await pool.query(
      `SELECT provider_attempt_id
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [sdkAttemptId]
    )
    expect(spend.rows).toHaveLength(0)
  })

  it('finalizes complete plus linked Codex success as exact using Codex usage', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    const authorized = await authorizeLlmProviderAttempt(
      recipeClaims(),
      {
        request: {
          ...REQUEST,
          requestId: `req-exact-${invocationId}`,
          idempotencyKey: `idem-exact-${invocationId}`,
        },
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: current!.catalogRevision,
        policyHash: computeCodexPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        targetRef: 'codex-primary',
      },
      testDeps()
    )
    await pool.query(
      `UPDATE llm_provider_attempts
          SET status = 'finalized',
              outcome = 'success',
              usage_input_tokens = 12,
              usage_output_tokens = 7,
              finalized_at = now()
        WHERE id = $1`,
      [authorized.providerAttemptId]
    )

    const result = await finalizePromptBridgeInTransaction(
      {
        invocationId,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRef: `${NS}/${RECIPE}`,
        attemptGeneration: 1,
        providerAttemptId: sdkAttemptId,
        providerAttemptIndex: 1,
        status: 'complete',
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: MODEL,
          credentialSlot: '',
        },
        reason: 'provider_completed',
        usage: {
          llmSecretName: '',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      pool
    )
    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'exact',
      usageAccepted: false,
    })
    const spend = await pool.query<{
      outcome: string
      input_tokens: number
      output_tokens: number
      credential_slot: string
    }>(
      `SELECT outcome, input_tokens, output_tokens, credential_slot
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [sdkAttemptId]
    )
    expect(spend.rows[0]).toEqual({
      outcome: 'exact',
      input_tokens: 12,
      output_tokens: 7,
      credential_slot: '',
    })

    // Addendum A.4.3: the host is not the source of truth for oauth-broker
    // spend, so a later `failed` report cannot contradict an exact floor that
    // Codex itself proved. It used to 409, which made the host's retry of a
    // lost response look like an accounting conflict.
    await expect(
      finalizePromptBridgeInTransaction(
        {
          invocationId,
          recipeNamespace: NS,
          recipeName: RECIPE,
          hostRef: `${NS}/${RECIPE}`,
          attemptGeneration: 1,
          providerAttemptId: sdkAttemptId,
          providerAttemptIndex: 1,
          status: 'failed',
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: MODEL,
            credentialSlot: '',
          },
          reason: 'provider_stream_failed',
        },
        pool
      )
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: 'exact',
      idempotent: true,
      usageAccepted: false,
    })
    const unchanged = await pool.query(
      `SELECT outcome, input_tokens, output_tokens, reason
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [sdkAttemptId]
    )
    expect(unchanged.rows[0]).toEqual({
      outcome: 'exact',
      input_tokens: 12,
      output_tokens: 7,
      reason: 'provider_completed',
    })
  })

  it('finalizes a pre-dispatch Codex miss as not_executed', async () => {
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    const result = await finalizePromptBridgeInTransaction(
      {
        invocationId,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRef: `${NS}/${RECIPE}`,
        attemptGeneration: 1,
        providerAttemptId: sdkAttemptId,
        providerAttemptIndex: 1,
        status: 'failed',
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: MODEL,
          credentialSlot: '',
        },
        reason: 'codex_execution_binding_missing',
      },
      pool
    )
    expect(result).toMatchObject({
      status: 'failed',
      outcome: 'not_executed',
      usageAccepted: false,
    })
    const spend = await pool.query<{
      outcome: string
      input_tokens: number | null
      output_tokens: number | null
    }>(
      `SELECT outcome, input_tokens, output_tokens
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [sdkAttemptId]
    )
    expect(spend.rows[0]).toEqual({
      outcome: 'not_executed',
      input_tokens: null,
      output_tokens: null,
    })
    expect(await loadLlmProviderAttemptBySdkAttemptId(pool, sdkAttemptId)).toBeNull()
  })

  it('finalizes complete without a linked Codex success as unknown', async () => {
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'in_progress' })
    const result = await finalizePromptBridgeInTransaction(
      {
        invocationId,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRef: `${NS}/${RECIPE}`,
        attemptGeneration: 1,
        providerAttemptId: sdkAttemptId,
        providerAttemptIndex: 1,
        status: 'complete',
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: MODEL,
          credentialSlot: '',
        },
        reason: 'provider_completed',
        usage: {
          llmSecretName: '',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 4,
          outputTokens: 2,
        },
      },
      pool
    )
    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'unknown',
      usageAccepted: false,
    })
    const spend = await pool.query<{
      outcome: string
      input_tokens: number | null
      output_tokens: number | null
    }>(
      `SELECT outcome, input_tokens, output_tokens
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [sdkAttemptId]
    )
    expect(spend.rows[0]).toEqual({
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: null,
    })

    await expect(
      finalizePromptBridgeInTransaction(
        {
          invocationId,
          recipeNamespace: NS,
          recipeName: RECIPE,
          hostRef: `${NS}/${RECIPE}`,
          attemptGeneration: 1,
          providerAttemptId: sdkAttemptId,
          providerAttemptIndex: 1,
          status: 'complete',
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: MODEL,
            credentialSlot: '',
          },
          reason: 'provider_completed',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        pool
      )
    ).resolves.toMatchObject({ idempotent: true, outcome: 'unknown', usageAccepted: false })
  })

  it('refuses authorize-link after finalize failed already wrote spend', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    await finalizePromptBridgeInTransaction(
      {
        invocationId,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRef: `${NS}/${RECIPE}`,
        attemptGeneration: 1,
        providerAttemptId: sdkAttemptId,
        providerAttemptIndex: 1,
        status: 'failed',
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: MODEL,
          credentialSlot: '',
        },
        reason: 'codex_execution_binding_missing',
      },
      pool
    )
    await expect(
      authorizeLlmProviderAttempt(
        recipeClaims(),
        {
          request: {
            ...REQUEST,
            requestId: `req-race-${invocationId}`,
            idempotencyKey: `idem-race-${invocationId}`,
          },
          invocationId,
          attemptGeneration: 1,
          providerAttemptIndex: 1,
          policyRevision: current!.catalogRevision,
          policyHash: computeCodexPolicyHash({
            model: MODEL,
            catalogRevision: current!.catalogRevision,
            credentialRevision: current!.credentialRevision,
            connectionKey: current!.connectionKey,
          }),
          pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
          targetRef: 'codex-primary',
        },
        testDeps()
      )
    ).rejects.toBeInstanceOf(LlmProviderAttemptAuthorizeError)
    expect(await loadLlmProviderAttemptBySdkAttemptId(pool, sdkAttemptId)).toBeNull()
  })

  it('prunes a linked terminal SDK attempt without deleting the Codex ledger row', async () => {
    const { invocationId, sdkAttemptId } = await seedSdkAttempt({ status: 'reserved' })
    const current = await getSafeCodexSubscriptionConnection(pool)
    const authorized = await authorizeLlmProviderAttempt(
      recipeClaims(),
      {
        request: {
          ...REQUEST,
          requestId: `req-prune-${invocationId}`,
          idempotencyKey: `idem-prune-${invocationId}`,
        },
        invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: current!.catalogRevision,
        policyHash: computeCodexPolicyHash({
          model: MODEL,
          catalogRevision: current!.catalogRevision,
          credentialRevision: current!.credentialRevision,
          connectionKey: current!.connectionKey,
        }),
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        targetRef: 'codex-primary',
      },
      testDeps()
    )
    await pool.query(
      `UPDATE plugin_workload_sdk_invocations
          SET status = 'complete', created_at = now() - interval '25 hours'
        WHERE id = $1`,
      [invocationId]
    )
    const deleteRule = await pool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON rc.constraint_name = kcu.constraint_name
        WHERE kcu.table_name = 'llm_provider_attempts'
          AND kcu.column_name = 'plugin_workload_sdk_provider_attempt_id'`
    )
    expect(deleteRule.rows[0]?.delete_rule).toBe('SET NULL')
    const pruned = await prunePluginWorkloadSdkExpiredIdempotencyInTransaction(pool)
    expect(pruned).toBeGreaterThan(0)
    const leftoverSdk = await pool.query(
      `SELECT id FROM plugin_workload_sdk_provider_attempts WHERE id = $1`,
      [sdkAttemptId]
    )
    expect(leftoverSdk.rows).toHaveLength(0)
    const ledger = await pool.query<{
      id: string
      plugin_workload_sdk_provider_attempt_id: string | null
    }>(
      `SELECT id, plugin_workload_sdk_provider_attempt_id
         FROM llm_provider_attempts
        WHERE id = $1`,
      [authorized.providerAttemptId]
    )
    expect(ledger.rows[0]).toEqual({
      id: authorized.providerAttemptId,
      plugin_workload_sdk_provider_attempt_id: null,
    })
  })
})

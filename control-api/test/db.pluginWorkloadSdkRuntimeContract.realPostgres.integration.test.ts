import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import {
  type PromptBridgeFinalizationInput,
  finalizePromptBridgeInTransaction,
} from '../src/services/pluginWorkloadSdkFinalization.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN')
}

async function commit(client: PoolClient): Promise<void> {
  await client.query('COMMIT')
}

describeRealPostgres('Plugin Workload SDK runtime-contract upgrade on real PostgreSQL', () => {
  const database = `control_api_sdk_contract_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let dbPool: Pool

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
  })

  afterAll(async () => {
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      await adminPool.end()
    }
  })

  async function seedAttempt(
    client: PoolClient,
    options: { contractVersion: 1 | 2; lease: boolean; status?: 'in_progress' | 'failed' } = {
      contractVersion: 2,
      lease: true,
    }
  ): Promise<PromptBridgeFinalizationInput> {
    const invocationId = randomUUID()
    const providerAttemptId = randomUUID()
    const recipeNamespace = 'sandbox-recipes'
    const recipeName = `runtime-contract-${invocationId}`
    const target = {
      targetRef: 'primary-openai',
      provider: 'openai',
      model: 'gpt-4o-mini',
      credentialSlot: 'openai-api-key',
    }
    const leaseSql = options.lease ? "now() + interval '5 minutes'" : 'NULL'
    const status = options.status ?? 'in_progress'
    await client.query(
      `INSERT INTO plugin_workload_sdk_invocations
         (id, recipe_namespace, recipe_name, caller_ref, method, detail,
          idempotency_key_hash, payload_hash, status, authorization_decision,
          contract_version, attempt_generation, lease_expires_at)
       VALUES ($1, $2, $3, 'integration-test', 'promptBridge', '{}',
               $4, $5, $6, 'authorized', $7, 1, ${leaseSql})`,
      [
        invocationId,
        recipeNamespace,
        recipeName,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        status,
        options.contractVersion,
      ]
    )
    await client.query(
      `INSERT INTO plugin_workload_sdk_invocation_attempts
         (invocation_id, recipe_namespace, recipe_name, attempt_generation,
          method, target_refs, status, lease_expires_at)
       VALUES ($1, $2, $3, 1, 'promptBridge', $4::jsonb, $5, ${leaseSql})`,
      [invocationId, recipeNamespace, recipeName, JSON.stringify([target.targetRef]), status]
    )
    await client.query(
      `INSERT INTO plugin_workload_sdk_provider_attempts
         (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
          attempt_index, target_ref, provider, model, credential_slot, status,
          lease_expires_at)
       VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, 'in_progress',
               now() + interval '5 minutes')`,
      [
        providerAttemptId,
        invocationId,
        recipeNamespace,
        recipeName,
        target.targetRef,
        target.provider,
        target.model,
        target.credentialSlot,
      ]
    )
    return {
      invocationId,
      recipeNamespace,
      recipeName,
      hostRef: 'mcp-host/integration',
      attemptGeneration: 1,
      providerAttemptId,
      providerAttemptIndex: 1,
      status: 'complete',
      target,
      reason: 'integration_complete',
      usage: {
        llmSecretName: 'openai-api-key',
        callerRef: 'integration-test',
        fallbackUsed: false,
        attemptCount: 1,
        inputTokens: 23,
        outputTokens: 11,
      },
    }
  }

  async function restoreHistoricalRuntimeState(): Promise<void> {
    await dbPool.query(`
      CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata(event_kind TEXT, value JSONB)
      RETURNS BOOLEAN
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT event_kind <> 'token_usage'
          OR (
            jsonb_typeof(value) = 'object'
            AND value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown')
            AND NOT (value ? 'prompt_bridge')
          );
      $$;
      ALTER FUNCTION governed_trace_safe_metadata(JSONB) RESET search_path;
      ALTER FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB) RESET search_path;
      REVOKE ALL ON FUNCTION governed_trace_safe_metadata(JSONB)
        FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
      REVOKE ALL ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
        FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
      GRANT EXECUTE ON FUNCTION governed_trace_safe_metadata(JSONB)
        TO control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
      GRANT EXECUTE ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
        TO control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
      ALTER TABLE agent_run_events
        DROP CONSTRAINT IF EXISTS agent_run_events_check;
      ALTER TABLE agent_run_events
        DROP CONSTRAINT IF EXISTS agent_run_events_payload_metadata_check;
      ALTER TABLE agent_run_events
        ADD CONSTRAINT agent_run_events_check
        CHECK (governed_trace_safe_agent_run_metadata(event_type, payload_metadata));
      ALTER TABLE plugin_workload_sdk_invocations
        ALTER COLUMN contract_version SET DEFAULT 2;
      ALTER TABLE plugin_workload_sdk_invocations
        DROP CONSTRAINT IF EXISTS plugin_workload_sdk_invocations_v2_lease_check;
      ALTER TABLE plugin_workload_sdk_provider_attempts
        DROP CONSTRAINT IF EXISTS plugin_workload_sdk_provider_attempts_status_check;
      ALTER TABLE plugin_workload_sdk_provider_attempts
        ADD CONSTRAINT plugin_workload_sdk_provider_attempts_status_check
       CHECK (status IN ('reserved','in_progress','complete','failed','provider_unavailable'));
      DELETE FROM schema_migrations
       WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation';
    `)
  }

  async function seedTraceEvent(
    payloadMetadata: Record<string, unknown>,
    prefix: string
  ): Promise<string> {
    const eventId = randomUUID()
    const client = await dbPool.connect()
    try {
      await begin(client)
      const payloadSha256 = randomBytes(32).toString('hex')
      const occurredAt = new Date()
      await client.query(
        `INSERT INTO agent_run_events
           (event_id, source_kind, source_service, source_event_id, idempotency_key,
            run_id, span_id, origin, event_type, outcome, agent_sub, payload_metadata,
            payload_sha256, occurred_at)
         VALUES ($1, 'control_api_local', 'control-api', $2, $3, $4, 'span-1',
                 'api', 'token_usage', 'succeeded', 'integration-test', $5::jsonb, $6, $7)`,
        [
          eventId,
          `${prefix}-${eventId}`,
          randomBytes(32).toString('hex'),
          randomUUID(),
          JSON.stringify(payloadMetadata),
          payloadSha256,
          occurredAt,
        ]
      )
      await client.query(
        `INSERT INTO governed_event_stream
           (event_family, event_id, schema_version, occurred_at, ingested_at, payload_sha256)
         VALUES ('agent_run', $1, 1, $2, $3, $4)`,
        [eventId, occurredAt, new Date(), payloadSha256]
      )
      await commit(client)
      return eventId
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original assertion error.
      }
      throw error
    } finally {
      client.release()
    }
  }

  function validPayload(invocationId = randomUUID(), providerAttemptId = randomUUID()) {
    return {
      request_ref: 'a'.repeat(64),
      provider: 'openai',
      model: 'gpt-4o-mini',
      source_kind: 'plugin_workload_sdk',
      input_tokens: 23,
      output_tokens: 11,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_tokens_reported: false,
      prompt_bridge: {
        invocation_id: invocationId,
        attempt_generation: 1,
        target_ref: 'primary-openai',
        fallback_used: false,
        attempt_count: 1,
        provider_attempt_id: providerAttemptId,
        provider_attempt_index: 1,
      },
    }
  }

  it('repairs the historical runtime contracts, finalizes usage, and is idempotent', async () => {
    await restoreHistoricalRuntimeState()

    const historicalState = await dbPool.query<{
      validator_config: string[] | null
      metadata_config: string[] | null
      trace_validator: boolean
      workflow_validator: boolean
      workflow_metadata: boolean
    }>(
      `SELECT
          validator.proconfig AS validator_config,
          metadata.proconfig AS metadata_config,
          has_function_privilege('trace_maintenance_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS trace_validator,
          has_function_privilege('workflow_recipes_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS workflow_validator,
          has_function_privilege('workflow_recipes_runtime', 'public.governed_trace_safe_metadata(jsonb)', 'EXECUTE') AS workflow_metadata
       FROM pg_proc validator
       JOIN pg_proc metadata
         ON metadata.proname = 'governed_trace_safe_metadata'
        AND metadata.proargtypes::text = '3802'
      WHERE validator.proname = 'governed_trace_safe_agent_run_metadata'
        AND validator.proargtypes::text = '25 3802'`
    )
    expect(historicalState.rows[0]).toMatchObject({
      validator_config: null,
      metadata_config: null,
      trace_validator: true,
      workflow_validator: true,
      workflow_metadata: true,
    })

    const historicalInvalidEventId = await seedTraceEvent(
      {
        source_kind: 'unknown',
        input_tokens: 1,
        output_tokens: 1,
      },
      'historical'
    )

    const historicalClient = await dbPool.connect()
    let redInput: PromptBridgeFinalizationInput
    try {
      await begin(historicalClient)
      redInput = await seedAttempt(historicalClient, { contractVersion: 2, lease: true })
      await expect(finalizePromptBridgeInTransaction(redInput, historicalClient)).rejects.toThrow(
        /agent_run_events_check/
      )
      await historicalClient.query('ROLLBACK')
    } finally {
      historicalClient.release()
    }

    const rejected = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [JSON.stringify(validPayload(redInput!.invocationId, redInput!.providerAttemptId))]
    )
    expect(rejected.rows[0]?.accepted).toBe(false)

    await expect(initDb({ connect: () => dbPool.connect() })).rejects.toThrow(
      /cannot reconcile .* historical agent_run_events rows with invalid payload metadata/
    )
    const failedMigrationState = await dbPool.query<{ migration_count: string; row_count: string }>(
      `SELECT
          (SELECT COUNT(*)::text FROM schema_migrations
            WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation') AS migration_count,
          (SELECT COUNT(*)::text FROM agent_run_events WHERE event_id = $1) AS row_count`,
      [historicalInvalidEventId]
    )
    expect(failedMigrationState.rows[0]).toEqual({ migration_count: '0', row_count: '1' })
    const historicalCleanupClient = await dbPool.connect()
    try {
      await begin(historicalCleanupClient)
      await historicalCleanupClient.query('DELETE FROM agent_run_events WHERE event_id = $1', [
        historicalInvalidEventId,
      ])
      await historicalCleanupClient.query('DELETE FROM governed_event_stream WHERE event_id = $1', [
        historicalInvalidEventId,
      ])
      await commit(historicalCleanupClient)
    } finally {
      historicalCleanupClient.release()
    }

    const skippedAttempt = {
      id: randomUUID(),
      invocationId: randomUUID(),
    }
    await expect(
      dbPool.query(
        `INSERT INTO plugin_workload_sdk_provider_attempts
           (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
            attempt_index, target_ref, provider, model, credential_slot, status)
         VALUES ($1, $2, 'sandbox-recipes', 'historical-skip', 1, 1,
                 'primary-openai', 'openai', 'gpt-4o-mini', 'openai-api-key', 'skipped')`,
        [skippedAttempt.id, skippedAttempt.invocationId]
      )
    ).rejects.toThrow(/plugin_workload_sdk_provider_attempts_status_check/)

    const ambiguousInvocationId = randomUUID()
    const ambiguousProviderAttemptId = randomUUID()
    const ambiguousClient = await dbPool.connect()
    try {
      await ambiguousClient.query(
        `INSERT INTO plugin_workload_sdk_invocations
           (id, recipe_namespace, recipe_name, caller_ref, method, detail,
            idempotency_key_hash, payload_hash, status, authorization_decision,
            contract_version, attempt_generation, lease_expires_at)
         VALUES ($1, 'sandbox-recipes', 'ambiguous-v2-no-lease', 'integration-test',
                 'promptBridge', '{}', $2, $3, 'in_progress', 'authorized', 2, 1, NULL)`,
        [ambiguousInvocationId, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      )
      await ambiguousClient.query(
        `INSERT INTO plugin_workload_sdk_invocation_attempts
           (invocation_id, recipe_namespace, recipe_name, attempt_generation,
            method, target_refs, status, lease_expires_at)
         VALUES ($1, 'sandbox-recipes', 'ambiguous-v2-no-lease', 1,
                 'promptBridge', '["primary-openai"]'::jsonb, 'in_progress', NULL)`,
        [ambiguousInvocationId]
      )
      await ambiguousClient.query(
        `INSERT INTO plugin_workload_sdk_provider_attempts
           (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
            attempt_index, target_ref, provider, model, credential_slot, status,
            lease_expires_at)
         VALUES ($1, $2, 'sandbox-recipes', 'ambiguous-v2-no-lease', 1, 1,
                 'primary-openai', 'openai', 'gpt-4o-mini', 'openai-api-key',
                 'in_progress', now() + interval '5 minutes')`,
        [ambiguousProviderAttemptId, ambiguousInvocationId]
      )
    } finally {
      ambiguousClient.release()
    }

    await expect(initDb({ connect: () => dbPool.connect() })).rejects.toThrow(
      /cannot reconcile .* v2 invocations without leases with a physical provider attempt/
    )
    const ambiguousState = await dbPool.query<{
      contract_version: number
      status: string
      lease_expires_at: Date | null
    }>(
      `SELECT contract_version, status, lease_expires_at
         FROM plugin_workload_sdk_invocations
        WHERE id = $1`,
      [ambiguousInvocationId]
    )
    expect(ambiguousState.rows[0]).toMatchObject({
      contract_version: 2,
      status: 'in_progress',
      lease_expires_at: null,
    })
    await dbPool.query('DELETE FROM plugin_workload_sdk_provider_attempts WHERE id = $1', [
      ambiguousProviderAttemptId,
    ])
    await dbPool.query(
      'DELETE FROM plugin_workload_sdk_invocation_attempts WHERE invocation_id = $1',
      [ambiguousInvocationId]
    )
    await dbPool.query('DELETE FROM plugin_workload_sdk_invocations WHERE id = $1', [
      ambiguousInvocationId,
    ])

    const legacyClient = await dbPool.connect()
    const legacyInvocationId = randomUUID()
    const legacyProviderAttemptId = randomUUID()
    try {
      await legacyClient.query(
        `INSERT INTO plugin_workload_sdk_invocations
           (id, recipe_namespace, recipe_name, caller_ref, method, detail,
            idempotency_key_hash, payload_hash, status, authorization_decision,
            contract_version, attempt_generation, lease_expires_at)
         VALUES ($1, 'sandbox-recipes', 'legacy-v2-no-lease', 'integration-test',
                 'promptBridge', '{}', $2, $3, 'in_progress', 'authorized', 2, 1, NULL)`,
        [legacyInvocationId, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      )
      await legacyClient.query(
        `INSERT INTO plugin_workload_sdk_invocation_attempts
           (invocation_id, recipe_namespace, recipe_name, attempt_generation,
            method, target_refs, status, lease_expires_at)
         VALUES ($1, 'sandbox-recipes', 'legacy-v2-no-lease', 1,
                 'promptBridge', '["primary-openai"]'::jsonb, 'in_progress', NULL)`,
        [legacyInvocationId]
      )
      await legacyClient.query(
        `INSERT INTO plugin_workload_sdk_provider_attempts
           (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
            attempt_index, target_ref, provider, model, credential_slot, status)
         VALUES ($1, $2, 'sandbox-recipes', 'legacy-v2-no-lease', 1, 1,
                 'primary-openai', 'openai', 'gpt-4o-mini', 'openai-api-key', 'reserved')`,
        [legacyProviderAttemptId, legacyInvocationId]
      )
    } finally {
      legacyClient.release()
    }

    await initDb({ connect: () => dbPool.connect() })

    const repaired = await dbPool.query<{
      contract_version: number
      status: string
      authorization_decision: string
    }>(
      `SELECT contract_version, status, authorization_decision
         FROM plugin_workload_sdk_invocations
        WHERE id = $1`,
      [legacyInvocationId]
    )
    expect(repaired.rows[0]).toEqual({
      contract_version: 1,
      status: 'failed',
      authorization_decision: 'migration_interrupted',
    })
    const repairedProviderAttempt = await dbPool.query<{
      status: string
      completed_at: Date | null
    }>(
      `SELECT status, completed_at
         FROM plugin_workload_sdk_provider_attempts
        WHERE id = $1`,
      [legacyProviderAttemptId]
    )
    expect(repairedProviderAttempt.rows[0]?.status).toBe('failed')
    expect(repairedProviderAttempt.rows[0]?.completed_at).not.toBeNull()

    const accepted = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [JSON.stringify(validPayload())]
    )
    const rejectedTopLevel = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [JSON.stringify({ ...validPayload(), unexpected: true })]
    )
    const rejectedNested = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify({
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, unexpected: true },
        }),
      ]
    )
    const rejectedUuid = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify({
          ...validPayload(),
          prompt_bridge: {
            ...validPayload().prompt_bridge,
            invocation_id: 'a'.repeat(36),
          },
        }),
      ]
    )
    const rejectedCount = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify({
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, attempt_count: 5 },
        }),
      ]
    )
    const rejectedNullUuid = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify({
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, invocation_id: null },
        }),
      ]
    )
    const rejectedNumericString = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify({
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, attempt_generation: '1' },
        }),
      ]
    )
    const rejectedMissingRequired = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [
        JSON.stringify(
          Object.fromEntries(
            Object.entries(validPayload()).filter(([key]) => key !== 'cache_tokens_reported')
          )
        ),
      ]
    )
    expect(accepted.rows[0]?.accepted).toBe(true)
    expect(rejectedTopLevel.rows[0]?.accepted).toBe(false)
    expect(rejectedNested.rows[0]?.accepted).toBe(false)
    expect(rejectedUuid.rows[0]?.accepted).toBe(false)
    expect(rejectedCount.rows[0]?.accepted).toBe(false)
    expect(rejectedNullUuid.rows[0]?.accepted).toBe(false)
    expect(rejectedNumericString.rows[0]?.accepted).toBe(false)
    expect(rejectedMissingRequired.rows[0]?.accepted).toBe(false)

    await expect(
      seedTraceEvent(
        {
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, invocation_id: null },
        },
        'runtime'
      )
    ).rejects.toThrow(/agent_run_events_check/)
    await expect(
      seedTraceEvent(
        {
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, attempt_generation: '1' },
        },
        'runtime'
      )
    ).rejects.toThrow(/agent_run_events_check/)

    const repairedSkippedId = randomUUID()
    await dbPool.query(
      `INSERT INTO plugin_workload_sdk_provider_attempts
         (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
          attempt_index, target_ref, provider, model, credential_slot, status)
       VALUES ($1, $2, 'sandbox-recipes', 'repaired-skip', 1, 1,
               'primary-openai', 'openai', 'gpt-4o-mini', 'openai-api-key', 'skipped')`,
      [repairedSkippedId, randomUUID()]
    )

    const invalidLeaseInvocationId = randomUUID()
    await expect(
      dbPool.query(
        `INSERT INTO plugin_workload_sdk_invocations
           (id, recipe_namespace, recipe_name, caller_ref, method, detail,
            idempotency_key_hash, payload_hash, status, authorization_decision,
            contract_version, attempt_generation, lease_expires_at)
         VALUES ($1, 'sandbox-recipes', 'invalid-v2-lease', 'integration-test',
                 'promptBridge', '{}', $2, $3, 'in_progress', 'authorized', 2, 1, NULL)`,
        [invalidLeaseInvocationId, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      )
    ).rejects.toThrow(/plugin_workload_sdk_invocations_v2_lease_check/)

    const exactClient = await dbPool.connect()
    let exactInput: PromptBridgeFinalizationInput
    try {
      await begin(exactClient)
      exactInput = await seedAttempt(exactClient, { contractVersion: 2, lease: true })
      const result = await finalizePromptBridgeInTransaction(exactInput, exactClient)
      await commit(exactClient)
      expect(result).toMatchObject({
        status: 'complete',
        outcome: 'exact',
        usageAccepted: true,
        idempotent: false,
      })
    } finally {
      exactClient.release()
    }

    const counts = await dbPool.query(
      `SELECT
          (SELECT COUNT(*) FROM usage_events WHERE request_id = $1::uuid)::int AS usage_count,
          (SELECT COUNT(*) FROM agent_run_events WHERE source_event_id = $1::text)::int AS trace_count,
          (SELECT COUNT(*) FROM governed_event_stream stream
             JOIN agent_run_events event ON event.event_id = stream.event_id
            WHERE event.source_event_id = $1::text)::int AS stream_count,
          (SELECT COUNT(*) FROM plugin_workload_sdk_spend_outcomes
            WHERE provider_attempt_id = $1::uuid)::int AS spend_count`,
      [exactInput!.providerAttemptId]
    )
    expect(counts.rows[0]).toEqual({
      usage_count: 1,
      trace_count: 1,
      stream_count: 1,
      spend_count: 1,
    })

    const contractState = await dbPool.query<{
      default_value: string | null
      lease_check: string
      attempt_check: string
      trace_check: string
    }>(
      `SELECT
          (SELECT column_default
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'plugin_workload_sdk_invocations'
              AND column_name = 'contract_version') AS default_value,
          (SELECT pg_get_constraintdef(oid)
           FROM pg_constraint
            WHERE conname = 'plugin_workload_sdk_invocations_v2_lease_check') AS lease_check,
          (SELECT pg_get_constraintdef(oid)
             FROM pg_constraint
            WHERE conname = 'plugin_workload_sdk_provider_attempts_status_check') AS attempt_check,
          (SELECT pg_get_constraintdef(oid)
             FROM pg_constraint
            WHERE conname = 'agent_run_events_check') AS trace_check`
    )
    expect(contractState.rows[0]?.default_value).toBe('1')
    expect(contractState.rows[0]?.lease_check).toContain('lease_expires_at IS NOT NULL')
    expect(contractState.rows[0]?.attempt_check).toContain("'skipped'")
    expect(contractState.rows[0]?.trace_check).toContain('IS TRUE')

    const functionState = await dbPool.query<{
      validator_config: string[] | null
      metadata_config: string[] | null
      control_validator: boolean
      trace_validator: boolean
      workflow_validator: boolean
      control_metadata: boolean
      trace_metadata: boolean
      workflow_metadata: boolean
    }>(
      `SELECT
          validator.proconfig AS validator_config,
          metadata.proconfig AS metadata_config,
          has_function_privilege('control_api_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS control_validator,
          has_function_privilege('trace_maintenance_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS trace_validator,
          has_function_privilege('workflow_recipes_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS workflow_validator,
          has_function_privilege('control_api_runtime', 'public.governed_trace_safe_metadata(jsonb)', 'EXECUTE') AS control_metadata,
          has_function_privilege('trace_maintenance_runtime', 'public.governed_trace_safe_metadata(jsonb)', 'EXECUTE') AS trace_metadata,
          has_function_privilege('workflow_recipes_runtime', 'public.governed_trace_safe_metadata(jsonb)', 'EXECUTE') AS workflow_metadata
       FROM pg_proc validator
       JOIN pg_proc metadata
         ON metadata.proname = 'governed_trace_safe_metadata'
        AND metadata.proargtypes::text = '3802'
      WHERE validator.proname = 'governed_trace_safe_agent_run_metadata'
        AND validator.proargtypes::text = '25 3802'`
    )
    expect(functionState.rows[0]?.validator_config).toContain('search_path=pg_catalog, public')
    expect(functionState.rows[0]?.metadata_config).toContain('search_path=pg_catalog, public')
    expect(functionState.rows[0]).toMatchObject({
      control_validator: true,
      trace_validator: false,
      workflow_validator: false,
      control_metadata: true,
      trace_metadata: true,
      workflow_metadata: false,
    })

    const beforeSecondRun = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    await initDb({ connect: () => dbPool.connect() })
    const afterSecondRun = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    expect(beforeSecondRun.rows[0]?.count).toBe('1')
    expect(afterSecondRun.rows[0]?.count).toBe('1')
  })
})

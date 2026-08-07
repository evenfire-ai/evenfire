import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import {
  type PromptBridgeFinalizationInput,
  finalizePromptBridgeInTransaction,
} from '../src/services/pluginWorkloadSdkFinalization.js'
import { tokenUsagePayload } from '../src/services/tracing/usageProjection.js'
import type { LlmUsageEvent } from '../src/services/usageEvents.js'

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

// The historical validator installed by restoreHistoricalRuntimeState() below
// must be the VERBATIM governed_trace_safe_agent_run_metadata definition
// shipped by migration 0065_governed_session_replay_and_prompt_history. The
// transcription lives in this constant so the "pins the historical validator
// fixture" test can anchor it (whitespace-insensitively) against the real 0065
// SQL captured from CONTROL_API_MIGRATIONS -- if 0065 ever changes, this suite
// fails loudly instead of silently exercising a stale historical contract.
const HISTORICAL_0065_VALIDATOR_SQL = `CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata(event_kind TEXT, value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT CASE
            WHEN event_kind <> 'token_usage' THEN governed_trace_safe_metadata(value)
            ELSE jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND value ?& ARRAY[
               'request_ref', 'provider', 'model', 'source_kind',
               'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
               'cache_tokens_reported'
             ]
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'request_ref', 'provider', 'model', 'source_kind',
                  'input_tokens', 'output_tokens', 'cache_read_tokens',
                  'cache_write_tokens', 'cache_tokens_reported', 'iteration', 'prompt_bridge'
                )
             )
             AND jsonb_typeof(value->'request_ref') = 'string'
             AND (value->>'request_ref') ~ '^[0-9a-f]{64}$'
             AND jsonb_typeof(value->'provider') = 'string'
             AND jsonb_typeof(value->'model') = 'string'
             AND jsonb_typeof(value->'source_kind') = 'string'
             AND value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown', 'plugin_workload_sdk')
             AND jsonb_typeof(value->'input_tokens') = 'number'
             AND (value->>'input_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'output_tokens') = 'number'
             AND (value->>'output_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_read_tokens') = 'number'
             AND (value->>'cache_read_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_write_tokens') = 'number'
             AND (value->>'cache_write_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_tokens_reported') = 'boolean'
             AND (
               NOT (value ? 'iteration')
               OR (
                 jsonb_typeof(value->'iteration') = 'number'
                 AND (value->>'iteration') ~ '^(0|[1-9][0-9]*)$'
               )
             )
             AND (
               NOT (value ? 'prompt_bridge')
               OR (
                 jsonb_typeof(value->'prompt_bridge') = 'object'
                 AND value->'prompt_bridge' ?& ARRAY[
                   'invocation_id', 'attempt_generation', 'target_ref',
                   'fallback_used', 'attempt_count', 'provider_attempt_id',
                   'provider_attempt_index'
                 ]
                 AND (value->'prompt_bridge'->>'invocation_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'provider_attempt_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'attempt_generation') ~ '^[1-9][0-9]*$'
                 AND (value->'prompt_bridge'->>'provider_attempt_index') ~ '^[1-9][0-9]*$'
                 AND jsonb_typeof(value->'prompt_bridge'->'target_ref') = 'string'
                 AND jsonb_typeof(value->'prompt_bridge'->'fallback_used') = 'boolean'
                 AND jsonb_typeof(value->'prompt_bridge'->'attempt_count') = 'number'
               )
             )
          END;
        $$;`

function normalizeSqlWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

async function capture0065MigrationSql(): Promise<string> {
  const migration0065 = CONTROL_API_MIGRATIONS.find(candidate =>
    candidate.version.startsWith('0065_')
  )
  if (!migration0065) {
    throw new Error('no 0065_* migration is registered in CONTROL_API_MIGRATIONS')
  }
  const captured: string[] = []
  await migration0065.apply({
    query: async (text: string) => {
      captured.push(text)
      return { rows: [], rowCount: 0 }
    },
  })
  return captured.join('\n')
}

describeRealPostgres('Plugin Workload SDK runtime-contract upgrade on real PostgreSQL', () => {
  const database = `control_api_sdk_contract_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let dbPool: Pool

  // Invocations the 0090 fencing must NOT touch (seeded in the main test
  // before its successful migration run, re-checked after the body re-run in
  // the idempotency test): a terminal v2 invocation and a v2 invocation whose
  // lease is still live.
  const preservedTerminalInvocationId = randomUUID()
  const preservedLeasedInvocationId = randomUUID()

  async function fetchPreservedInvocations() {
    const result = await dbPool.query<{
      recipe_name: string
      contract_version: number
      status: string
      lease_expires_at: Date | null
    }>(
      `SELECT recipe_name, contract_version, status, lease_expires_at
         FROM plugin_workload_sdk_invocations
        WHERE id = ANY($1::uuid[])
        ORDER BY recipe_name`,
      [[preservedLeasedInvocationId, preservedTerminalInvocationId]]
    )
    return result.rows
  }

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
    // HISTORICAL_0065_VALIDATOR_SQL is the VERBATIM
    // governed_trace_safe_agent_run_metadata definition shipped by migration
    // 0065_governed_session_replay_and_prompt_history, anchored against the
    // real migration SQL by the "pins the historical validator fixture" test.
    // It is intentionally permissive where 0090 hardens: prompt_bridge is
    // allowed, invocation_id/provider_attempt_id only need to match the lax
    // '^[0-9a-f-]{36}$' shape, provider_attempt_index/attempt_count are
    // uncapped, target_ref has no length cap, and there is no allowlist for
    // nested prompt_bridge keys. Installing the real historical validator (not
    // a strawman) lets the test seed rows 0065 accepted and 0090 must reject.
    //
    // The remaining pre-0090 state below (RESET search_path, the GRANT set,
    // the contract_version DEFAULT 2, and the dropped/permissive constraints)
    // is NOT derivable from CONTROL_API_MIGRATIONS: it accumulated through
    // in-place edits of the bootstrap schema (pluginWorkloadSdkSchema.ts and
    // friends) rather than versioned migrations, so there is no historical SQL
    // text to anchor it against. It is transcribed here by hand on purpose.
    await dbPool.query(`
      ${HISTORICAL_0065_VALIDATOR_SQL}
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
    // Built by the REAL producer (tokenUsagePayload in
    // services/tracing/usageProjection.ts) from a fully-populated
    // LlmUsageEvent, so any drift in the producer's payload shape breaks this
    // suite instead of leaving it green over a hand-typed stale copy.
    const usage: LlmUsageEvent = {
      request_id: 'plugin-workload-sdk-runtime-contract-request',
      ts: new Date().toISOString(),
      run_id: null,
      host_ref: 'mcp-host/integration',
      context_ref: null,
      team_id: null,
      provider: 'openai',
      model: 'gpt-4o-mini',
      llm_secret_name: 'openai-api-key',
      source_kind: 'plugin_workload_sdk',
      user_id: null,
      sender: null,
      channel_type: null,
      recipe_name: null,
      cron_job_id: null,
      task_id: null,
      iteration: null,
      input_tokens: 23,
      output_tokens: 11,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_tokens_reported: false,
      prompt_bridge_metadata: {
        invocation_id: invocationId,
        target_ref: 'primary-openai',
        credential_slot: 'openai-api-key',
        fallback_used: false,
        attempt_count: 1,
        attempt_generation: 1,
        provider_attempt_id: providerAttemptId,
        provider_attempt_index: 1,
      },
    }
    const payload = tokenUsagePayload(usage)
    if (!payload.prompt_bridge) {
      throw new Error(
        'tokenUsagePayload dropped prompt_bridge for a fully-populated plugin_workload_sdk usage event'
      )
    }
    return { ...payload, prompt_bridge: payload.prompt_bridge }
  }

  it('pins the historical validator fixture to the verbatim 0065 migration SQL', async () => {
    // Anchors restoreHistoricalRuntimeState()'s transcription against the real
    // 0065 migration body in CONTROL_API_MIGRATIONS (captured through a
    // recording DbClient; 0065's apply issues exactly one query and never
    // branches on results). If 0065 ever changes, this fails loudly instead of
    // letting the suite keep exercising a stale "historical" contract.
    const sql0065 = await capture0065MigrationSql()
    const validatorMatch = sql0065.match(
      /CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata[\s\S]*?\$\$;/
    )
    expect(
      validatorMatch,
      'migration 0065 no longer defines governed_trace_safe_agent_run_metadata'
    ).not.toBeNull()
    expect(normalizeSqlWhitespace(HISTORICAL_0065_VALIDATOR_SQL)).toBe(
      normalizeSqlWhitespace(validatorMatch![0])
    )
  })

  it('repairs the historical runtime contracts, finalizes usage, and dedups re-runs', async () => {
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

    // Fidelity proof that the installed fixture is the REAL (permissive) 0065
    // validator and not a strawman: 0065 accepts the modern prompt_bridge
    // payload, so finalization succeeds under the historical contract too.
    const historicalAccepts = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_agent_run_metadata('token_usage', $1::jsonb) AS accepted`,
      [JSON.stringify(validPayload())]
    )
    expect(historicalAccepts.rows[0]?.accepted).toBe(true)

    const historicalClient = await dbPool.connect()
    try {
      await begin(historicalClient)
      const historicalInput = await seedAttempt(historicalClient, {
        contractVersion: 2,
        lease: true,
      })
      const historicalResult = await finalizePromptBridgeInTransaction(
        historicalInput,
        historicalClient
      )
      expect(historicalResult).toMatchObject({ status: 'complete', usageAccepted: true })
      await historicalClient.query('ROLLBACK')
    } finally {
      historicalClient.release()
    }

    // One seed per rule that 0090 hardens over 0065. Every payload MUST be
    // insertable under the historical CHECK (proving 0065 accepted it) and MUST
    // make the 0090 reconciliation abort fail-closed, leaving schema_migrations
    // without 0090 and the row intact.
    const hardenedRuleSeeds: Array<{ label: string; payload: Record<string, unknown> }> = [
      {
        // Passes the lax '^[0-9a-f-]{36}$' shape, fails the canonical
        // 8-4-4-4-12 UUID regex enforced by 0090.
        label: 'non-canonical 36-char invocation_id',
        payload: {
          ...validPayload(),
          prompt_bridge: {
            ...validPayload().prompt_bridge,
            invocation_id: 'abcdefabcdefabcdefabcdefabcdefabcdef',
          },
        },
      },
      {
        // 0065 allowed any positive integer; 0090 caps the index at 4.
        label: 'provider_attempt_index above the 1-4 cap',
        payload: {
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, provider_attempt_index: 5 },
        },
      },
      {
        // 0065 only required a string; 0090 caps target_ref at 256 chars.
        label: 'target_ref longer than 256 chars',
        payload: {
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, target_ref: 'x'.repeat(257) },
        },
      },
      {
        // 0065 had no nested-key allowlist; 0090 rejects unknown keys.
        label: 'unexpected nested prompt_bridge key',
        payload: {
          ...validPayload(),
          prompt_bridge: { ...validPayload().prompt_bridge, unexpected_key: true },
        },
      },
    ]

    for (const seed of hardenedRuleSeeds) {
      // Throws (failing the test loudly) if the historical 0065 CHECK rejects
      // the payload -- i.e. if the fixture ever regresses into a strawman.
      const seededEventId = await seedTraceEvent(seed.payload, 'historical')

      await expect(
        initDb({ connect: () => dbPool.connect() }),
        `0090 must abort on historical row: ${seed.label}`
      ).rejects.toThrow(
        /cannot reconcile .* historical agent_run_events rows with invalid payload metadata/
      )

      const failedMigrationState = await dbPool.query<{
        migration_count: string
        row_count: string
      }>(
        `SELECT
            (SELECT COUNT(*)::text FROM schema_migrations
              WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation') AS migration_count,
            (SELECT COUNT(*)::text FROM agent_run_events WHERE event_id = $1) AS row_count`,
        [seededEventId]
      )
      expect(failedMigrationState.rows[0], seed.label).toEqual({
        migration_count: '0',
        row_count: '1',
      })

      const historicalCleanupClient = await dbPool.connect()
      try {
        await begin(historicalCleanupClient)
        await historicalCleanupClient.query('DELETE FROM agent_run_events WHERE event_id = $1', [
          seededEventId,
        ])
        await historicalCleanupClient.query(
          'DELETE FROM governed_event_stream WHERE event_id = $1',
          [seededEventId]
        )
        await commit(historicalCleanupClient)
      } finally {
        historicalCleanupClient.release()
      }
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

    // Rows the fencing must PRESERVE, seeded in the SAME run as the successful
    // migration below. If the fencing UPDATE's WHERE ever loses
    // `status = 'in_progress'`, the terminal v2 row gets rewritten and the
    // preservation assertion after initDb fails; if it loses
    // `lease_expires_at IS NULL`, the live-lease v2 row gets rewritten and the
    // assertion fails too.
    await dbPool.query(
      `INSERT INTO plugin_workload_sdk_invocations
         (id, recipe_namespace, recipe_name, caller_ref, method, detail,
          idempotency_key_hash, payload_hash, status, authorization_decision,
          contract_version, attempt_generation, lease_expires_at)
       VALUES
         ($1, 'sandbox-recipes', 'preserved-v2-terminal', 'integration-test',
          'promptBridge', '{}', $3, $4, 'complete', 'authorized', 2, 1, NULL),
         ($2, 'sandbox-recipes', 'preserved-v2-leased', 'integration-test',
          'promptBridge', '{}', $5, $6, 'in_progress', 'authorized', 2, 1,
          now() + interval '30 minutes')`,
      [
        preservedTerminalInvocationId,
        preservedLeasedInvocationId,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
      ]
    )
    const preservedBefore = await fetchPreservedInvocations()
    expect(preservedBefore).toMatchObject([
      { recipe_name: 'preserved-v2-leased', contract_version: 2, status: 'in_progress' },
      { recipe_name: 'preserved-v2-terminal', contract_version: 2, status: 'complete' },
    ])
    expect(preservedBefore[0]?.lease_expires_at).not.toBeNull()
    expect(preservedBefore[1]?.lease_expires_at).toBeNull()

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

    // "preserves terminal v2" / "reconciles only ... without a lease": the
    // fencing rewrote ONLY the legacy v2-no-lease invocation above. The
    // terminal v2 row and the live-lease in-progress v2 row kept their
    // original contract_version, status, AND lease_expires_at byte-for-byte.
    const preservedAfter = await fetchPreservedInvocations()
    expect(preservedAfter).toEqual(preservedBefore)

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

    // Runner dedup ONLY -- this is NOT a body-idempotency proof: 0090 is
    // already registered in schema_migrations, so this second initDb takes the
    // `appliedVersions.has(version)` shortcut in applyPendingMigrations and
    // never re-executes the migration body. What it proves is that a re-run
    // does not double-register the version. True body re-application over its
    // own output is covered by the dedicated idempotency test below.
    const beforeDedupRun = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    await initDb({ connect: () => dbPool.connect() })
    const afterDedupRun = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    expect(beforeDedupRun.rows[0]?.count).toBe('1')
    expect(afterDedupRun.rows[0]?.count).toBe('1')
  })

  it('re-applies the 0090 migration body idempotently over its own output', async () => {
    // Precondition (fail loud, not skip): the main test above must have left
    // the database fully migrated with 0090 registered exactly once.
    const registered = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    expect(registered.rows[0]?.count).toBe('1')

    type ContractState = {
      trace_check: string
      trace_check_validated: boolean
      lease_check: string
      attempt_check: string
      default_value: string | null
      validator_config: string[] | null
      metadata_config: string[] | null
      control_validator: boolean
      trace_validator: boolean
      workflow_validator: boolean
    }
    async function captureContractState(): Promise<ContractState> {
      const result = await dbPool.query<ContractState>(
        `SELECT
            (SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conname = 'agent_run_events_check') AS trace_check,
            (SELECT convalidated FROM pg_constraint
              WHERE conname = 'agent_run_events_check') AS trace_check_validated,
            (SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conname = 'plugin_workload_sdk_invocations_v2_lease_check') AS lease_check,
            (SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conname = 'plugin_workload_sdk_provider_attempts_status_check') AS attempt_check,
            (SELECT column_default FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'plugin_workload_sdk_invocations'
                AND column_name = 'contract_version') AS default_value,
            (SELECT proconfig FROM pg_proc
              WHERE proname = 'governed_trace_safe_agent_run_metadata'
                AND proargtypes::text = '25 3802') AS validator_config,
            (SELECT proconfig FROM pg_proc
              WHERE proname = 'governed_trace_safe_metadata'
                AND proargtypes::text = '3802') AS metadata_config,
            has_function_privilege('control_api_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS control_validator,
            has_function_privilege('trace_maintenance_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS trace_validator,
            has_function_privilege('workflow_recipes_runtime', 'public.governed_trace_safe_agent_run_metadata(text,jsonb)', 'EXECUTE') AS workflow_validator`
      )
      const row = result.rows[0]
      if (!row) throw new Error('contract-state capture query returned no row')
      return row
    }

    const stateBefore = await captureContractState()
    const preservedBefore = await fetchPreservedInvocations()

    // Same deregistration trick restoreHistoricalRuntimeState uses: with the
    // schema_migrations row gone, applyPendingMigrations MUST execute the 0090
    // body a second time -- this time over the body's OWN output (validators,
    // constraints, and fencing already applied). This is the re-application
    // the deploy Job's backoffLimit-2 retry relies on being safe, and the
    // property the migration's own "the body is idempotent" comment claims.
    await dbPool.query(
      `DELETE FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )

    // The second body execution must NOT throw...
    await initDb({ connect: () => dbPool.connect() })

    // ...must leave the runtime contract byte-for-byte identical (constraint
    // still validated, functions still pinned to search_path, grants and
    // defaults unchanged)...
    const stateAfter = await captureContractState()
    expect(stateAfter).toEqual(stateBefore)
    // Guard against before/after drifting together: pin the load-bearing bits.
    expect(stateAfter.trace_check_validated).toBe(true)
    expect(stateAfter.trace_check).toContain('IS TRUE')
    expect(stateAfter.lease_check).toContain('lease_expires_at IS NOT NULL')
    expect(stateAfter.attempt_check).toContain("'skipped'")
    expect(stateAfter.default_value).toBe('1')
    expect(stateAfter.validator_config).toContain('search_path=pg_catalog, public')
    expect(stateAfter.metadata_config).toContain('search_path=pg_catalog, public')
    expect(stateAfter).toMatchObject({
      control_validator: true,
      trace_validator: false,
      workflow_validator: false,
    })

    // ...must not have re-fenced the preserved invocations...
    expect(await fetchPreservedInvocations()).toEqual(preservedBefore)

    // ...and must have re-registered the version exactly once.
    const reRegistered = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations
        WHERE version = '0090_plugin_workload_sdk_runtime_contract_reconciliation'`
    )
    expect(reRegistered.rows[0]?.count).toBe('1')
  })
})

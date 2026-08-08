import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Request as ExpressRequest } from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import { pool as runtimePool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { createExternalDirectoryRouter } from '../src/routes/external/directory.js'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'
import { createExternalUsersRouter } from '../src/routes/external/users.js'
import {
  type GfsSubject,
  auditMutation,
  writeGfsGrantBatchInTransaction,
} from '../src/routes/gfs/grants.js'
import { writeGfsShareBatchInTransaction } from '../src/routes/gfs/shares.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import {
  getCurrentTeam,
  getTeamAgents,
  getUserAgents,
  googleLoginData,
} from '../src/services/directory/index.js'
import { runWithAdministrativeRequestContext } from '../src/services/tracing/adminOperationContext.js'
import { PostgresAdministrativeIntentLookup } from '../src/services/tracing/adminOperationService.js'
import { AdministrativeEventService } from '../src/services/tracing/administrativeEvents.js'
import { AgentRunEventService } from '../src/services/tracing/agentRunEvents.js'
import { CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1 } from '../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js'
import { appendControlApiPermissionEventsInTransaction } from '../src/services/tracing/controlApiPermissionEvents.js'
import {
  DirectRunAttributionBindingService,
  DirectRunBindingConflictError,
} from '../src/services/tracing/directRunAttributionBindingService.js'
import { MaintenanceCostRepository } from '../src/services/tracing/maintenance/maintenanceCostRepository.js'
import { runRetentionBatch } from '../src/services/tracing/maintenance/retention.js'
import { PostgresGovernedEventReadRepository } from '../src/services/tracing/postgresGovernedEventReadRepository.js'
import { PostgresGovernedSessionReplayRepository } from '../src/services/tracing/postgresGovernedSessionReplayRepository.js'
import { projectAcceptedUsageEvents } from '../src/services/tracing/usageProjection.js'
import { ingestUsageEventsInTransaction } from '../src/services/usageEvents.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { signRpcAccessToken, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

type PrivilegeExpectation = Record<string, Set<string>>

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function expectPrivileges(actual: string[], expected: string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort())
}

async function relationPrivileges(pool: Pool, roleName: string): Promise<PrivilegeExpectation> {
  const result = await pool.query<{
    relation_name: string
    privilege_name: string
    allowed: boolean
  }>(
    `
    SELECT relation.relname AS relation_name,
           privilege.privilege_name,
           has_table_privilege($1, relation.oid, privilege.privilege_name) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN (VALUES
        ('SELECT'),
        ('INSERT'),
        ('UPDATE'),
        ('DELETE'),
        ('TRUNCATE'),
        ('REFERENCES'),
        ('TRIGGER')
      ) privilege(privilege_name)
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY relation.relname, privilege.privilege_name
  `,
    [roleName]
  )

  const actual: PrivilegeExpectation = {}
  for (const row of result.rows) {
    actual[row.relation_name] ??= new Set()
    if (row.allowed) actual[row.relation_name].add(row.privilege_name)
  }
  return actual
}

async function sequencePrivileges(pool: Pool, roleName: string): Promise<PrivilegeExpectation> {
  const result = await pool.query<{
    sequence_name: string
    privilege_name: string
    allowed: boolean
  }>(
    `
    SELECT sequence.relname AS sequence_name,
           privilege.privilege_name,
           has_sequence_privilege($1, sequence.oid, privilege.privilege_name) AS allowed
      FROM pg_class sequence
      JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
      CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) privilege(privilege_name)
     WHERE namespace.nspname = 'public'
       AND sequence.relkind = 'S'
     ORDER BY sequence.relname, privilege.privilege_name
  `,
    [roleName]
  )
  const actual: PrivilegeExpectation = {}
  for (const row of result.rows) {
    actual[row.sequence_name] ??= new Set()
    if (row.allowed) actual[row.sequence_name].add(row.privilege_name)
  }
  return actual
}

describeRealPostgres('control-api real Postgres migrations', () => {
  const database = `control_api_migration_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let dbPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString })
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
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('applies initDb twice and leaves the exact runtime privilege envelopes', async () => {
    const { initDb } = await import('../src/db.js')
    const connector = { connect: () => dbPool.connect() }

    await initDb(connector)
    const firstVersions = await dbPool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    )

    await initDb(connector)
    const secondVersions = await dbPool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    )

    expect(secondVersions.rows.map(row => row.version)).toEqual(
      firstVersions.rows.map(row => row.version)
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0063_workflow_approval_trace_binding'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0064_agent_decision_source_catalog'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0065_governed_session_replay_and_prompt_history'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0054_workflow_run_completed_notification_download_detection'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0066_governed_trace_target_principal_projection'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0067_llm_runtime_access_profiles'
    )

    await dbPool.query(`
      DELETE FROM schema_migrations
       WHERE version = '0066_governed_trace_target_principal_projection';
      CREATE OR REPLACE FUNCTION governed_trace_safe_metadata(value JSONB)
      RETURNS BOOLEAN
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT jsonb_typeof(value) = 'object'
           AND NOT (value ? 'target_principal_kind')
           AND NOT (value ? 'target_principal_ref');
      $$;
    `)
    await initDb(connector)
    const upgradedTargetPrincipal = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_metadata(
         '{"target_principal_kind":"host","target_principal_ref":"host:1st:mcp-host/chatllm"}'::jsonb
       ) AS accepted`
    )
    expect(upgradedTargetPrincipal.rows).toEqual([{ accepted: true }])
    const restoredMigration = await dbPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM schema_migrations
        WHERE version = '0066_governed_trace_target_principal_projection'`
    )
    expect(restoredMigration.rows).toEqual([{ count: '1' }])

    const currentGovernedVersions = [
      '0061_governed_run_trace_schema_foundation',
      '0062_governed_trace_runtime_roles',
      '0063_workflow_approval_trace_binding',
      '0064_agent_decision_source_catalog',
      '0065_governed_session_replay_and_prompt_history',
      '0066_governed_trace_target_principal_projection',
      '0067_llm_runtime_access_profiles',
    ]
    const legacyGovernedVersions = [
      '0054_governed_run_trace_schema_foundation',
      '0055_governed_trace_runtime_roles',
      '0056_workflow_approval_trace_binding',
      '0057_agent_decision_source_catalog',
      '0058_governed_session_replay_and_prompt_history',
      '0059_workflow_run_completed_notification_download_detection',
      '0060_governed_trace_target_principal_projection',
    ]
    await dbPool.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
      currentGovernedVersions,
    ])
    await dbPool.query(
      `INSERT INTO schema_migrations(version)
       SELECT unnest($1::text[])
       ON CONFLICT (version) DO NOTHING`,
      [legacyGovernedVersions]
    )

    await initDb(connector)
    const upgradedLegacyVersions = await dbPool.query<{ version: string }>(
      `SELECT version
         FROM schema_migrations
        WHERE version = ANY($1::text[])
        ORDER BY version`,
      [currentGovernedVersions]
    )
    expect(upgradedLegacyVersions.rows.map(row => row.version)).toEqual(currentGovernedVersions)

    const requiredTables = await dbPool.query<{ table_name: string }>(
      `
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name
    `,
      [
        [
          'agent_run_events',
          'administrative_events',
          'governed_event_stream',
          'governed_run_attribution_bindings',
          'governed_approval_prompt_history',
          'infrastructure_cost_daily',
          'infrastructure_cost_daily_components',
          'infrastructure_price_snapshots',
          'infrastructure_telemetry_events',
          'llm_allowed_models',
          'llm_allowed_models_audit',
          'llm_catalog_sync_runs',
          'notification_deliveries',
          'workflow_approval_requests',
          'workflow_run_steps',
          'workflow_runs',
          'workflow_schedules',
        ],
      ]
    )
    expect(requiredTables.rows.map(row => row.table_name)).toEqual([
      'administrative_events',
      'agent_run_events',
      'governed_approval_prompt_history',
      'governed_event_stream',
      'governed_run_attribution_bindings',
      'infrastructure_cost_daily',
      'infrastructure_cost_daily_components',
      'infrastructure_price_snapshots',
      'infrastructure_telemetry_events',
      'llm_allowed_models',
      'llm_allowed_models_audit',
      'llm_catalog_sync_runs',
      'notification_deliveries',
      'workflow_approval_requests',
      'workflow_run_steps',
      'workflow_runs',
      'workflow_schedules',
    ])

    const functionAndTriggerState = await dbPool.query<{
      notify_security_definer: boolean
      notify_search_path: string[] | null
      wrc_can_execute_notify: boolean
      workflow_runs_notify: boolean
      notification_deliveries_notify: boolean
    }>(`
      SELECT
        (SELECT prosecdef
           FROM pg_proc
          WHERE oid = 'public.notify_workflow_run_update()'::regprocedure)
          AS notify_security_definer,
        (SELECT proconfig
           FROM pg_proc
          WHERE oid = 'public.notify_workflow_run_update()'::regprocedure)
          AS notify_search_path,
        has_function_privilege(
          'workflow_recipes_runtime',
          'public.notify_workflow_run_update()',
          'EXECUTE'
        ) AS wrc_can_execute_notify,
        EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'workflow_runs_notify'
             AND tgrelid = 'public.workflow_runs'::regclass
             AND NOT tgisinternal
        ) AS workflow_runs_notify,
        EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'notification_deliveries_notify'
             AND tgrelid = 'public.notification_deliveries'::regclass
             AND NOT tgisinternal
        ) AS notification_deliveries_notify
    `)
    expect(functionAndTriggerState.rows[0]).toMatchObject({
      notify_security_definer: true,
      notify_search_path: ['search_path=pg_catalog'],
      wrc_can_execute_notify: false,
      workflow_runs_notify: true,
      notification_deliveries_notify: true,
    })

    const roles = await dbPool.query<{
      rolname: string
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolreplication: boolean
      rolbypassrls: boolean
    }>(
      `
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname
    `,
      [['control_api_runtime', 'trace_maintenance_runtime', 'workflow_recipes_runtime']]
    )
    expect(roles.rows).toHaveLength(3)
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      })
    }

    const exactControlApiRelations = [
      'administrative_events',
      'agent_run_events',
      'governed_event_read_v1',
      'governed_event_stream',
      'governed_approval_prompt_history',
      'governed_run_attribution_bindings',
      'infrastructure_cost_daily',
      'infrastructure_cost_daily_components',
      'infrastructure_price_snapshots',
      'infrastructure_telemetry_events',
      'llm_allowed_models',
      'llm_allowed_models_audit',
      'llm_catalog_sync_runs',
    ] as const
    const controlApiRelations = await relationPrivileges(dbPool, 'control_api_runtime')
    const expectedControlApiRelations: Record<string, string[]> = {
      administrative_events: ['INSERT', 'SELECT'],
      agent_run_events: ['INSERT', 'SELECT'],
      governed_event_read_v1: ['SELECT'],
      governed_event_stream: ['INSERT', 'SELECT'],
      governed_approval_prompt_history: ['INSERT', 'SELECT'],
      governed_run_attribution_bindings: ['INSERT', 'SELECT'],
      infrastructure_cost_daily: ['SELECT'],
      infrastructure_cost_daily_components: ['SELECT'],
      infrastructure_price_snapshots: ['SELECT'],
      infrastructure_telemetry_events: ['INSERT', 'SELECT'],
      llm_allowed_models: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      llm_allowed_models_audit: ['INSERT', 'SELECT'],
      llm_catalog_sync_runs: ['INSERT', 'SELECT'],
    }
    for (const relation of exactControlApiRelations) {
      expectPrivileges(
        [...(controlApiRelations[relation] ?? new Set())],
        expectedControlApiRelations[relation] ?? []
      )
    }
    expectPrivileges([...(controlApiRelations.gfs_blob_manifests ?? new Set())], [])

    const maintenanceRelations = await relationPrivileges(dbPool, 'trace_maintenance_runtime')
    const expectedMaintenanceRelations: Record<string, string[]> = {
      administrative_events: ['SELECT'],
      agent_run_events: ['SELECT'],
      governed_event_read_v1: ['SELECT'],
      governed_event_stream: ['INSERT', 'SELECT'],
      infrastructure_cost_daily: ['INSERT', 'SELECT'],
      infrastructure_cost_daily_components: ['INSERT', 'SELECT'],
      infrastructure_price_snapshots: ['INSERT', 'SELECT'],
      infrastructure_telemetry_events: ['INSERT', 'SELECT'],
    }
    for (const [relation, actual] of Object.entries(maintenanceRelations)) {
      expectPrivileges([...actual], expectedMaintenanceRelations[relation] ?? [])
    }

    const maintenanceSequences = await sequencePrivileges(dbPool, 'trace_maintenance_runtime')
    const expectedMaintenanceSequences: Record<string, string[]> = {
      governed_event_stream_stream_sequence_seq: ['SELECT', 'USAGE'],
      infrastructure_telemetry_events_ingest_sequence_seq: ['SELECT', 'USAGE'],
    }
    for (const [sequence, actual] of Object.entries(maintenanceSequences)) {
      expectPrivileges([...actual], expectedMaintenanceSequences[sequence] ?? [])
    }

    const directRunId = randomUUID()
    const bindAsRuntime = new DirectRunAttributionBindingService(async work => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    const directBinding = {
      runId: directRunId,
      hostRef: 'sandbox-recipes/runtime-boundary-test',
      sessionId: 'session-real-pg',
      origin: 'direct_chat' as const,
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-real-pg',
      userId: null,
      teamId: null,
    }
    await expect(bindAsRuntime.bind(directBinding)).resolves.toMatchObject({
      runId: directRunId,
      status: 'created',
    })
    await expect(bindAsRuntime.bind(directBinding)).resolves.toMatchObject({
      runId: directRunId,
      status: 'existing',
    })
    await expect(
      bindAsRuntime.bind({ ...directBinding, sessionId: 'different-session' })
    ).rejects.toBeInstanceOf(DirectRunBindingConflictError)

    const immutableBindingClient = await dbPool.connect()
    try {
      await immutableBindingClient.query('BEGIN')
      await immutableBindingClient.query(
        'GRANT UPDATE ON governed_run_attribution_bindings TO control_api_runtime'
      )
      await immutableBindingClient.query('SET LOCAL ROLE control_api_runtime')
      await expect(
        immutableBindingClient.query(
          'UPDATE governed_run_attribution_bindings SET session_id = $2 WHERE run_id = $1',
          [directRunId, 'mutated-session']
        )
      ).rejects.toThrow(/append-only/)
    } finally {
      await immutableBindingClient.query('ROLLBACK')
      immutableBindingClient.release()
    }

    const expiredPromptId = randomUUID()
    const retainedPromptId = randomUUID()
    const promptInsertClient = await dbPool.connect()
    try {
      await promptInsertClient.query('BEGIN')
      await promptInsertClient.query('SET LOCAL ROLE control_api_runtime')
      for (const [approvalRequestId, capturedAt, expiresAt] of [
        [expiredPromptId, '2026-07-10T00:00:00.000Z', '2026-07-10T01:00:00.000Z'],
        [retainedPromptId, '2099-07-10T00:00:00.000Z', '2099-07-10T01:00:00.000Z'],
      ]) {
        await promptInsertClient.query(
          `INSERT INTO governed_approval_prompt_history (
             approval_request_id, approval_kind, ciphertext, nonce, key_version,
             plaintext_sha256, plaintext_bytes, redaction_summary, source_kind,
             captured_at, expires_at
           ) VALUES ($1, 'workflow', $2, $3, 'v1', $4, 1,
                     '{"redacted":false,"replacementCount":0}'::jsonb,
                     'control_api_local', $5, $6)`,
          [
            approvalRequestId,
            Buffer.alloc(17, 1),
            Buffer.alloc(12, 2),
            'a'.repeat(64),
            capturedAt,
            expiresAt,
          ]
        )
      }
      await promptInsertClient.query('COMMIT')
    } catch (error) {
      await promptInsertClient.query('ROLLBACK')
      throw error
    } finally {
      promptInsertClient.release()
    }

    const promptCleanupClient = await dbPool.connect()
    try {
      await promptCleanupClient.query('BEGIN')
      await promptCleanupClient.query('SET LOCAL ROLE trace_maintenance_runtime')
      const deleted = await promptCleanupClient.query(
        'SELECT approval_request_id FROM governed_trace_prune_expired_prompts(250)'
      )
      expect(deleted.rows).toContainEqual({ approval_request_id: expiredPromptId })
      await promptCleanupClient.query('COMMIT')
    } catch (error) {
      await promptCleanupClient.query('ROLLBACK')
      throw error
    } finally {
      promptCleanupClient.release()
    }
    const promptPrivilegeClient = await dbPool.connect()
    try {
      await promptPrivilegeClient.query('BEGIN')
      await promptPrivilegeClient.query('SET LOCAL ROLE trace_maintenance_runtime')
      await expect(
        promptPrivilegeClient.query('SELECT * FROM governed_approval_prompt_history')
      ).rejects.toThrow(/permission denied/)
    } finally {
      await promptPrivilegeClient.query('ROLLBACK')
      promptPrivilegeClient.release()
    }
    const retainedPrompts = await dbPool.query<{ approval_request_id: string }>(
      `SELECT approval_request_id
         FROM governed_approval_prompt_history
        WHERE approval_request_id = ANY($1::uuid[])
        ORDER BY approval_request_id`,
      [[expiredPromptId, retainedPromptId]]
    )
    expect(retainedPrompts.rows).toEqual([{ approval_request_id: retainedPromptId }])

    const requiredFilterIndexes = [
      'idx_agent_run_events_session_window',
      'idx_agent_run_events_tool_session_filter',
      'idx_agent_run_events_approval_session_filter',
      'idx_administrative_events_list_filter',
      'idx_infrastructure_telemetry_list_filter',
    ]
    const filterIndexes = await dbPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])
        ORDER BY indexname`,
      [requiredFilterIndexes]
    )
    expect(filterIndexes.rows.map(row => row.indexname)).toEqual([...requiredFilterIndexes].sort())

    await dbPool.query(`
      WITH sessions AS (
        SELECT ordinal, gen_random_uuid() AS run_id, 'perf-session-' || ordinal AS session_id
          FROM generate_series(1, 300) ordinal
      ), fixture AS (
        SELECT sessions.*, event.ordinal AS event_ordinal, event.event_type, event.outcome
          FROM sessions
          CROSS JOIN (VALUES
            (1, 'run_start', 'started'),
            (2, 'tool_call', 'succeeded'),
            (3, 'approval', 'denied'),
            (4, 'run_end', 'succeeded')
          ) event(ordinal, event_type, outcome)
      ), inserted AS (
        INSERT INTO agent_run_events (
          source_kind, source_service, source_event_id, idempotency_key, run_id, session_id,
          span_id, origin, event_type, outcome, agent_sub, effective_scopes, decision,
          decision_source_kind, decision_source_ref, host_ref, payload_metadata,
          payload_sha256, occurred_at
        )
        SELECT 'mcp_host_runtime', 'mcp-host',
               'perf-agent-' || ordinal || '-' || event_ordinal,
               md5('perf-agent-' || ordinal || '-' || event_ordinal) ||
                 md5('perf-agent-extra-' || ordinal || '-' || event_ordinal),
               run_id, session_id, 'span-' || event_ordinal, 'direct_chat', event_type, outcome,
               'mcp-host:perf-host', ARRAY[]::text[],
               CASE WHEN event_type='approval' THEN 'require_approval' ELSE 'not_applicable' END,
               CASE WHEN event_type='approval' THEN 'approval_request' ELSE NULL END,
               CASE WHEN event_type='approval' THEN 'perf-approval' ELSE NULL END,
               'perf-host',
               CASE WHEN event_type='tool_call' THEN '{"tool_name":"shell.exec"}'::jsonb
                    WHEN event_type='approval' THEN '{"status":"denied"}'::jsonb
                    ELSE '{}'::jsonb END,
               md5('perf-payload-' || ordinal || '-' || event_ordinal) ||
                 md5('perf-payload-extra-' || ordinal || '-' || event_ordinal),
               '2026-07-14T10:00:00Z'::timestamptz + (ordinal * interval '1 second') +
                 (event_ordinal * interval '1 millisecond')
          FROM fixture
        ON CONFLICT DO NOTHING
        RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,run_id,payload_sha256)
      SELECT 'agent_run',event_id,1,occurred_at,ingested_at,'integration',run_id,payload_sha256
        FROM inserted
    `)
    await dbPool.query(`
      WITH inserted AS (
        INSERT INTO administrative_events (
          source_kind,source_service,source_event_id,idempotency_key,event_kind,action,outcome,
          service_sub,target_type,target_ref,payload_sha256,occurred_at
        )
        SELECT 'control_api_local','control-api','perf-admin-' || ordinal,
               md5('perf-admin-' || ordinal) || md5('perf-admin-extra-' || ordinal),
               'service_action','permission_grant','succeeded','control-api','permission',
               'permission/' || ordinal,
               md5('perf-admin-payload-' || ordinal) || md5('perf-admin-payload-extra-' || ordinal),
               '2026-07-14T11:00:00Z'::timestamptz + ordinal * interval '1 second'
          FROM generate_series(1, 400) ordinal
        ON CONFLICT DO NOTHING
        RETURNING event_id,occurred_at,ingested_at,payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,payload_sha256)
      SELECT 'administrative',event_id,1,occurred_at,ingested_at,'integration',payload_sha256
        FROM inserted
    `)
    await dbPool.query(`
      WITH inserted AS (
        INSERT INTO infrastructure_telemetry_events (
          source_service,source_kind,source_occurrence_id,telemetry_type,trigger_kind,outcome,
          reason_code,environment,cluster_name,namespace,workload_kind,workload_ref,
          kubernetes_kind,kubernetes_name,metadata_generation,payload_sha256,occurred_at,idempotency_key
        )
        SELECT 'control-api','trace_maintenance','perf-infra-' || ordinal,
               'reconcile_outcome','controller_reconcile','succeeded','ready','integration',
               'cluster-1','control-plane','Deployment','deployment/perf-' || ordinal,
               'Deployment','perf-' || ordinal,1,
               md5('perf-infra-payload-' || ordinal) || md5('perf-infra-payload-extra-' || ordinal),
               '2026-07-14T12:00:00Z'::timestamptz + ordinal * interval '1 second',
               md5('perf-infra-' || ordinal) || md5('perf-infra-extra-' || ordinal)
          FROM generate_series(1, 400) ordinal
        ON CONFLICT DO NOTHING
        RETURNING event_id,occurred_at,ingested_at,workload_ref,payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,workload_ref,payload_sha256)
      SELECT 'infrastructure_telemetry',event_id,1,occurred_at,ingested_at,'integration',workload_ref,payload_sha256
        FROM inserted
    `)
    await dbPool.query(
      'ANALYZE agent_run_events, administrative_events, infrastructure_telemetry_events, governed_event_stream'
    )

    const explained: Array<{
      label: string
      executionMs: number
      planningMs: number
      forcedIndexNames: string[]
      forcedNodeTypes: string[]
    }> = []
    type ExplainNode = { 'Index Name'?: string; 'Node Type'?: string; Plans?: ExplainNode[] }
    const collectIndexNames = (
      node: ExplainNode | undefined,
      names = new Set<string>()
    ): string[] => {
      if (!node) return [...names]
      if (node['Index Name']) names.add(node['Index Name'])
      for (const child of node.Plans ?? []) collectIndexNames(child, names)
      return [...names].sort()
    }
    const collectNodeTypes = (
      node: ExplainNode | undefined,
      names = new Set<string>()
    ): string[] => {
      if (!node) return [...names]
      if (node['Node Type']) names.add(node['Node Type'])
      for (const child of node.Plans ?? []) collectNodeTypes(child, names)
      return [...names].sort()
    }
    const explainClient = (label: string) => ({
      query: async (text: string, values?: readonly unknown[]) => {
        const planResult = await dbPool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
          values as unknown[] | undefined
        )
        const root = (planResult.rows[0] as Record<string, unknown>)['QUERY PLAN'] as Array<{
          'Execution Time': number
          'Planning Time': number
          Plan: ExplainNode
        }>
        const forcedClient = await dbPool.connect()
        let forcedIndexNames: string[] = []
        let forcedNodeTypes: string[] = []
        try {
          await forcedClient.query('BEGIN')
          await forcedClient.query('SET LOCAL enable_seqscan=off')
          const forcedResult = await forcedClient.query(
            `EXPLAIN (COSTS OFF, FORMAT JSON) ${text}`,
            values as unknown[] | undefined
          )
          const forcedRoot = (forcedResult.rows[0] as Record<string, unknown>)[
            'QUERY PLAN'
          ] as Array<{
            Plan: ExplainNode
          }>
          forcedIndexNames = collectIndexNames(forcedRoot[0]?.Plan)
          forcedNodeTypes = collectNodeTypes(forcedRoot[0]?.Plan)
          await forcedClient.query('ROLLBACK')
        } catch (error) {
          await forcedClient.query('ROLLBACK')
          throw error
        } finally {
          forcedClient.release()
        }
        explained.push({
          label,
          executionMs: root[0]?.['Execution Time'] ?? Number.POSITIVE_INFINITY,
          planningMs: root[0]?.['Planning Time'] ?? Number.POSITIVE_INFINITY,
          forcedIndexNames,
          forcedNodeTypes,
        })
        return { rows: [], rowCount: 0 }
      },
    })
    await new PostgresGovernedSessionReplayRepository(explainClient('session_list') as never).list({
      filters: {
        occurredFrom: '2026-07-01T00:00:00.000Z',
        occurredTo: '2026-07-31T00:00:00.000Z',
        outcome: [],
        sourceService: [],
        sessionId: [],
        hostRef: [],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: ['shell.exec'],
        approvalState: ['denied'],
      },
      highWatermark: '9223372036854775807',
      after: null,
      limit: 50,
      promptState: 'disabled',
    })
    for (const [label, family, filters] of [
      ['administrative_list', 'administrative', { action: ['permission_grant'] }],
      ['infrastructure_list', 'infrastructure_telemetry', { workloadKind: ['Deployment'] }],
    ] as const) {
      await new PostgresGovernedEventReadRepository(explainClient(label) as never).readAfter({
        scope: { kind: 'stream' },
        families: [family],
        order: 'latest',
        afterSequence: '9223372036854775807',
        highWatermark: '9223372036854775807',
        limit: 50,
        occurredFrom: '2026-07-01T00:00:00.000Z',
        occurredTo: '2026-07-31T00:00:00.000Z',
        filters,
      })
    }
    expect(explained.map(plan => plan.label)).toEqual([
      'session_list',
      'administrative_list',
      'infrastructure_list',
    ])
    for (const plan of explained) {
      expect(plan.executionMs).toBeLessThan(2_000)
      expect(plan.planningMs).toBeLessThan(2_000)
      expect(plan.forcedIndexNames.length).toBeGreaterThan(0)
      expect(plan.forcedNodeTypes).not.toContain('Seq Scan')
    }
    const planByLabel = Object.fromEntries(explained.map(plan => [plan.label, plan]))
    expect(planByLabel.session_list?.forcedIndexNames).toEqual(
      expect.arrayContaining(['governed_event_stream_event_family_event_id_key'])
    )
    expect(
      planByLabel.session_list?.forcedIndexNames.some(name =>
        name.startsWith('idx_agent_run_events_')
      )
    ).toBe(true)
    expect(planByLabel.administrative_list?.forcedIndexNames).toEqual(
      expect.arrayContaining([
        'idx_governed_event_stream_family_time',
        'idx_administrative_events_list_filter',
        'administrative_events_pkey',
      ])
    )
    expect(planByLabel.infrastructure_list?.forcedIndexNames).toEqual(
      expect.arrayContaining([
        'idx_governed_event_stream_family_time',
        'infrastructure_telemetry_events_pkey',
      ])
    )

    const priceEvidence = [
      {
        cloudProvider: 'gcp' as const,
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'cpu' as const,
        unit: 'vCPU_hour' as const,
        unitPrice: '1.000000000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:2026-07-01:cpu',
        sourceSha256: 'a'.repeat(64),
      },
      {
        cloudProvider: 'gcp' as const,
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'memory' as const,
        unit: 'GiB_hour' as const,
        unitPrice: '0.500000000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:2026-07-01:memory',
        sourceSha256: 'b'.repeat(64),
      },
    ]
    const costKey = {
      utcDay: '2026-07-10',
      cloudProvider: 'gcp' as const,
      cloudProjectId: 'project-1',
      clusterLocation: 'europe-west1',
      clusterName: 'cluster-1',
      environment: 'integration',
      namespace: 'control-plane',
      workloadKind: 'Deployment',
      workloadRef: 'control-api',
      currency: 'USD',
    }
    const costClient = await dbPool.connect()
    let persistedCostId = ''
    try {
      await costClient.query('BEGIN')
      const costRepository = new MaintenanceCostRepository(costClient)
      await expect(costRepository.persistPriceSnapshots(priceEvidence)).resolves.toBe(2)
      await expect(costRepository.persistPriceSnapshots(priceEvidence)).resolves.toBe(0)
      const prices = await costRepository.loadApprovedRequestedCapacityPriceSnapshots({
        key: costKey,
        clusterClass: 'standard',
        effectiveAt: '2026-07-10T00:00:00.000Z',
      })
      expect(prices).toHaveLength(2)
      const persistedCost = await costRepository.persistDailyCostVersion({
        key: costKey,
        valuationKind: 'estimated',
        selectedBasis: 'requested_capacity',
        publicationState: 'provisional',
        completenessStatus: 'complete',
        asOfUtc: '2026-07-11T01:00:00.000Z',
        sourceIntervalStart: '2026-07-10T00:00:00.000Z',
        sourceIntervalEnd: '2026-07-11T00:00:00.000Z',
        billingExportWatermark: null,
        sourceCount: 2,
        sourceSha256: 'c'.repeat(64),
        grossAmount: '1.500000000',
        creditsAmount: '0.000000000',
        netAmount: '1.500000000',
        components: prices.map(price => ({
          componentKey: price.resourceClass,
          resourceClass: price.resourceClass,
          allocationBucket: null,
          unitHours: '1.000000000',
          priceSnapshotId: price.id,
          providerService: null,
          providerSku: null,
          billingViewVersion: null,
          sourceRowCount: null,
          sourceSha256: price.sourceSha256,
          billingExportWatermark: null,
          grossAmount: price.unitPrice,
          creditsAmount: '0.000000000',
          netAmount: price.unitPrice,
        })),
      })
      expect(persistedCost).toMatchObject({ rollupVersion: 1, predecessorVersion: null })
      persistedCostId = persistedCost.id
      await costClient.query('COMMIT')
    } catch (error) {
      await costClient.query('ROLLBACK')
      throw error
    } finally {
      costClient.release()
    }
    const componentCount = await dbPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM infrastructure_cost_daily_components WHERE daily_cost_id = $1',
      [persistedCostId]
    )
    expect(componentCount.rows[0]?.count).toBe('2')

    const wrcRelations = await relationPrivileges(dbPool, 'workflow_recipes_runtime')
    const expectedWrcRelations: Record<string, string[]> = {
      team_workflow_triggers: ['DELETE'],
      user_workflow_triggers: ['DELETE'],
      workflow_approval_requests: ['SELECT', 'UPDATE'],
      workflow_recipe_allowed_teams: ['DELETE'],
      workflow_run_steps: ['INSERT', 'SELECT', 'UPDATE'],
      workflow_runs: ['SELECT', 'UPDATE'],
      workflow_schedules: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    }
    for (const [relation, actual] of Object.entries(wrcRelations)) {
      expectPrivileges([...actual], expectedWrcRelations[relation] ?? [])
    }

    const cleanupPredicateColumns = await dbPool.query<{
      table_name: string
      recipe_namespace: boolean
      recipe_name: boolean
    }>(
      `
      SELECT relation.relname AS table_name,
             has_column_privilege(
               'workflow_recipes_runtime', relation.oid, 'recipe_namespace', 'SELECT'
             ) AS recipe_namespace,
             has_column_privilege(
               'workflow_recipes_runtime', relation.oid, 'recipe_name', 'SELECT'
             ) AS recipe_name
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])
       ORDER BY relation.relname
    `,
      [['team_workflow_triggers', 'user_workflow_triggers', 'workflow_recipe_allowed_teams']]
    )
    expect(cleanupPredicateColumns.rows).toEqual([
      { table_name: 'team_workflow_triggers', recipe_namespace: true, recipe_name: true },
      { table_name: 'user_workflow_triggers', recipe_namespace: true, recipe_name: true },
      {
        table_name: 'workflow_recipe_allowed_teams',
        recipe_namespace: true,
        recipe_name: true,
      },
    ])

    const cleanupUserId = randomUUID()
    const cleanupTeamId = randomUUID()
    await dbPool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      cleanupUserId,
      `runtime-cleanup-${cleanupUserId}@example.test`,
    ])
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Runtime cleanup test')`, [
      cleanupTeamId,
    ])
    await dbPool.query(
      `INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupUserId]
    )
    await dbPool.query(
      `INSERT INTO team_workflow_triggers (team_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupTeamId]
    )
    await dbPool.query(
      `INSERT INTO workflow_recipe_allowed_teams (team_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupTeamId]
    )

    const cleanupClient = await dbPool.connect()
    try {
      await cleanupClient.query('BEGIN')
      await cleanupClient.query('SET LOCAL ROLE workflow_recipes_runtime')
      for (const table of [
        'user_workflow_triggers',
        'team_workflow_triggers',
        'workflow_recipe_allowed_teams',
      ]) {
        const result = await cleanupClient.query(
          `DELETE FROM ${table}
            WHERE recipe_namespace = $1 AND recipe_name = $2`,
          ['sandbox-recipes', 'runtime-cleanup-test']
        )
        expect(result.rowCount).toBe(1)
      }
      await cleanupClient.query('ROLLBACK')
    } catch (error) {
      await cleanupClient.query('ROLLBACK')
      throw error
    } finally {
      cleanupClient.release()
    }

    const sequenceAccess = await dbPool.query<{ violations: string }>(`
      SELECT COALESCE(string_agg(sequence.relname, ',' ORDER BY sequence.relname), '') AS violations
        FROM pg_class sequence
        JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
       WHERE namespace.nspname = 'public'
         AND sequence.relkind = 'S'
         AND (
           has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'USAGE')
           OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'SELECT')
           OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'UPDATE')
         )
    `)
    expect(sequenceAccess.rows[0]?.violations).toBe('')

    const functionAccess = await dbPool.query<{ violations: string }>(`
      SELECT COALESCE(string_agg(routine.oid::regprocedure::text, ',' ORDER BY routine.oid::regprocedure::text), '') AS violations
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
         AND routine.proname LIKE 'governed_trace_%'
         AND has_function_privilege('workflow_recipes_runtime', routine.oid, 'EXECUTE')
    `)
    expect(functionAccess.rows[0]?.violations).toBe('')

    const traceService = new AgentRunEventService({
      transaction: async () => {
        throw new Error('integration fixture supplies the transaction explicitly')
      },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })
    const tracePrincipal = {
      kind: 'mcp_host_runtime' as const,
      sourceService: 'mcp-host',
      serviceSub: 'retention-integration-host',
      credentialId: 'integration-fixture',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'retention-integration',
      hostRefs: ['retention-integration-host'],
      allowedEventTypes: ['run_start', 'approval'] as const,
    }
    const expiredEntries = Array.from({ length: 1_001 }, (_, index) => ({
      binding: {
        runId: randomUUID(),
        sessionId: null,
        spanId: `retention-root-${index}`,
        parentSpanId: null,
        origin: 'api' as const,
        identityIssuer: null,
        actorHumanSub: null,
        agentSub: 'mcp-host:retention-integration-host',
        actorMedium: 'api',
        resourceAud: null,
        effectiveScopes: [] as string[],
        decision: 'not_applicable' as const,
        decisionSourceKind: null,
        decisionSourceRef: null,
        approvalRequestId: null,
        tokenExchangeId: null,
        environment: 'integration',
        tenantId: null,
        teamId: null,
        userId: null,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'retention-integration',
        hostRef: 'retention-integration-host',
        outcome: 'started' as const,
        durationMs: null,
      },
      input: {
        sourceEventId: randomUUID(),
        occurredAt: '2025-01-01T00:00:00.000Z',
        eventType: 'run_start' as const,
      },
    }))

    const expiredEventIds: string[] = []
    for (let offset = 0; offset < expiredEntries.length; offset += 100) {
      const appendClient = await dbPool.connect()
      try {
        await appendClient.query('BEGIN')
        const appended = await traceService.appendManyInTransaction(
          appendClient,
          tracePrincipal,
          expiredEntries.slice(offset, offset + 100)
        )
        expiredEventIds.push(...appended.map(event => event.eventId))
        await appendClient.query('COMMIT')
      } catch (error) {
        await appendClient.query('ROLLBACK')
        throw error
      } finally {
        appendClient.release()
      }
    }

    async function runRetentionWake() {
      const maintenanceClient = await dbPool.connect()
      try {
        await maintenanceClient.query('BEGIN')
        await maintenanceClient.query('SET LOCAL ROLE trace_maintenance_runtime')
        const result = await runRetentionBatch(maintenanceClient)
        await maintenanceClient.query('COMMIT')
        return result
      } catch (error) {
        await maintenanceClient.query('ROLLBACK')
        throw error
      } finally {
        maintenanceClient.release()
      }
    }

    await expect(runRetentionWake()).resolves.toEqual({
      eventsDeleted: 1_000,
      costsDeleted: 0,
      promptsDeleted: 0,
      saturatedGrains: ['agent_run'],
    })
    const retainedAfterFirstBatch = await dbPool.query<{
      family_count: string
      stream_count: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text
           FROM agent_run_events
          WHERE event_id = ANY($1::uuid[])) AS family_count,
        (SELECT COUNT(*)::text
           FROM governed_event_stream
          WHERE event_family = 'agent_run'
            AND event_id = ANY($1::uuid[])) AS stream_count
    `,
      [expiredEventIds]
    )
    expect(retainedAfterFirstBatch.rows[0]).toEqual({ family_count: '1', stream_count: '1' })
    await expect(runRetentionWake()).resolves.toEqual({
      eventsDeleted: 1,
      costsDeleted: 0,
      promptsDeleted: 0,
      saturatedGrains: [],
    })
    const retainedAfterSecondBatch = await dbPool.query<{
      family_count: string
      stream_count: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text
           FROM agent_run_events
          WHERE event_id = ANY($1::uuid[])) AS family_count,
        (SELECT COUNT(*)::text
           FROM governed_event_stream
          WHERE event_family = 'agent_run'
            AND event_id = ANY($1::uuid[])) AS stream_count
    `,
      [expiredEventIds]
    )
    expect(retainedAfterSecondBatch.rows[0]).toEqual({ family_count: '0', stream_count: '0' })

    const recentClient = await dbPool.connect()
    let recentEventId = ''
    try {
      await recentClient.query('BEGIN')
      const recentBinding = {
        ...expiredEntries[0]!.binding,
        runId: randomUUID(),
        spanId: 'append-only-trigger-root',
      }
      const recent = await traceService.appendInTransaction(
        recentClient,
        tracePrincipal,
        recentBinding,
        {
          sourceEventId: randomUUID(),
          occurredAt: '2026-07-13T00:00:00.000Z',
          eventType: 'run_start',
        }
      )
      recentEventId = recent.eventId
      const approvalSourceEventId = 'task:integration:approval:request-1:approved'
      const approval = await traceService.appendInTransaction(
        recentClient,
        tracePrincipal,
        {
          ...recentBinding,
          spanId: 'append-only-trigger-approval',
          parentSpanId: recentBinding.spanId,
          decision: 'allow',
          decisionSourceKind: 'legacy_gate',
          decisionSourceRef: approvalSourceEventId,
          outcome: 'approved',
        },
        {
          sourceEventId: approvalSourceEventId,
          occurredAt: '2026-07-13T00:00:01.000Z',
          eventType: 'approval',
          payload: { status: 'approved' },
        }
      )
      await recentClient.query('COMMIT')

      const persistedApproval = await dbPool.query<{ decision_source_kind: string }>(
        'SELECT decision_source_kind FROM agent_run_events WHERE event_id = $1',
        [approval.eventId]
      )
      expect(persistedApproval.rows[0]?.decision_source_kind).toBe('legacy_gate')
    } catch (error) {
      await recentClient.query('ROLLBACK')
      throw error
    } finally {
      recentClient.release()
    }

    for (const operation of [
      {
        privilege: 'UPDATE',
        sql: 'UPDATE agent_run_events SET duration_ms = duration_ms WHERE event_id = $1',
        params: [recentEventId],
      },
      {
        privilege: 'DELETE',
        sql: 'DELETE FROM agent_run_events WHERE event_id = $1',
        params: [recentEventId],
      },
      {
        privilege: 'TRUNCATE',
        sql: 'TRUNCATE TABLE agent_run_events',
        params: [] as string[],
      },
    ]) {
      const mutationClient = await dbPool.connect()
      try {
        await mutationClient.query('BEGIN')
        await mutationClient.query(
          `GRANT ${operation.privilege} ON TABLE agent_run_events TO control_api_runtime`
        )
        await mutationClient.query('SET LOCAL ROLE control_api_runtime')
        await expect(mutationClient.query(operation.sql, operation.params)).rejects.toThrow(
          /append-only/
        )
      } finally {
        await mutationClient.query('ROLLBACK')
        mutationClient.release()
      }
    }

    const appendOnlyIntegrity = await dbPool.query<{ family_count: string; stream_count: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM agent_run_events WHERE event_id = $1) AS family_count,
         (SELECT COUNT(*)::text
            FROM governed_event_stream
           WHERE event_family = 'agent_run' AND event_id = $1) AS stream_count`,
      [recentEventId]
    )
    expect(appendOnlyIntegrity.rows[0]).toEqual({ family_count: '1', stream_count: '1' })

    const approvalRequestId = randomUUID()
    const workflowRunId = randomUUID()
    await dbPool.query(
      `INSERT INTO workflow_approval_requests (
         id, recipe_namespace, recipe_name, expires_at, status,
         target_user_id, payload, idempotency_key
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', NOW() + INTERVAL '1 hour',
                 'approved', $2, $3::jsonb, $4)`,
      [
        approvalRequestId,
        randomUUID(),
        JSON.stringify({
          metadata: {
            workflowTrigger: {
              providerBinding: {
                medium: 'telegram',
                providerChannelId: 'runtime-boundary-test',
              },
            },
          },
        }),
        `runtime-boundary-approval-${approvalRequestId}`,
      ]
    )
    await dbPool.query(
      `INSERT INTO workflow_approval_trigger_intents (
         approval_request_id, trigger_namespace, trigger_name, trigger_caller_key
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', 'integration-test')`,
      [approvalRequestId]
    )
    await dbPool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type,
         trigger_source, approval_request_id
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', 'Running',
                 'user', 'onDemand', $2)`,
      [workflowRunId, approvalRequestId]
    )

    const wrcClient = await dbPool.connect()
    try {
      await wrcClient.query('BEGIN')
      await wrcClient.query('SET LOCAL ROLE workflow_recipes_runtime')
      await wrcClient.query(
        `UPDATE workflow_runs
            SET phase = 'Succeeded', completed_at = NOW(), updated_at = NOW()
          WHERE run_id = $1`,
        [workflowRunId]
      )
      await wrcClient.query('COMMIT')
    } catch (error) {
      await wrcClient.query('ROLLBACK')
      throw error
    } finally {
      wrcClient.release()
    }

    const notification = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM notification_deliveries
        WHERE dedupe_key = $1`,
      [`workflow.run.completed:${workflowRunId}:Succeeded`]
    )
    expect(notification.rows[0]?.count).toBe('1')
  }, 60_000)

  it('authorizes and binds the canonical Host route with signed JWTs and persisted grants', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    const directUserId = randomUUID()
    const teamUserId = randomUUID()
    const deniedUserId = randomUUID()
    const teamId = randomUUID()
    const deniedTeamId = randomUUID()
    const hostRef = 'signed-jwt-host'
    await dbPool.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Direct Grant User'),
              ($3, $4, 'Team Grant User'),
              ($5, $6, 'Denied User')`,
      [
        directUserId,
        `direct-${directUserId}@example.test`,
        teamUserId,
        `team-${teamUserId}@example.test`,
        deniedUserId,
        `denied-${deniedUserId}@example.test`,
      ]
    )
    await dbPool.query(
      `INSERT INTO teams (id, name)
       VALUES ($1, 'Allowed Team'), ($2, 'Denied Team')`,
      [teamId, deniedTeamId]
    )
    await dbPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active'), ($3, $4, 'member', 'active')`,
      [teamId, teamUserId, deniedTeamId, deniedUserId]
    )
    await dbPool.query(`INSERT INTO user_agents (user_id, agent_name) VALUES ($1, $2)`, [
      directUserId,
      hostRef,
    ])
    await dbPool.query(`INSERT INTO team_agents (team_id, agent_name) VALUES ($1, $2)`, [
      teamId,
      hostRef,
    ])

    const bindingService = new DirectRunAttributionBindingService(async work => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    const gateway = {
      listResource: async (plural: string, namespace: string) => {
        expect(plural).toBe('hosts')
        expect(namespace).toBe(config.hostsNamespace)
        return [{ metadata: { name: hostRef }, spec: { enabled: true } }]
      },
    } as unknown as K8sGateway
    const app = express()
    app.use(
      createRpcAccessUsersRouter(gateway, {
        bindingService,
        directory: {
          getUserAgents: userId => getUserAgents(userId, dbPool),
          getCurrentTeam: (userId, resolvedTeamId) =>
            getCurrentTeam(userId, resolvedTeamId, dbPool),
          getTeamAgents: resolvedTeamId => getTeamAgents(resolvedTeamId, dbPool),
        },
      })
    )

    const tokenFor = (sub: string, resolvedTeamId: string) =>
      signRpcAccessToken({
        sub,
        typ: 'user',
        teamId: resolvedTeamId,
        role: 'member',
        scopes: ['host:message:invoke'],
        hostRefs: [hostRef],
        jti: randomUUID(),
      })
    const postBinding = (
      userId: string,
      token: string,
      runId: string,
      sessionId = `session-${runId}`
    ) =>
      request(app)
        .post(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
        .set('x-rpc-access-token', token)
        .send({ runId, sessionId, origin: 'direct_chat' })

    const directRunId = randomUUID()
    await postBinding(directUserId, tokenFor(directUserId, deniedTeamId), directRunId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          userId: directUserId,
          hostRef,
          bindingStatus: 'recorded',
        })
      })

    await postBinding(
      directUserId,
      tokenFor(directUserId, deniedTeamId),
      directRunId,
      `conflicting-session-${directRunId}`
    )
      .expect(409)
      .expect({ error: 'direct_run_binding_conflict' })

    const teamRunId = randomUUID()
    await postBinding(teamUserId, tokenFor(teamUserId, teamId), teamRunId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          userId: teamUserId,
          hostRef,
          bindingStatus: 'recorded',
        })
      })

    const deniedRunId = randomUUID()
    await postBinding(deniedUserId, tokenFor(deniedUserId, deniedTeamId), deniedRunId).expect(403)

    await dbPool.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamId, teamUserId]
    )
    const staleTeamRunId = randomUUID()
    await postBinding(teamUserId, tokenFor(teamUserId, teamId), staleTeamRunId).expect(403)

    const persisted = await dbPool.query<{
      run_id: string
      actor_human_sub: string
      user_id: string
      team_id: string
    }>(
      `SELECT run_id::text, actor_human_sub, user_id::text, team_id::text
         FROM governed_run_attribution_bindings
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id`,
      [[directRunId, teamRunId, deniedRunId, staleTeamRunId]]
    )
    expect(persisted.rows).toHaveLength(2)
    expect(persisted.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: directRunId,
          actor_human_sub: directUserId,
          user_id: directUserId,
          team_id: deniedTeamId,
        }),
        expect.objectContaining({
          run_id: teamRunId,
          actor_human_sub: teamUserId,
          user_id: teamUserId,
          team_id: teamId,
        }),
      ])
    )
  }, 60_000)

  it('enforces live membership states through real external routes and repository queries', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    const runtimeConnect = vi
      .spyOn(runtimePool, 'connect')
      .mockImplementation(() => dbPool.connect() as ReturnType<typeof runtimePool.connect>)
    const runtimeQuery = vi
      .spyOn(runtimePool, 'query')
      .mockImplementation((text: never, values?: never) => dbPool.query(text, values) as never)

    try {
      const userId = randomUUID()
      const teamId = randomUUID()
      const directAgent = `direct-${randomUUID()}`
      const directContext = `context-${randomUUID()}`
      const email = `live-auth-${userId}@example.test`
      await dbPool.query(
        `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Live Authorization User')`,
        [userId, email]
      )
      await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Live Authorization Team')`, [
        teamId,
      ])
      await dbPool.query(
        `INSERT INTO team_members (team_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')`,
        [teamId, userId]
      )
      await dbPool.query(`INSERT INTO user_agents (user_id, agent_name) VALUES ($1, $2)`, [
        userId,
        directAgent,
      ])
      await dbPool.query(`INSERT INTO user_contexts (user_id, context_id) VALUES ($1, $2)`, [
        userId,
        directContext,
      ])

      const sessionToken = signExternalSessionToken({
        userId,
        email,
        teamId,
        role: 'admin',
      })
      const gateway = {
        listResource: async (plural: string) =>
          plural === 'contexts'
            ? [{ metadata: { name: directContext }, spec: { contextId: directContext } }]
            : [],
        getResource: async (plural: string, name: string) => {
          if (plural === 'hosts' && name === directAgent) {
            return { metadata: { name, namespace: config.hostsNamespace }, spec: { enabled: true } }
          }
          throw Object.assign(new Error('not found'), { statusCode: 404 })
        },
      } as unknown as K8sGateway
      const app = express()
      app.use(express.json())
      app.use(requireInternalToken)
      app.use(createExternalAuthRouter(gateway))
      app.use(createExternalUsersRouter(gateway))
      app.use(createExternalTeamsRouter(gateway))
      app.use(createExternalDirectoryRouter())
      const authorized = (req: request.Test) =>
        req
          .set('authorization', 'Bearer dev-external-rest-api-token')
          .set('x-service-token', 'external-rest-api')
          .set('x-user-session-token', sessionToken)

      await authorized(
        request(app).get(`/external/teams/${teamId}/users/${userId}/current`)
      ).expect(200)
      await authorized(request(app).put(`/external/teams/${teamId}/name`))
        .send({ userId, name: 'Admin Rename' })
        .expect(200)

      await dbPool.query(
        `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId]
      )
      await authorized(request(app).put(`/external/teams/${teamId}/name`))
        .send({ userId, name: 'Stale Admin Rename' })
        .expect(403)
        .expect({ error: 'team_role_insufficient' })
      const unchanged = await dbPool.query<{ name: string }>(
        `SELECT name FROM teams WHERE id = $1`,
        [teamId]
      )
      expect(unchanged.rows[0]?.name).toBe('Admin Rename')

      await dbPool.query(
        `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId]
      )
      await authorized(request(app).get(`/external/teams/${teamId}/members`))
        .expect(403)
        .expect({ error: 'team_membership_inactive' })
      await authorized(request(app).get(`/external/directory/search?teamId=${teamId}&q=user`))
        .expect(403)
        .expect({ error: 'team_membership_inactive' })

      await authorized(request(app).get(`/external/users/${userId}/agents`)).expect(200)
      await authorized(request(app).get(`/external/users/${userId}/contexts`)).expect(200)
      const rpcResponse = await authorized(request(app).post('/external/rpc/token'))
        .send({
          sessionToken,
          scopes: ['host:message:invoke'],
          hostRefs: [directAgent],
        })
        .expect(200)
      expect(verifyRpcAccessToken(rpcResponse.body.token)).toMatchObject({
        sub: userId,
        accessScope: 'user',
        teamId: null,
        hostRefs: [directAgent],
      })

      const invitationCases = [
        { label: 'pending', status: 'pending', expires: '48 hours' },
        { label: 'rejected', status: 'revoked', expires: '48 hours' },
        { label: 'expired', status: 'pending', expires: '-1 hour' },
      ] as const
      for (const invitationCase of invitationCases) {
        const invitationTeamId = randomUUID()
        const invitationEmail = `${invitationCase.label}-${randomUUID()}@example.test`
        await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [
          invitationTeamId,
          `${invitationCase.label} invitation team`,
        ])
        await dbPool.query(
          `INSERT INTO invitations (team_id, email, role, status, expires_at)
           VALUES ($1, $2, 'admin', $3, NOW() + $4::interval)`,
          [invitationTeamId, invitationEmail, invitationCase.status, invitationCase.expires]
        )

        const login = await googleLoginData({ email: invitationEmail, name: 'Invitee' })
        expect(login.membership).toEqual({ team_id: null, role: 'member', team_name: null })
        const teamlessToken = signExternalSessionToken({
          userId: login.user.id,
          email: invitationEmail,
          teamId: null,
          role: 'member',
        })
        await request(app)
          .get(`/external/teams/${invitationTeamId}/members`)
          .set('authorization', 'Bearer dev-external-rest-api-token')
          .set('x-service-token', 'external-rest-api')
          .set('x-user-session-token', teamlessToken)
          .expect(403)
          .expect({ error: 'team_context_mismatch' })
      }
    } finally {
      runtimeQuery.mockRestore()
      runtimeConnect.mockRestore()
    }
  }, 60_000)

  it('executes the GFS audit append against the real migrated schema', async () => {
    const auditId = await auditMutation(dbPool, {
      actorKey: 'operator:',
      targetKey: 'host:1st:mcp-host/chatllm',
      op: 'grant.put[read]',
      drive: 'main',
      resourceId: randomUUID(),
      outcome: 'allowed',
      requestId: 'real-pg-gfs-audit',
    })

    expect(auditId).toMatch(/^\d+$/)
    const stored = await dbPool.query<{ sequence_no: string; subject: string }>(
      `SELECT sequence_no::text, subject
         FROM gfs_audit
        WHERE sequence_no = $1::bigint`,
      [auditId]
    )
    expect(stored.rows).toEqual([{ sequence_no: auditId, subject: 'host:1st:mcp-host/chatllm' }])
  })

  it('commits GFS grant/share batches atomically and invalidates only after commit', async () => {
    const operator = await dbPool.query<{ id: string }>(
      `SELECT id::text FROM control_admin_users
        WHERE status = 'active' ORDER BY created_at, id LIMIT 1`
    )
    const operatorId = operator.rows[0]!.id
    const shareUserId = randomUUID()
    const shareTeamId = randomUUID()
    await dbPool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Issue 792 Share User')`,
      [shareUserId, `issue792-share-${shareUserId}@example.test`]
    )
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Issue 792 Share Team')`, [
      shareTeamId,
    ])
    const listener = await dbPool.connect()
    const notifications: string[] = []
    listener.on('notification', message => {
      if (message.channel === 'gfs_perm_invalidate') notifications.push(message.channel)
    })
    await listener.query('LISTEN gfs_perm_invalidate')

    type BatchCase = {
      kind: 'grant' | 'share'
      table: 'gfs_grants' | 'gfs_shares'
      targets: readonly GfsSubject[]
      write: (
        client: PoolClient,
        params: { req: ExpressRequest; drive: string; resourceId: string }
      ) => Promise<{ error: unknown }>
    }
    const caller = {
      isOperator: true,
      subjects: new Set(['operator:']),
      actorKey: 'operator:',
    }
    const cases: BatchCase[] = [
      {
        kind: 'grant',
        table: 'gfs_grants',
        targets: Array.from({ length: 3 }, () => ({
          type: 'host' as const,
          id: `1st:mcp-host/bulk-${randomUUID()}`,
        })),
        write: (client, params) =>
          writeGfsGrantBatchInTransaction(client, {
            ...params,
            caller,
            subjects: cases[0]!.targets,
            permissions: ['read'],
            inherit: false,
          }),
      },
      {
        kind: 'share',
        table: 'gfs_shares',
        targets: [
          { type: 'user', id: shareUserId },
          { type: 'team', id: shareTeamId },
        ],
        write: (client, params) =>
          writeGfsShareBatchInTransaction(client, {
            ...params,
            caller,
            subjects: cases[1]!.targets,
            permissions: ['read'],
            includeDescendants: true,
          }),
      },
    ]
    const createResource = async (drive: string): Promise<string> => {
      const resourceId = randomUUID()
      await dbPool.query(
        `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
         VALUES ($1, $2, '/', 'directory', '/')`,
        [resourceId, drive]
      )
      return resourceId
    }
    const runBatch = async (
      batchCase: BatchCase,
      resourceId: string,
      drive: string,
      requestId: string,
      beforeCommit?: (client: PoolClient) => Promise<void>
    ): Promise<void> => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        const req = {
          adminAuth: { sub: operatorId },
          correlationId: requestId,
          ip: '127.0.0.1',
        } as unknown as ExpressRequest
        const result = await batchCase.write(client, {
          req,
          drive,
          resourceId,
        })
        expect(result.error).toBeNull()
        await beforeCommit?.(client)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    const counts = async (
      batchCase: BatchCase,
      resourceId: string,
      requestId: string
    ): Promise<{ mutations: string; audits: string; events: string }> => {
      const result = await dbPool.query<{ mutations: string; audits: string; events: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM ${batchCase.table}
             WHERE resource_id = $1::uuid) AS mutations,
           (SELECT COUNT(*)::text FROM gfs_audit WHERE request_id = $2) AS audits,
           (SELECT COUNT(*)::text FROM administrative_events WHERE request_id = $2) AS events`,
        [resourceId, requestId]
      )
      return result.rows[0]!
    }
    const settleListener = async (): Promise<void> => {
      await listener.query('SELECT 1')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const waitForInvalidationCount = async (count: number): Promise<void> => {
      if (notifications.length >= count) return
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listener.off('notification', onNotification)
          reject(new Error('timed out waiting for GFS invalidation'))
        }, 2_000)
        const onNotification = (): void => {
          if (notifications.length < count) return
          clearTimeout(timeout)
          listener.off('notification', onNotification)
          resolve()
        }
        listener.on('notification', onNotification)
      })
    }

    try {
      let committedNotificationCount = 0
      for (const batchCase of cases) {
        const targetCount = String(batchCase.targets.length)
        const committedDrive = `issue792-${batchCase.kind}-commit-${randomUUID()}`
        const committedResourceId = await createResource(committedDrive)
        const committedRequestId = `issue792-${batchCase.kind}-commit-${randomUUID()}`
        await runBatch(
          batchCase,
          committedResourceId,
          committedDrive,
          committedRequestId,
          async client => {
            const inside = await client.query<{
              mutations: string
              audits: string
              events: string
            }>(
              `SELECT
                 (SELECT COUNT(*)::text FROM ${batchCase.table}
                   WHERE resource_id = $1::uuid) AS mutations,
                 (SELECT COUNT(*)::text FROM gfs_audit WHERE request_id = $2) AS audits,
                 (SELECT COUNT(*)::text FROM administrative_events
                   WHERE request_id = $2) AS events`,
              [committedResourceId, committedRequestId]
            )
            expect(inside.rows[0]).toEqual({
              mutations: targetCount,
              audits: targetCount,
              events: targetCount,
            })
            expect(notifications).toHaveLength(committedNotificationCount)
          }
        )
        committedNotificationCount += 1
        await waitForInvalidationCount(committedNotificationCount)
        expect(await counts(batchCase, committedResourceId, committedRequestId)).toEqual({
          mutations: targetCount,
          audits: targetCount,
          events: targetCount,
        })
        expect(notifications).toHaveLength(committedNotificationCount)

        for (const failure of [
          { stage: 'audit', table: 'gfs_audit' },
          { stage: 'event', table: 'administrative_events' },
        ] as const) {
          const requestId = `issue792-${batchCase.kind}-${failure.stage}-failure-${randomUUID()}`
          const functionName = `issue792_fail_${batchCase.kind}_${failure.stage}`
          const triggerName = `${functionName}_trigger`
          await dbPool.query(
            `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
               LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.request_id = '${requestId}' THEN
                 RAISE EXCEPTION
                   'injected issue 792 ${batchCase.kind} ${failure.stage} failure';
               END IF;
               RETURN NEW;
             END;
             $$;
             CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${failure.table}
               FOR EACH ROW EXECUTE FUNCTION ${functionName}();`
          )
          const drive = `issue792-${batchCase.kind}-${failure.stage}-${randomUUID()}`
          const resourceId = await createResource(drive)
          try {
            await expect(runBatch(batchCase, resourceId, drive, requestId)).rejects.toThrow(
              `injected issue 792 ${batchCase.kind} ${failure.stage} failure`
            )
          } finally {
            await dbPool.query(
              `DROP TRIGGER IF EXISTS ${triggerName} ON ${failure.table};
               DROP FUNCTION IF EXISTS ${functionName}();`
            )
          }
          await settleListener()
          expect(await counts(batchCase, resourceId, requestId)).toEqual({
            mutations: '0',
            audits: '0',
            events: '0',
          })
          expect(notifications).toHaveLength(committedNotificationCount)
        }
      }
    } finally {
      await listener.query('UNLISTEN gfs_perm_invalidate')
      listener.release()
    }
  }, 60_000)

  it('resolves host intent tenant attribution from the canonical event stream', async () => {
    const operationId = randomUUID()
    const eventId = randomUUID()
    const operatorSub = randomUUID()
    const targetRef = 'mcp-host/tenant-stream-host'
    const namespace = 'mcp-host'
    const occurredAt = '2026-07-16T12:00:00.000Z'
    const service = new AdministrativeEventService({
      transaction: async work => {
        const client = await dbPool.connect()
        try {
          await client.query('BEGIN')
          const result = await work(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      now: () => new Date(occurredAt),
      newEventId: () => eventId,
    })

    await service.append(
      {
        kind: 'control_api_local',
        sourceService: 'control-api',
        serviceSub: 'host-administration',
        credentialId: 'control-api-local',
        allowedKinds: ['intent'],
      },
      {
        action: 'host_mutation',
        outcome: 'attempted',
        operatorSub,
        operationId,
        relatedRunId: null,
        requestId: 'real-pg-host-intent-tenant',
        targetType: 'host',
        targetRef,
        environment: 'test',
        tenantId: 'tenant-real-pg',
        teamId: 'team-real-pg',
        namespace,
        sourceAuditRef: null,
      },
      {
        kind: 'intent',
        sourceEventId: `real-pg-host-intent:${operationId}`,
        occurredAt,
        reasonCode: 'host_update_requested',
        payload: { resource_class: 'Host', status: 'requested' },
      }
    )

    const schemaContract = await dbPool.query<{
      tenant_nullable_without_default: boolean
      canonical_unique: boolean
      administrative_trigger: boolean
      stream_trigger: boolean
    }>(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'governed_event_stream'
           AND column_name = 'tenant_id'
           AND data_type = 'text'
           AND is_nullable = 'YES'
           AND column_default IS NULL
      ) AS tenant_nullable_without_default,
      EXISTS (
        SELECT 1
          FROM pg_constraint relation_constraint
         WHERE relation_constraint.conrelid = 'public.governed_event_stream'::regclass
           AND relation_constraint.contype = 'u'
           AND relation_constraint.conkey = ARRAY[
             (SELECT attnum
                FROM pg_attribute
               WHERE attrelid = relation_constraint.conrelid
                 AND attname = 'event_family'),
             (SELECT attnum
                FROM pg_attribute
               WHERE attrelid = relation_constraint.conrelid
                 AND attname = 'event_id')
           ]::smallint[]
      ) AS canonical_unique,
      EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'public.administrative_events'::regclass
           AND tgname = 'governed_administrative_event_stream_integrity'
           AND tgenabled = 'O'
           AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
           AND tgconstraint <> 0
           AND tgdeferrable
           AND tginitdeferred
           AND tgtype = 13
      ) AS administrative_trigger,
      EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'public.governed_event_stream'::regclass
           AND tgname = 'governed_event_stream_family_integrity'
           AND tgenabled = 'O'
           AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
           AND tgconstraint <> 0
           AND tgdeferrable
           AND tginitdeferred
           AND tgtype = 13
      ) AS stream_trigger
    `)
    expect(schemaContract.rows).toEqual([
      {
        tenant_nullable_without_default: true,
        canonical_unique: true,
        administrative_trigger: true,
        stream_trigger: true,
      },
    ])

    const runtimeClient = await dbPool.connect()
    try {
      await runtimeClient.query('BEGIN')
      await runtimeClient.query('SET LOCAL ROLE control_api_runtime')
      const activeRole = await runtimeClient.query<{ current_user: string }>('SELECT current_user')
      expect(activeRole.rows).toEqual([{ current_user: 'control_api_runtime' }])

      const lookup = new PostgresAdministrativeIntentLookup(runtimeClient)
      await expect(lookup.findHostIntent({ operationId, targetRef, namespace })).resolves.toEqual(
        expect.objectContaining({
          operatorSub,
          requestId: 'real-pg-host-intent-tenant',
          environment: 'test',
          tenantId: 'tenant-real-pg',
          teamId: 'team-real-pg',
        })
      )
    } finally {
      await runtimeClient.query('ROLLBACK')
      runtimeClient.release()
    }
  })

  it('persists permission changes and governed administrative identity atomically', async () => {
    const operator = await dbPool.query<{ id: string; username: string }>(
      `SELECT id::text, username
         FROM control_admin_users
        WHERE status = 'active'
     ORDER BY created_at, id
        LIMIT 1`
    )
    const operatorId = operator.rows[0]!.id
    const operatorName = operator.rows[0]!.username
    const targetUserId = randomUUID()
    await dbPool.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Trace Target')`,
      [targetUserId, `trace-target-${targetUserId}@example.test`]
    )
    await dbPool.query(
      `INSERT INTO profiles (user_id, display_name)
       VALUES ($1, 'Trace Target')`,
      [targetUserId]
    )

    const committedOperationId = randomUUID()
    const committed = await dbPool.connect()
    try {
      await committed.query('BEGIN')
      await committed.query(
        `INSERT INTO user_agents (user_id, agent_name) VALUES ($1, 'trace-integration-agent')`,
        [targetUserId]
      )
      await runWithAdministrativeRequestContext(
        { operatorSub: operatorId, requestId: 'real-pg-permission-commit' },
        () =>
          appendControlApiPermissionEventsInTransaction(committed, {
            operatorSub: operatorId,
            operationId: committedOperationId,
            changes: [
              {
                action: 'grant',
                resourceClass: 'agent_access',
                resourceRef: 'agent:trace-integration-agent',
                subject: { kind: 'user', id: targetUserId },
              },
            ],
          })
      )
      await committed.query('COMMIT')
    } catch (error) {
      await committed.query('ROLLBACK')
      throw error
    } finally {
      committed.release()
    }

    const persisted = await dbPool.query<{
      action: string
      operator_user_id: string
      target_user_id: string
      operator_name: string
      target_name: string
      authorization_decision: string
      payload_metadata: Record<string, unknown>
      stream_sequence: string
    }>(
      `SELECT event.action,
              event.operator_user_id::text,
              event.target_user_id::text,
              operator_admin.username AS operator_name,
              target_profile.display_name AS target_name,
              event.authorization_decision,
              event.payload_metadata,
              stream.stream_sequence::text
         FROM administrative_events event
         JOIN governed_event_stream stream
           ON stream.event_family = 'administrative' AND stream.event_id = event.event_id
         JOIN control_admin_users operator_admin ON operator_admin.id = event.operator_user_id
         JOIN profiles target_profile ON target_profile.user_id = event.target_user_id
        WHERE event.operation_id = $1`,
      [committedOperationId]
    )
    expect(persisted.rows).toEqual([
      expect.objectContaining({
        action: 'permission_grant',
        operator_user_id: operatorId,
        target_user_id: targetUserId,
        operator_name: operatorName,
        target_name: 'Trace Target',
        authorization_decision: 'allow',
        payload_metadata: expect.objectContaining({
          resource_class: 'agent_access',
          status: 'granted',
        }),
        stream_sequence: expect.stringMatching(/^[1-9][0-9]*$/),
      }),
    ])

    const readRepository = new PostgresGovernedEventReadRepository(dbPool)
    const highWatermark = await readRepository.captureHighWatermark()
    const readRows = await readRepository.readAfter({
      scope: { kind: 'stream' },
      families: ['administrative'],
      order: 'oldest',
      afterSequence: '0',
      highWatermark,
      limit: 200,
      occurredFrom: null,
      occurredTo: null,
      filters: {
        action: ['permission_grant'],
        targetUserId: [targetUserId],
      },
    })
    expect(readRows).toEqual([
      expect.objectContaining({
        eventType: 'permission_grant',
        operatorPrincipalId: operatorId,
        operatorPrincipalKind: 'control_admin',
        operatorDisplayName: operatorName,
        targetUserId,
        targetUserDisplayName: 'Trace Target',
        teamId: null,
        payload: expect.objectContaining({ resource_class: 'agent_access' }),
      }),
    ])

    const targetTeamId = randomUUID()
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Trace Operations')`, [
      targetTeamId,
    ])
    const teamOperationId = randomUUID()
    const teamChange = await dbPool.connect()
    try {
      await teamChange.query('BEGIN')
      await appendControlApiPermissionEventsInTransaction(teamChange, {
        operatorSub: operatorId,
        operatorKind: 'control_admin',
        operationId: teamOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'workflow_approval_target',
            resourceRef: 'workflow_recipe:sandbox-recipes/trace-team-target',
            subject: { kind: 'team', id: targetTeamId },
          },
        ],
      })
      await teamChange.query('COMMIT')
    } catch (error) {
      await teamChange.query('ROLLBACK')
      throw error
    } finally {
      teamChange.release()
    }
    const teamRows = await readRepository.readAfter({
      scope: { kind: 'stream' },
      families: ['administrative'],
      order: 'oldest',
      afterSequence: '0',
      highWatermark: await readRepository.captureHighWatermark(),
      limit: 200,
      occurredFrom: null,
      occurredTo: null,
      filters: { teamId: [targetTeamId] },
    })
    expect(teamRows).toEqual([
      expect.objectContaining({
        eventType: 'permission_grant',
        teamId: targetTeamId,
        targetTeamDisplayName: 'Trace Operations',
        targetUserId: null,
      }),
    ])

    const hostOperationId = randomUUID()
    const hostChange = await dbPool.connect()
    try {
      await hostChange.query('BEGIN')
      await appendControlApiPermissionEventsInTransaction(hostChange, {
        operatorSub: operatorId,
        operatorKind: 'control_admin',
        operationId: hostOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'gfs_folder_grant',
            resourceRef: 'gfs://main/trace-host-target',
            subject: {
              kind: 'service',
              id: 'host:1st:mcp-host/chatllm',
              principalKind: 'host',
            },
          },
        ],
      })
      await hostChange.query('COMMIT')
    } catch (error) {
      await hostChange.query('ROLLBACK')
      throw error
    } finally {
      hostChange.release()
    }
    const hostTarget = await dbPool.query<{ payload_metadata: Record<string, unknown> }>(
      `SELECT payload_metadata
         FROM administrative_events
        WHERE operation_id = $1`,
      [hostOperationId]
    )
    expect(hostTarget.rows).toEqual([
      {
        payload_metadata: expect.objectContaining({
          target_principal_kind: 'host',
          target_principal_ref: 'host:1st:mcp-host/chatllm',
        }),
      },
    ])

    const deletedAdminId = randomUUID()
    const deletionOperationId = randomUUID()
    const deletionEventId = randomUUID()
    const deletion = await dbPool.connect()
    try {
      await deletion.query('BEGIN')
      const service = new AdministrativeEventService({
        transaction: async () => {
          throw new Error('real PostgreSQL deletion event must use the caller transaction')
        },
        now: () => new Date('2026-07-14T12:00:00.000Z'),
        newEventId: () => deletionEventId,
      })
      await service.appendInTransaction(
        deletion,
        CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
        {
          action: 'control_admin_deleted',
          outcome: 'committed',
          operatorSub: operatorId,
          operatorUserId: operatorId,
          operationId: deletionOperationId,
          relatedRunId: null,
          requestId: 'real-pg-control-admin-delete',
          targetType: 'control_admin',
          targetRef: `control_admin:${deletedAdminId}`,
          environment: 'test',
          tenantId: null,
          teamId: null,
          namespace: null,
          sourceAuditRef: `control_admin_deletion_audit:${deletionOperationId}`,
          identityIssuer: config.adminJwtIssuer,
          resourceAud: config.adminJwtAudience,
          effectiveScopes: [],
          authorizationDecision: 'allow',
          decisionActorSub: operatorId,
          targetIdentityIssuer: config.adminJwtIssuer,
          targetHumanSub: deletedAdminId,
          targetUserId: null,
        },
        {
          kind: 'service_action',
          sourceEventId: `control_admin_deletion_audit:${deletionOperationId}`,
          occurredAt: '2026-07-14T12:00:00.000Z',
          reasonCode: 'control_admin_access_revoked',
          payload: {
            resource_class: 'control_admin_access',
            status: 'revoked',
            target_label: 'deleted_admin',
          },
        }
      )
      await deletion.query('COMMIT')
    } catch (error) {
      await deletion.query('ROLLBACK')
      throw error
    } finally {
      deletion.release()
    }
    const deletedAdminEvent = await dbPool.query<{
      action: string
      target_type: string
      target_human_sub: string
      target_label: string
      stream_count: string
    }>(
      `SELECT event.action,
              event.target_type,
              event.target_human_sub,
              event.payload_metadata->>'target_label' AS target_label,
              COUNT(stream.event_id)::text AS stream_count
         FROM administrative_events event
         JOIN governed_event_stream stream
           ON stream.event_family = 'administrative' AND stream.event_id = event.event_id
        WHERE event.event_id = $1
        GROUP BY event.event_id`,
      [deletionEventId]
    )
    expect(deletedAdminEvent.rows).toEqual([
      {
        action: 'control_admin_deleted',
        target_type: 'control_admin',
        target_human_sub: deletedAdminId,
        target_label: 'deleted_admin',
        stream_count: '1',
      },
    ])

    const rolledBackOperationId = randomUUID()
    const rolledBack = await dbPool.connect()
    try {
      await rolledBack.query('BEGIN')
      await rolledBack.query(
        `INSERT INTO user_agents (user_id, agent_name) VALUES ($1, 'trace-rollback-agent')`,
        [targetUserId]
      )
      await appendControlApiPermissionEventsInTransaction(rolledBack, {
        operatorSub: operatorId,
        operationId: rolledBackOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'agent_access',
            resourceRef: 'agent:trace-rollback-agent',
            subject: { kind: 'user', id: targetUserId },
          },
        ],
      })
      await rolledBack.query('ROLLBACK')
    } finally {
      rolledBack.release()
    }
    const rollbackState = await dbPool.query<{ links: string; events: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM user_agents WHERE agent_name = 'trace-rollback-agent') AS links,
         (SELECT COUNT(*)::text FROM administrative_events WHERE operation_id = $1) AS events`,
      [rolledBackOperationId]
    )
    expect(rollbackState.rows[0]).toEqual({ links: '0', events: '0' })
  })

  it('keeps same-named tools from distinct kinds and sources separate', async () => {
    const runId = randomUUID()
    const hostRef = `tool-collision-${randomUUID()}`
    const sessionId = `session-${randomUUID()}`
    const toolName = 'shared-tool-name'
    const firstSourceEventId = randomUUID()
    const secondSourceEventId = randomUUID()

    await dbPool.query(
      `WITH fixture(source_event_id, idempotency_key, tool_kind, tool_source_ref,
                    payload_sha256, occurred_at) AS (
         VALUES
           ($4::text, $5::text, 'internal_tool'::text, 'mcp-host:internal'::text,
            $6::text, '2026-07-14T14:00:00.000Z'::timestamptz),
           ($7::text, $8::text, 'mcp_server_tool'::text, 'weather-server'::text,
            $9::text, '2026-07-14T14:00:01.000Z'::timestamptz)
       ), inserted AS (
         INSERT INTO agent_run_events (
           source_kind, source_service, source_event_id, idempotency_key, run_id, session_id,
           span_id, origin, event_type, outcome, agent_sub, effective_scopes, decision,
           host_ref, recipe_namespace, recipe_name, payload_metadata, payload_sha256, occurred_at
         )
         SELECT 'mcp_host_runtime', 'mcp-host', source_event_id, idempotency_key, $1::uuid, $2,
                'span-' || tool_kind, 'direct_chat', 'tool_call', 'succeeded',
                'mcp-host:' || $3, ARRAY[]::text[], 'not_applicable', $3,
                'mcp-host', 'standalone',
                jsonb_build_object(
                  'tool_name', $10::text,
                  'tool_kind', tool_kind,
                  'tool_source_ref', tool_source_ref
                ),
                payload_sha256, occurred_at
           FROM fixture
         RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
       )
       INSERT INTO governed_event_stream
         (event_family, event_id, schema_version, occurred_at, ingested_at,
          environment, run_id, payload_sha256)
       SELECT 'agent_run', event_id, 1, occurred_at, ingested_at,
              'integration', run_id, payload_sha256
         FROM inserted`,
      [
        runId,
        sessionId,
        hostRef,
        firstSourceEventId,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        secondSourceEventId,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        toolName,
      ]
    )

    const replay = new PostgresGovernedSessionReplayRepository(dbPool)
    const highWatermark = await replay.captureHighWatermark()

    await expect(replay.readTools(hostRef, sessionId, highWatermark)).resolves.toEqual([
      expect.objectContaining({
        toolName,
        toolKind: 'mcp_server_tool',
        toolSourceRef: 'weather-server',
        totalCalls: 1,
        succeeded: 1,
        failed: 0,
      }),
      expect.objectContaining({
        toolName,
        toolKind: 'internal_tool',
        toolSourceRef: 'mcp-host:internal',
        totalCalls: 1,
        succeeded: 1,
        failed: 0,
      }),
    ])
  })

  it('persists token usage atomically and serves session totals from the governed ledger', async () => {
    const runAsControlApiRuntime = async <T>(work: (client: PoolClient) => Promise<T>) => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    const bindingService = new DirectRunAttributionBindingService(runAsControlApiRuntime)
    const hostRef = 'runtime-token-persistence'
    const sessionId = 'session-token-persistence'
    const runId = randomUUID()
    await bindingService.bind({
      runId,
      hostRef,
      sessionId,
      origin: 'direct_chat',
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-token-persistence',
      userId: null,
      teamId: null,
    })

    const requestId = randomUUID()
    const rawUsage = {
      request_id: requestId,
      ts: '2026-07-14T15:00:00.000Z',
      run_id: runId,
      host_ref: hostRef,
      context_ref: 'not-released',
      team_id: null,
      provider: 'openai',
      model: 'gpt-5',
      llm_secret_name: 'not-released',
      source_kind: 'desktop',
      user_id: null,
      sender: 'not-released',
      channel_type: 'not-released',
      recipe_name: null,
      cron_job_id: null,
      task_id: null,
      iteration: 3,
      input_tokens: 321,
      output_tokens: 123,
      cache_read_tokens: 45,
      cache_write_tokens: 6,
    }
    const persistUsage = () =>
      runAsControlApiRuntime(async client => {
        const ingest = await ingestUsageEventsInTransaction([rawUsage], client)
        const projected = await projectAcceptedUsageEvents(
          client,
          ingest.acceptedEvents,
          new Map(),
          {
            recipeNamespace: 'mcp-host',
            recipeName: 'standalone',
            hostRef,
            environment: 'integration',
          }
        )
        return { ingest: ingest.result, projected }
      })

    await expect(persistUsage()).resolves.toEqual({
      ingest: { accepted: 1, duplicates: 0, rejected: 0 },
      projected: 1,
    })
    await expect(persistUsage()).resolves.toEqual({
      ingest: { accepted: 0, duplicates: 1, rejected: 0 },
      projected: 0,
    })

    const persisted = await dbPool.query<{
      usage_count: string
      family_count: string
      stream_count: string
      payload_metadata: Record<string, unknown>
      identity_issuer: string | null
      actor_human_sub: string | null
      session_id: string | null
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM usage_events WHERE request_id = $1::uuid) AS usage_count,
         (SELECT COUNT(*)::text FROM agent_run_events WHERE source_event_id = $1::text) AS family_count,
         (SELECT COUNT(*)::text
            FROM governed_event_stream stream
            JOIN agent_run_events event
              ON stream.event_family = 'agent_run' AND stream.event_id = event.event_id
           WHERE event.source_event_id = $1::text) AS stream_count,
         event.payload_metadata,
         event.identity_issuer,
         event.actor_human_sub,
         event.session_id
       FROM agent_run_events event
      WHERE event.source_event_id = $1::text`,
      [requestId]
    )
    expect(persisted.rows[0]).toMatchObject({
      usage_count: '1',
      family_count: '1',
      stream_count: '1',
      identity_issuer: 'https://issuer.example.test',
      actor_human_sub: 'subject-token-persistence',
      session_id: sessionId,
      payload_metadata: {
        provider: 'openai',
        model: 'gpt-5',
        source_kind: 'desktop',
        input_tokens: 321,
        output_tokens: 123,
        cache_read_tokens: 45,
        cache_write_tokens: 6,
        cache_tokens_reported: true,
        iteration: 3,
      },
    })
    expect(JSON.stringify(persisted.rows[0]?.payload_metadata)).not.toContain('not-released')

    const replay = new PostgresGovernedSessionReplayRepository(dbPool)
    const highWatermark = await replay.captureHighWatermark()
    const page = await replay.list({
      filters: {
        occurredFrom: '2026-07-14T14:59:00.000Z',
        occurredTo: '2026-07-14T15:01:00.000Z',
        outcome: [],
        sourceService: [],
        sessionId: [sessionId],
        hostRef: [hostRef],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: [],
        approvalState: [],
      },
      highWatermark,
      after: null,
      limit: 10,
      promptState: 'disabled',
    })
    expect(page.summaries).toHaveLength(1)
    expect(page.summaries[0]).toMatchObject({
      hostRef,
      sessionId,
      human: {
        status: 'verified',
        subject: 'subject-token-persistence',
        identityIssuer: 'https://issuer.example.test',
      },
      tokenUsage: {
        meteredCalls: 1,
        inputTokens: 321,
        outputTokens: 123,
        cacheReadTokens: 45,
        cacheWriteTokens: 6,
        cacheReporting: 'complete',
        totalTokens: 444,
      },
    })
    await expect(replay.readTokenUsagePoints(hostRef, sessionId, highWatermark)).resolves.toEqual({
      pointsTruncated: false,
      points: [
        expect.objectContaining({
          runId,
          provider: 'openai',
          model: 'gpt-5',
          sourceKind: 'desktop',
          iteration: 3,
          inputTokens: 321,
          outputTokens: 123,
          cacheReadTokens: 45,
          cacheWriteTokens: 6,
          cacheTokensReported: true,
        }),
      ],
    })

    const conflictingRunId = randomUUID()
    const conflictingRequestId = randomUUID()
    await bindingService.bind({
      runId: conflictingRunId,
      hostRef,
      sessionId: 'bound-session',
      origin: 'direct_chat',
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-token-persistence',
      userId: null,
      teamId: null,
    })
    const conflictingRootId = randomUUID()
    await dbPool.query(
      `WITH inserted AS (
         INSERT INTO agent_run_events (
           event_id, source_kind, source_service, source_event_id, idempotency_key,
           run_id, session_id, span_id, origin, event_type, outcome, agent_sub,
           effective_scopes, decision, host_ref, recipe_namespace, recipe_name,
           payload_metadata, payload_sha256, occurred_at
         ) VALUES (
           $1, 'mcp_host_runtime', 'mcp-host', $2, $3, $4, 'conflicting-session',
           $5, 'direct_chat', 'run_start', 'started', $6, ARRAY[]::text[],
           'not_applicable', $7, 'mcp-host', 'standalone', '{}'::jsonb, $8,
           '2026-07-14T15:02:00.000Z'
         )
         RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
       )
       INSERT INTO governed_event_stream (
         event_family, event_id, schema_version, occurred_at, ingested_at,
         environment, run_id, payload_sha256
       )
       SELECT 'agent_run', event_id, 1, occurred_at, ingested_at,
              'integration', run_id, payload_sha256
         FROM inserted`,
      [
        conflictingRootId,
        `conflicting-root-${conflictingRunId}`,
        'a'.repeat(64),
        conflictingRunId,
        'b'.repeat(64),
        `mcp-host:${hostRef}`,
        hostRef,
        'c'.repeat(64),
      ]
    )
    const conflictingUsage = {
      ...rawUsage,
      request_id: conflictingRequestId,
      run_id: conflictingRunId,
      ts: '2026-07-14T15:02:01.000Z',
    }
    await expect(
      runAsControlApiRuntime(async client => {
        const ingest = await ingestUsageEventsInTransaction([conflictingUsage], client)
        return projectAcceptedUsageEvents(client, ingest.acceptedEvents, new Map(), {
          recipeNamespace: 'mcp-host',
          recipeName: 'standalone',
          hostRef,
          environment: 'integration',
        })
      })
    ).rejects.toBeInstanceOf(DirectRunBindingConflictError)
    const rolledBack = await dbPool.query<{ usage_count: string; trace_count: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM usage_events WHERE request_id = $1::uuid) AS usage_count,
         (SELECT COUNT(*)::text FROM agent_run_events WHERE source_event_id = $1::text) AS trace_count`,
      [conflictingRequestId]
    )
    expect(rolledBack.rows[0]).toEqual({ usage_count: '0', trace_count: '0' })
  })
})

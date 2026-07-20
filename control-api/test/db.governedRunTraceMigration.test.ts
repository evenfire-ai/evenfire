import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_DECISION_SOURCE_KINDS,
  DECISION_SOURCE_KINDS,
  LEGACY_DECISION_SOURCE_KINDS,
} from '../src/services/tracing/contracts.js'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0061_governed_run_trace_schema_foundation migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('registers the governed ledgers, immutable stream, read view, and bounded retention path', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const migrationSql = sqls.find(sql =>
      sql.includes('CREATE TABLE IF NOT EXISTS agent_run_events')
    )
    expect(migrationSql).toBeDefined()

    for (const relation of [
      'agent_run_events',
      'administrative_events',
      'infrastructure_telemetry_events',
      'governed_event_stream',
      'infrastructure_price_snapshots',
      'infrastructure_cost_daily',
      'infrastructure_cost_daily_components',
    ]) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`)
      expect(migrationSql).toContain(`${relation}_append_only`)
      expect(migrationSql).toContain(`${relation}_no_truncate`)
    }

    expect(migrationSql).toContain(
      "event_family IN ('agent_run', 'administrative', 'infrastructure_telemetry')"
    )
    expect(migrationSql).toContain('UNIQUE (event_family, event_id)')
    expect(migrationSql).toContain('UNIQUE (source_service, source_kind, idempotency_key)')
    expect(migrationSql).toContain(
      "idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$')"
    )
    expect(migrationSql).toContain('idx_agent_run_events_wrc_lifecycle_once')
    expect(migrationSql).toContain(
      "span_id TEXT NOT NULL CHECK (span_id ~ '^[A-Za-z0-9._:-]{1,128}$')"
    )
    expect(migrationSql).toContain(
      "parent_span_id TEXT NULL CHECK (parent_span_id IS NULL OR parent_span_id ~ '^[A-Za-z0-9._:-]{1,128}$')"
    )
    expect(migrationSql).toContain("WHERE source_kind = 'wrc_internal_control'")
    expect(migrationSql).toContain("event_type IN ('run_start', 'run_end')")
    expect(migrationSql).toContain('governed_trace_assert_stream_integrity')
    expect(migrationSql).toContain('governed_trace_assert_cost_component_conservation')
    expect(migrationSql).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migrationSql).toContain('governed_trace_safe_metadata')
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS run_id UUID NULL')
    expect(migrationSql).toContain('governed_trace_safe_agent_run_metadata')
    expect(migrationSql).toContain(
      "value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown')"
    )
    expect(migrationSql).toContain("(value->>'input_tokens') ~ '^(0|[1-9][0-9]*)$'")
    expect(migrationSql).toContain(
      'governed_trace_safe_agent_run_metadata(event_type, payload_metadata)'
    )
    expect(migrationSql).toContain('governed_trace_sorted_unique_text_array')
    expect(migrationSql).toContain(
      "'run_start', 'run_end', 'llm_call', 'tool_call', 'approval', 'token_usage'"
    )
    expect(migrationSql).not.toContain("'llm_usage'")
    expect(migrationSql).not.toContain("'approval_decision'")
    expect(migrationSql).not.toContain("'usage_recorded'")
    expect(migrationSql).toContain("clock_timestamp() - INTERVAL '90 days'")
    expect(migrationSql).toContain("clock_timestamp() - INTERVAL '30 days'")
    expect(migrationSql).toContain('batch_limit NOT BETWEEN 1 AND 1000')
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) FROM PUBLIC'
    )
    expect(migrationSql).toContain('governed_trace.retention_delete')
    expect(migrationSql).toContain('SET search_path = public, pg_temp')
    expect(migrationSql).not.toContain(
      'CREATE OR REPLACE FUNCTION governed_trace_prune_expired_costs'
    )
    expect(migrationSql).not.toContain('CREATE ROLE control_api_runtime')
    expect(migrationSql).not.toContain('bound_workflow_run_id')
    expect(migrationSql).toContain('CREATE OR REPLACE VIEW governed_event_read_v1')
    expect(migrationSql).toContain('events.token_exchange_id::TEXT AS token_exchange_id')
    expect(migrationSql).toContain("valuation_kind IN ('estimated', 'billed')")
    expect(migrationSql).toContain(
      "selected_basis IN ('requested_capacity', 'measured_usage', 'gcp_request_allocation')"
    )
    expect(migrationSql).toContain('CHECK (net_amount = gross_amount + credits_amount)')

    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))
    expect(recordedVersions).toContain('0061_governed_run_trace_schema_foundation')
  })

  it('applies governed trace runtime roles as a separate additive migration', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const migrationSql = sqls.find(sql =>
      sql.includes("version: '0062_governed_trace_runtime_roles'")
    )
    expect(migrationSql).toBeUndefined()
    const runtimeRoleSql = sqls.find(sql =>
      sql.includes('CREATE ROLE control_api_runtime LOGIN NOSUPERUSER')
    )
    expect(runtimeRoleSql).toBeDefined()

    expect(runtimeRoleSql).toContain(
      'CREATE OR REPLACE FUNCTION governed_trace_prune_expired_costs'
    )
    expect(runtimeRoleSql).toContain(
      'REVOKE ALL ON FUNCTION governed_trace_prune_expired_costs(INTEGER) FROM PUBLIC'
    )
    expect(runtimeRoleSql).not.toContain('governed_trace.retention_delete')
    expect(runtimeRoleSql).not.toMatch(/\bPASSWORD\b/i)
    expect(runtimeRoleSql).not.toMatch(/ALTER FUNCTION .* OWNER/i)
    expect(runtimeRoleSql).toContain('SET search_path = pg_catalog, public')
    expect(runtimeRoleSql).toContain(
      'CREATE ROLE control_api_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(runtimeRoleSql).toContain(
      'CREATE ROLE trace_maintenance_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(runtimeRoleSql).toContain(
      'ALTER ROLE control_api_runtime\n          WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(runtimeRoleSql).toContain(
      'ALTER ROLE trace_maintenance_runtime\n          WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(runtimeRoleSql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE\n          agent_run_events'
    )
    expect(runtimeRoleSql).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE governed_event_read_v1 FROM control_api_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'GRANT SELECT, INSERT ON TABLE\n          agent_run_events,\n          administrative_events,\n          infrastructure_telemetry_events,\n          governed_event_stream\n          TO control_api_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'GRANT SELECT ON TABLE\n          infrastructure_price_snapshots,\n          infrastructure_cost_daily,\n          infrastructure_cost_daily_components\n          TO control_api_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'REVOKE ALL ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) FROM control_api_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'REVOKE ALL ON FUNCTION governed_trace_prune_expired_costs(INTEGER) FROM control_api_runtime'
    )

    expect(runtimeRoleSql).toContain(
      'REVOKE INSERT ON TABLE\n          infrastructure_price_snapshots'
    )
    expect(runtimeRoleSql).toContain(
      'infrastructure_price_snapshots,\n          infrastructure_cost_daily,\n          infrastructure_cost_daily_components\n          FROM control_api_runtime'
    )

    const migrationBoundarySql = sqls.find(sql =>
      sql.includes('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations')
    )
    expect(migrationBoundarySql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations\n          FROM control_api_runtime'
    )
    expect(migrationBoundarySql).toContain(
      'GRANT SELECT ON TABLE schema_migrations TO control_api_runtime'
    )

    const sequenceBoundarySql = sqls.find(
      sql =>
        sql.includes('REVOKE UPDATE ON SEQUENCE') &&
        sql.includes('agent_run_events_ingest_sequence_seq')
    )
    expect(sequenceBoundarySql).toContain(
      'REVOKE UPDATE ON SEQUENCE\n          agent_run_events_ingest_sequence_seq'
    )
    expect(sequenceBoundarySql).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE\n          agent_run_events_ingest_sequence_seq'
    )

    const maintenanceBoundarySql = sqls.find(sql =>
      sql.includes('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM trace_maintenance_runtime')
    )
    expect(maintenanceBoundarySql).toContain(
      'GRANT SELECT, INSERT ON TABLE\n          infrastructure_telemetry_events,\n          governed_event_stream,\n          infrastructure_price_snapshots,\n          infrastructure_cost_daily,\n          infrastructure_cost_daily_components\n          TO trace_maintenance_runtime'
    )
    expect(maintenanceBoundarySql).toContain(
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM trace_maintenance_runtime'
    )
    expect(maintenanceBoundarySql).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE\n          infrastructure_telemetry_events_ingest_sequence_seq,\n          governed_event_stream_stream_sequence_seq\n          TO trace_maintenance_runtime'
    )
    expect(maintenanceBoundarySql).toContain(
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM trace_maintenance_runtime'
    )
    expect(maintenanceBoundarySql).not.toContain(
      'agent_run_events_ingest_sequence_seq,\n          administrative_events_ingest_sequence_seq,\n          infrastructure_telemetry_events_ingest_sequence_seq,\n          governed_event_stream_stream_sequence_seq\n          TO trace_maintenance_runtime'
    )

    expect(runtimeRoleSql).toContain(
      'GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) TO trace_maintenance_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_costs(INTEGER) TO trace_maintenance_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'GRANT EXECUTE ON FUNCTION governed_trace_safe_metadata(JSONB) TO control_api_runtime, trace_maintenance_runtime'
    )
    expect(runtimeRoleSql).toContain(
      'GRANT SELECT, INSERT ON TABLE\n          infrastructure_telemetry_events'
    )

    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))
    expect(recordedVersions.filter(version => /^00(?:5\d|6[0-7])_/.test(String(version)))).toEqual([
      '0050_host_wake_generations',
      '0051_host_heartbeats',
      '0052_workflow_approval_medium_display_name',
      '0053_workflow_approval_medium_reply_in_threads',
      '0054_workflow_run_completed_notification_download_detection',
      '0055_plugin_workload_sdk_grant_provider',
      '0056_llm_allowed_models',
      '0057_llm_allowed_models_vertex_bedrock',
      '0058_llm_allowed_models_new_providers',
      '0059_llm_allowed_models_catalog_lifecycle',
      '0060_llm_catalog_sync_runs',
      '0061_governed_run_trace_schema_foundation',
      '0062_governed_trace_runtime_roles',
      '0063_workflow_approval_trace_binding',
      '0064_agent_decision_source_catalog',
      '0065_governed_session_replay_and_prompt_history',
      '0066_governed_trace_target_principal_projection',
      '0067_llm_runtime_access_profiles',
    ])
    expect(recordedVersions).toContain('0067_llm_runtime_access_profiles')
    const addendumSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes('CREATE TABLE IF NOT EXISTS governed_run_attribution_bindings'))
    expect(addendumSql).toContain('CREATE TABLE IF NOT EXISTS governed_approval_prompt_history')
    expect(addendumSql).toContain(
      'ADD COLUMN IF NOT EXISTS cache_tokens_reported BOOLEAN NOT NULL DEFAULT FALSE'
    )
    expect(addendumSql).toContain("jsonb_typeof(value->'cache_tokens_reported') = 'boolean'")
    expect(addendumSql).toContain('idx_agent_run_events_session_window')
    expect(addendumSql).toContain('idx_agent_run_events_tool_session_filter')
    expect(addendumSql).toContain('idx_agent_run_events_approval_session_filter')
    expect(addendumSql).toContain('idx_administrative_events_list_filter')
    expect(addendumSql).toContain('DROP CONSTRAINT IF EXISTS administrative_events_action_check')
    expect(addendumSql).toContain("'service_maintenance', 'control_admin_deleted'")
    expect(addendumSql).toContain(
      'DROP CONSTRAINT IF EXISTS administrative_events_target_type_check'
    )
    expect(addendumSql).toContain("'configuration', 'service', 'control_admin'")
    expect(addendumSql).toContain("'summary', 'detail_ref', 'target_label', 'tool_name'")
    expect(addendumSql).toContain("value->>'target_label' ~ '^[A-Za-z0-9._-]{3,64}$'")
    expect(addendumSql).not.toContain('target_principal_kind')
    const targetPrincipalSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes("value->>'target_principal_kind' IN"))
    expect(targetPrincipalSql).toContain(
      "'summary', 'detail_ref', 'target_label', 'target_principal_kind'"
    )
    expect(targetPrincipalSql).toContain(
      "value->>'target_principal_kind' IN ('operator', 'host', 'context', 'service')"
    )
    expect(targetPrincipalSql).toContain(
      "value->>'target_principal_ref' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'"
    )
    expect(addendumSql).toContain('idx_infrastructure_telemetry_list_filter')
    expect(addendumSql?.match(/CREATE TABLE IF NOT EXISTS governed_/g)).toHaveLength(2)
    expect(addendumSql).toContain('governed_run_attribution_bindings_append_only')
    expect(addendumSql).toContain('governed_approval_prompt_history_append_only')
    expect(addendumSql).toContain('SECURITY DEFINER')
    expect(addendumSql).toContain('batch_limit NOT BETWEEN 1 AND 250')
    expect(addendumSql).toContain('SET search_path = pg_catalog, public')
    expect(addendumSql).toContain(
      'REVOKE ALL ON FUNCTION governed_trace_prune_expired_prompts(INTEGER) FROM PUBLIC, control_api_runtime, workflow_recipes_runtime'
    )
    expect(addendumSql).toContain(
      'GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_prompts(INTEGER) TO trace_maintenance_runtime'
    )
  })

  it('grants maintenance read-only access to every family inspected for stream gaps', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql =>
        sql.includes(
          'GRANT SELECT ON TABLE\n          agent_run_events,\n          administrative_events,\n          governed_event_read_v1\n          TO trace_maintenance_runtime'
        )
      )
    expect(migrationSql).toContain(
      'GRANT SELECT ON TABLE\n          agent_run_events,\n          administrative_events,\n          governed_event_read_v1\n          TO trace_maintenance_runtime'
    )
    expect(migrationSql).not.toContain(
      'GRANT SELECT, INSERT ON TABLE\n          agent_run_events\n          TO trace_maintenance_runtime'
    )
  })

  it('gives WRC only its workflow ledger and explicitly denies governed tracing relations', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql =
      clientQuery.mock.calls
        .map(([sql]) => String(sql))
        .find(sql => sql.includes('CREATE ROLE workflow_recipes_runtime')) ?? ''
    expect(migrationSql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA public')
    expect(migrationSql).toContain('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public')
    expect(migrationSql).toContain('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public')
    expect(migrationSql).toContain('GRANT SELECT, UPDATE ON TABLE workflow_runs')
    expect(migrationSql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE workflow_run_steps')
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflow_schedules'
    )
    expect(migrationSql).toContain('GRANT SELECT, UPDATE ON TABLE workflow_approval_requests')
    expect(migrationSql).toContain(
      'GRANT DELETE ON TABLE\n          team_workflow_triggers,\n          user_workflow_triggers,\n          workflow_recipe_allowed_teams'
    )
    expect(migrationSql).toContain(
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM workflow_recipes_runtime'
    )
    expect(migrationSql).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n          notification_deliveries'
    )
    expect(migrationSql).not.toContain(
      'GRANT SELECT ON TABLE workflow_approval_trigger_intents TO workflow_recipes_runtime'
    )
    expect(migrationSql).not.toContain(
      'GRANT SELECT, INSERT ON TABLE\n          agent_run_events\n          TO workflow_recipes_runtime'
    )
  })

  it('limits WRC cleanup predicate reads to recipe identity columns', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql =
      clientQuery.mock.calls
        .map(([sql]) => String(sql))
        .find(sql =>
          sql.includes(
            'GRANT SELECT (recipe_namespace, recipe_name)\n          ON TABLE team_workflow_triggers'
          )
        ) ?? ''

    expect(migrationSql).toContain(
      'GRANT SELECT (recipe_namespace, recipe_name)\n          ON TABLE team_workflow_triggers'
    )
    expect(migrationSql).toContain(
      'GRANT SELECT (recipe_namespace, recipe_name)\n          ON TABLE user_workflow_triggers'
    )
    expect(migrationSql).toContain(
      'GRANT SELECT (recipe_namespace, recipe_name)\n          ON TABLE workflow_recipe_allowed_teams'
    )
  })

  it('keeps workflow completion notifications behind a fixed-path definer trigger', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const triggerSql =
      clientQuery.mock.calls
        .map(([sql]) => String(sql))
        .find(
          sql =>
            sql.includes('CREATE OR REPLACE FUNCTION public.notify_workflow_run_update()') &&
            sql.includes('SECURITY DEFINER')
        ) ?? ''

    expect(triggerSql).toContain('SET search_path = pg_catalog')
    expect(triggerSql).toContain('INSERT INTO public.notification_deliveries')
    expect(triggerSql).toContain('FROM public.workflow_approval_requests war')
    expect(triggerSql).toContain('JOIN public.workflow_approval_trigger_intents wati')
    expect(triggerSql).toContain(
      'REVOKE ALL ON FUNCTION public.notify_workflow_run_update() FROM PUBLIC'
    )
  })

  it('adds the control-api approval source and separate decision actor projection', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const migrationSql = sqls.find(sql => sql.includes('decision_actor_sub TEXT NULL')) ?? ''
    expect(migrationSql).toContain("'control_api_local'")
    expect(migrationSql).toContain('events.decision_actor_sub')
  })

  it('adds the server-owned workflow approval run and step relation', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes('bound_workflow_run_id UUID NULL'))
    expect(migrationSql).toContain('decision_actor_sub TEXT NULL')
    expect(migrationSql).toContain('CREATE OR REPLACE VIEW governed_event_read_v1')
    expect(migrationSql).toContain('bound_workflow_step_id TEXT NULL')
    expect(migrationSql).toContain('approval_binding_sha256 TEXT NULL')
    expect(migrationSql).toContain('idx_workflow_approval_requests_bound_workflow')
  })

  it('binds approvals to the exact workflow step and clears the pair atomically', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes('workflow_approval_requests_bound_workflow_step_fkey'))
    expect(migrationSql).toContain('FOREIGN KEY (bound_workflow_run_id, bound_workflow_step_id)')
    expect(migrationSql).toContain('REFERENCES workflow_run_steps(run_id, step_id)')
    expect(migrationSql).toContain('ON DELETE SET NULL')
  })

  it('migrates decision sources to the canonical catalog without rejecting historical rows', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const migrationSql =
      clientQuery.mock.calls
        .map(([sql]) => String(sql))
        .find(sql => sql.includes("'legacy_gate'")) ?? ''

    expect(migrationSql).toContain('agent_run_events_decision_source_kind_check')
    for (const sourceKind of DECISION_SOURCE_KINDS) {
      expect(migrationSql).toContain(`'${sourceKind}'`)
    }
    expect(CURRENT_DECISION_SOURCE_KINDS).toEqual([
      'policy_evaluator',
      'approval_request',
      'approval_resolution',
      'legacy_gate',
    ])
    expect(LEGACY_DECISION_SOURCE_KINDS).toEqual(['policy', 'runtime_guard'])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('Plugin Workload SDK runtime-contract reconciliation migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('applies an additive migration after 0089 for already-migrated databases', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0090_plugin_workload_sdk_runtime_contract_reconciliation'
    )
    expect(migration).toBeDefined()
    const credentialTicketIndex = CONTROL_API_MIGRATIONS.findIndex(
      candidate => candidate.version === '0089_plugin_workload_sdk_credential_ticket_runtime_access'
    )
    expect(credentialTicketIndex).toBeGreaterThanOrEqual(0)
    expect(CONTROL_API_MIGRATIONS[credentialTicketIndex + 1]?.version).toBe(
      '0090_plugin_workload_sdk_runtime_contract_reconciliation'
    )

    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        const appliedVersions = CONTROL_API_MIGRATIONS.filter(
          candidate => candidate.version !== migration?.version
        ).map(candidate => ({ version: candidate.version }))
        return { rows: appliedVersions, rowCount: appliedVersions.length }
      }
      return { rows: [], rowCount: 0 }
    })

    await initDb()

    const migrationSql = clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find(sql =>
        sql.includes('CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata')
      )
    expect(migrationSql).toBeDefined()
    expect(migrationSql).toContain("'cache_tokens_reported'")
    expect(migrationSql).toContain("'prompt_bridge'")
    expect(migrationSql).toContain("'plugin_workload_sdk'")
    expect(migrationSql).toContain("'provider_attempt_id'")
    expect(migrationSql).toContain("jsonb_typeof(value->'prompt_bridge') = 'object'")
    expect(migrationSql).toContain('SET search_path = pg_catalog, public')
    expect(migrationSql).toContain('ALTER COLUMN contract_version SET DEFAULT 1')
    expect(migrationSql).toContain('plugin_workload_sdk_invocations_v2_lease_check')
    expect(migrationSql).toContain('plugin_workload_sdk_provider_attempts_status_check')
    expect(migrationSql).toContain("'skipped'")
    expect(migrationSql).toContain('cannot reconcile % v2 invocations without leases')
    expect(migrationSql).toContain('LOCK TABLE')
    // Deploy-critical lock knobs: EXCLUSIVE (not SHARE ROW EXCLUSIVE / ACCESS
    // EXCLUSIVE) keeps plain readers alive during the scan, and the 60s
    // lock_timeout bounds the wait below the deploy's kubectl budget. A silent
    // regression of either knob turns the migration into a deploy outage.
    expect(migrationSql).toContain('IN EXCLUSIVE MODE')
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '60s'")
    // The hardened cap on prompt_bridge provider_attempt_index / attempt_count.
    expect(migrationSql).toContain("~ '^[1-4]$'")
    expect(migrationSql).toContain('agent_run_events_check')
    expect(migrationSql).toContain('IS DISTINCT FROM TRUE')
    expect(migrationSql).toContain('IS TRUE)')
    expect(migrationSql).toContain('state changed during reconciliation')
    expect(migrationSql).toContain("attempts.status IN ('reserved', 'in_progress')")

    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === migration?.version
    )
    expect(recordCalls).toHaveLength(1)
  })

  // This is a SQL-text pinning test (pure toContain over the migration body),
  // not a behavioral fail-closed proof. The behavioral proof -- unknown
  // top-level/nested keys actually rejected by the installed validator and
  // CHECK constraint -- lives in the real-Postgres integration suite
  // (db.pluginWorkloadSdkRuntimeContract.realPostgres.integration.test.ts).
  it('pins the 0090 migration SQL text (nested prompt_bridge allowlist, type pins, revoke scope)', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0090_plugin_workload_sdk_runtime_contract_reconciliation'
    )
    expect(migration).toBeDefined()

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const migrationSql = String(query.mock.calls[0]?.[0])

    expect(migrationSql).toContain('WHERE key_name NOT IN')
    expect(migrationSql).toContain("'prompt_bridge'")
    expect(migrationSql).toContain("jsonb_typeof(value->'prompt_bridge') = 'object'")
    expect(migrationSql).toContain(
      "jsonb_typeof(value->'prompt_bridge'->'invocation_id') = 'string'"
    )
    expect(migrationSql).toContain(
      "jsonb_typeof(value->'prompt_bridge'->'attempt_generation') = 'number'"
    )
    expect(migrationSql).toContain('COALESCE(CASE')
    expect(migrationSql).toContain("value->'prompt_bridge' ?& ARRAY[")
    expect(migrationSql).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(migrationSql).toContain("FROM jsonb_object_keys(value->'prompt_bridge') AS key_name")
  })
})

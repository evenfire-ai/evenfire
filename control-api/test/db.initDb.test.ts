import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return {
    connect: mockConnect,
    query: vi.fn(),
  }
})

vi.mock('pg', () => ({
  Pool: mockPoolCtor,
}))

describe('db.initDb', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('runs pending migrations under a single advisory-locked transaction and records the baseline', async () => {
    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls[0]).toContain('SELECT pg_advisory_lock')
    expect(sqls[1]).toBe('BEGIN')
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations')
    )
    expect(sqls).toContain('SELECT version FROM schema_migrations')
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_runs'))
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_wr_recipe_created_started')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_medium_challenges')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_recipe_triggered_at'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('DROP INDEX IF EXISTS idx_workflow_runs_audit_recipe')
    )
    expect(sqls).toContainEqual(expect.stringContaining('INSERT INTO schema_migrations(version)'))
    expect(
      sqls.some(sql => sql.includes('DROP TABLE IF EXISTS workflow_trigger_idempotency'))
    ).toBe(false)
    expect(sqls.some(sql => sql.includes('DROP TABLE IF EXISTS workflow_run_outputs'))).toBe(false)
    expect(sqls).not.toContain('ROLLBACK')
    expect(sqls[sqls.length - 2]).toBe('COMMIT')
    expect(sqls[sqls.length - 1]).toContain('SELECT pg_advisory_unlock')
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('applies the triggered_at audit index migration on top of an already-migrated baseline', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: [{ version: '0001_control_api_baseline' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).not.toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_runs')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_recipe_triggered_at'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('DROP INDEX IF EXISTS idx_workflow_runs_audit_recipe')
    )
    expect(sqls).toContainEqual(expect.stringContaining('INSERT INTO schema_migrations(version)'))
  })

  it('applies the workflow approval medium schema migration on already-migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
          ],
          rowCount: 7,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_medium_accounts')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_medium_challenges')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_reader_events')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_provider_events')
    )
    expect(sqls).toContainEqual(expect.stringContaining("COALESCE(provider_channel_id, '')"))
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0008_workflow_approval_medium_schema'
    )
    expect(recordCalls.length).toBe(1)
    const providerEventRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0022_workflow_approval_provider_events'
    )
    expect(providerEventRecordCalls.length).toBe(1)
    const channelIndexRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) &&
        params[0] === '0023_workflow_approval_medium_account_channel_identity_index'
    )
    expect(channelIndexRecordCalls.length).toBe(1)
    const legacyNullChannelRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0024_disable_legacy_null_channel_medium_accounts'
    )
    expect(legacyNullChannelRecordCalls.length).toBe(1)
  })

  it('applies the channel-bound medium account index on clusters migrated through provider events', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
            { version: '0013_oauth_grants_table' },
            { version: '0014_consolidate_workflow_allowed_users' },
            { version: '0015_oauth_service_grants' },
            { version: '0016_workflow_trigger_shared_foundation' },
            { version: '0017_drop_team_workflow_grants_audit_actor_fk' },
            { version: '0018_workflow_recipe_allowed_teams_team_fk' },
            { version: '0019_workflow_recipe_allowed_teams_audit' },
            { version: '0020_workflow_approval_trigger_run_intents' },
            { version: '0021_teamless_invitations' },
            { version: '0022_workflow_approval_provider_events' },
          ],
          rowCount: 22,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining('DROP INDEX IF EXISTS idx_wama_active_provider_identity')
    )
    expect(sqls).toContainEqual(expect.stringContaining("COALESCE(provider_channel_id, '')"))
    expect(sqls).toContainEqual(expect.stringContaining('legacy.provider_channel_id IS NULL'))
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) &&
        params[0] === '0023_workflow_approval_medium_account_channel_identity_index'
    )
    expect(recordCalls.length).toBe(1)
    const legacyNullChannelRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0024_disable_legacy_null_channel_medium_accounts'
    )
    expect(legacyNullChannelRecordCalls.length).toBe(1)
  })

  it('applies the usage-tracking baseline on top of all earlier migrations', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
          ],
          rowCount: 8,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).toContainEqual(
      expect.stringContaining(
        "CREATE TYPE usage_source_kind AS ENUM ('channel','desktop','workflow','cron','unknown','plugin_workload_sdk')"
      )
    )
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS usage_events'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS usage_5min'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS usage_hourly'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS usage_daily'))
    expect(sqls).toContainEqual(
      expect.stringContaining("GENERATED ALWAYS AS (COALESCE(team_id, ''))         STORED")
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS usage_5min_team_idx')
    )
    expect(sqls).toContainEqual(expect.stringContaining('VALUES ($1)'))
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0009_usage_tracking_baseline'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies workflow usage attribution schema on already usage-migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
          ],
          rowCount: 9,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).toContainEqual(
      expect.stringContaining('ALTER TABLE workflow_runs\n      ADD COLUMN IF NOT EXISTS team_id')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'ALTER TABLE workflow_runs_audit\n      ADD COLUMN IF NOT EXISTS triggerer_team_id'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'ALTER TABLE workflow_schedules\n      ADD COLUMN IF NOT EXISTS team_id'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('ALTER TABLE usage_events\n      ADD COLUMN IF NOT EXISTS team_id')
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0010_workflow_usage_attribution_schema'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies workflow admin usage attribution schema without creating parallel identities', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
          ],
          rowCount: 10,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    const migrationSql = sqls.find(sql => sql.includes('idx_wr_usage_team')) ?? ''

    expect(migrationSql).toContain(
      "CHECK (actor_type IN ('user','admin','autonomous','scheduled'))"
    )
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS usage_team_id TEXT NULL')
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS triggerer_admin_user_id UUID NULL')
    expect(migrationSql).not.toContain('INSERT INTO users')
    expect(migrationSql).not.toContain('INSERT INTO teams')
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0011_workflow_admin_usage_attribution_schema'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies workflow run retention columns on already migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
          ],
          rowCount: 11,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    const migrationSql =
      sqls.find(sql => sql.includes('ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished')) ?? ''

    expect(migrationSql).toContain('ALTER TABLE workflow_runs')
    expect(migrationSql).toContain('ALTER TABLE workflow_schedules')
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000'
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0012_workflow_run_retention_columns'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('skips workflow run retention migration when already recorded', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
          ],
          rowCount: 12,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).not.toContainEqual(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished')
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0012_workflow_run_retention_columns'
    )
    expect(recordCalls.length).toBe(0)
  })

  it('applies workflow trigger shared foundation schema on already retention-migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
          ],
          rowCount: 12,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents_archive'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents_archive'
      )
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS team_workflow_triggers')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS team_workflow_grants_audit')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams_audit')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('INSERT INTO workflow_approval_trigger_intents')
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0016_workflow_trigger_shared_foundation'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('adds approval-target team audit schema on already allowed-team-FK migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
            { version: '0013_oauth_grants_table' },
            { version: '0014_consolidate_workflow_allowed_users' },
            { version: '0015_oauth_service_grants' },
            { version: '0016_workflow_trigger_shared_foundation' },
            { version: '0017_drop_team_workflow_grants_audit_actor_fk' },
            { version: '0018_workflow_recipe_allowed_teams_team_fk' },
          ],
          rowCount: 18,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams_audit')
    )
    expect(sqls).toContainEqual(expect.stringContaining('REFERENCES teams(id) ON DELETE RESTRICT'))
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0019_workflow_recipe_allowed_teams_audit'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies user-delete audit set-null migration on already-migrated clusters', async () => {
    const appliedVersions = [
      '0001_control_api_baseline',
      '0002_workflow_runs_audit_recipe_triggered_at_index',
      '0003_drop_trigger_grants_audit_operator_fk',
      '0004_invitation_and_user_password_columns',
      '0005_invitation_invitee_name',
      '0006_seed_sentinel_allowlist_for_admins',
      '0007_workflow_run_approval_binding',
      '0008_workflow_approval_medium_schema',
      '0009_usage_tracking_baseline',
      '0010_workflow_usage_attribution_schema',
      '0011_workflow_admin_usage_attribution_schema',
      '0012_workflow_run_retention_columns',
      '0013_oauth_grants_table',
      '0014_consolidate_workflow_allowed_users',
      '0015_oauth_service_grants',
      '0016_workflow_trigger_shared_foundation',
      '0017_drop_team_workflow_grants_audit_actor_fk',
      '0018_workflow_recipe_allowed_teams_team_fk',
      '0019_workflow_recipe_allowed_teams_audit',
      '0020_workflow_approval_trigger_run_intents',
      '0021_teamless_invitations',
      '0022_workflow_approval_provider_events',
      '0023_workflow_approval_medium_account_channel_identity_index',
      '0024_disable_legacy_null_channel_medium_accounts',
      '0025_workflow_run_completed_notifications',
      '0026_workflow_runs_recipe_created_started_index',
      '0027_control_admin_email_and_invitations',
      '0028_control_admin_email_change_requests',
      '0029_control_admin_deletion_audit',
      '0030_control_admin_password_reset_requests',
      '0031_control_admin_session_version',
    ]
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: appliedVersions.map(version => ({ version })),
          rowCount: appliedVersions.length,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    const migrationSql = sqls.find(
      sql =>
        sql.includes('trigger_grants_audit_target_user_id_fkey') &&
        sql.includes('workflow_runs_audit_triggerer_user_id_fkey')
    )
    expect(migrationSql).toContain('ALTER COLUMN target_user_id DROP NOT NULL')
    expect(migrationSql).toContain('ON DELETE SET NULL')
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0032_user_delete_audit_set_null'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies the remove team owner role migration on clusters migrated through user-delete audit', async () => {
    const appliedVersions = [
      '0001_control_api_baseline',
      '0002_workflow_runs_audit_recipe_triggered_at_index',
      '0003_drop_trigger_grants_audit_operator_fk',
      '0004_invitation_and_user_password_columns',
      '0005_invitation_invitee_name',
      '0006_seed_sentinel_allowlist_for_admins',
      '0007_workflow_run_approval_binding',
      '0008_workflow_approval_medium_schema',
      '0009_usage_tracking_baseline',
      '0010_workflow_usage_attribution_schema',
      '0011_workflow_admin_usage_attribution_schema',
      '0012_workflow_run_retention_columns',
      '0013_oauth_grants_table',
      '0014_consolidate_workflow_allowed_users',
      '0015_oauth_service_grants',
      '0016_workflow_trigger_shared_foundation',
      '0017_drop_team_workflow_grants_audit_actor_fk',
      '0018_workflow_recipe_allowed_teams_team_fk',
      '0019_workflow_recipe_allowed_teams_audit',
      '0020_workflow_approval_trigger_run_intents',
      '0021_teamless_invitations',
      '0022_workflow_approval_provider_events',
      '0023_workflow_approval_medium_account_channel_identity_index',
      '0024_disable_legacy_null_channel_medium_accounts',
      '0025_workflow_run_completed_notifications',
      '0026_workflow_runs_recipe_created_started_index',
      '0027_control_admin_email_and_invitations',
      '0028_control_admin_email_change_requests',
      '0029_control_admin_deletion_audit',
      '0030_control_admin_password_reset_requests',
      '0031_control_admin_session_version',
      '0032_user_delete_audit_set_null',
    ]
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: appliedVersions.map(version => ({ version })),
          rowCount: appliedVersions.length,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    const migrationSql = sqls.find(
      sql =>
        sql.includes('UPDATE team_members') &&
        sql.includes("SET role = 'admin'") &&
        sql.includes("WHERE role = 'owner'")
    )
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS team_members_role_check')
    expect(migrationSql).toContain("CHECK (role IN ('admin', 'inviter', 'member'))")
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0033_remove_team_owner_role'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('rolls back workflow trigger shared foundation migration when live trigger-bound approvals are malformed', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
          ],
          rowCount: 12,
        }
      }
      if (
        sql.includes('SELECT id::text AS id') &&
        sql.includes("payload->'metadata' ? 'workflowTrigger'")
      ) {
        return {
          rows: [
            { id: 'bad-approval-id-1', total: 2 },
            { id: 'bad-approval-id-2', total: 2 },
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await expect(initDb()).rejects.toThrow(
      'Cannot migrate 2 live trigger-bound workflow approvals with malformed workflowTrigger metadata: bad-approval-id-1, bad-approval-id-2'
    )

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContain('ROLLBACK')
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0016_workflow_trigger_shared_foundation'
    )
    expect(recordCalls.length).toBe(0)
  })

  it('drops team workflow grant audit actor FK on already phase-0-migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
            { version: '0013_oauth_grants_table' },
            { version: '0014_consolidate_workflow_allowed_users' },
            { version: '0015_oauth_service_grants' },
            { version: '0016_workflow_trigger_shared_foundation' },
          ],
          rowCount: 13,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining(
        'DROP CONSTRAINT IF EXISTS team_workflow_grants_audit_actor_user_id_fkey'
      )
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0017_drop_team_workflow_grants_audit_actor_fk'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('enforces workflow approval allowed-team FK on already phase-0-migrated clusters', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
            { version: '0013_oauth_grants_table' },
            { version: '0014_consolidate_workflow_allowed_users' },
            { version: '0015_oauth_service_grants' },
            { version: '0016_workflow_trigger_shared_foundation' },
            { version: '0017_drop_team_workflow_grants_audit_actor_fk' },
          ],
          rowCount: 17,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_teams wat')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('ADD CONSTRAINT workflow_recipe_allowed_teams_team_id_fkey')
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0018_workflow_recipe_allowed_teams_team_fk'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('seeds the sentinel allowlist for existing admins on fresh DB (migration 0006)', async () => {
    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).toContainEqual(
      expect.stringMatching(
        /INSERT INTO workflow_recipe_allowed_users[\s\S]+SELECT 'mcp-host', 'standalone', id FROM users WHERE role = 'admin'[\s\S]+ON CONFLICT DO NOTHING/
      )
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0006_seed_sentinel_allowlist_for_admins'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('skips migration 0006 when already recorded in schema_migrations', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
          ],
          rowCount: 9,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).not.toContainEqual(
      expect.stringMatching(
        /INSERT INTO workflow_recipe_allowed_users[\s\S]+'mcp-host', 'standalone'/
      )
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0006_seed_sentinel_allowlist_for_admins'
    )
    expect(recordCalls.length).toBe(0)
  })

  it('applies remaining additive migrations when 0001-0005 are already recorded', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
          ],
          rowCount: 5,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls).not.toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS workflow_runs')
    )
    expect(sqls).toContainEqual(
      expect.stringMatching(
        /INSERT INTO workflow_recipe_allowed_users[\s\S]+SELECT 'mcp-host', 'standalone', id FROM users WHERE role = 'admin'[\s\S]+ON CONFLICT DO NOTHING/
      )
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0006_seed_sentinel_allowlist_for_admins'
    )
    expect(recordCalls.length).toBe(1)
    const bindingRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0007_workflow_run_approval_binding'
    )
    expect(bindingRecordCalls.length).toBe(1)
    const mediumRecordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0008_workflow_approval_medium_schema'
    )
    expect(mediumRecordCalls.length).toBe(1)
  })

  it('rolls back and releases the advisory lock when a migration step fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')) {
        throw new Error('ddl failed')
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await expect(initDb()).rejects.toThrow('ddl failed')

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())

    expect(sqls[0]).toContain('SELECT pg_advisory_lock')
    expect(sqls[1]).toBe('BEGIN')
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations')
    )
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    expect(sqls[sqls.length - 1]).toContain('SELECT pg_advisory_unlock')
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('rolls back the desktop-user retirement migration without recording it when its DDL fails', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const priorVersions = CONTROL_API_MIGRATIONS.filter(
      migration => migration.version !== '0094_desktop_user_retirement_lifecycle'
    ).map(migration => ({ version: migration.version }))

    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: priorVersions, rowCount: priorVersions.length }
      }
      if (sql.includes('CREATE TABLE IF NOT EXISTS desktop_user_retirement_operations')) {
        throw new Error('retirement ledger ddl failed')
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(initDb()).rejects.toThrow('retirement ledger ddl failed')

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS desktop_user_retirement_operations')
    )
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    const retirementRecord = clientQuery.mock.calls.find(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0094_desktop_user_retirement_lifecycle'
    )
    expect(retirementRecord).toBeUndefined()
  })

  it('deduplicates pending control-admin invitations before creating the opened-status unique index', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: [
            { version: '0001_control_api_baseline' },
            { version: '0002_workflow_runs_audit_recipe_triggered_at_index' },
            { version: '0003_drop_trigger_grants_audit_operator_fk' },
            { version: '0004_invitation_and_user_password_columns' },
            { version: '0005_invitation_invitee_name' },
            { version: '0006_seed_sentinel_allowlist_for_admins' },
            { version: '0007_workflow_run_approval_binding' },
            { version: '0008_workflow_approval_medium_schema' },
            { version: '0009_usage_tracking_baseline' },
            { version: '0010_workflow_usage_attribution_schema' },
            { version: '0011_workflow_admin_usage_attribution_schema' },
            { version: '0012_workflow_run_retention_columns' },
            { version: '0013_oauth_grants_table' },
            { version: '0014_consolidate_workflow_allowed_users' },
            { version: '0015_oauth_service_grants' },
            { version: '0016_workflow_trigger_shared_foundation' },
            { version: '0017_drop_team_workflow_grants_audit_actor_fk' },
            { version: '0018_workflow_recipe_allowed_teams_team_fk' },
            { version: '0019_workflow_recipe_allowed_teams_audit' },
            { version: '0020_workflow_approval_trigger_run_intents' },
            { version: '0021_teamless_invitations' },
            { version: '0022_workflow_approval_provider_events' },
            { version: '0023_workflow_approval_medium_account_channel_identity_index' },
            { version: '0024_disable_legacy_null_channel_medium_accounts' },
            { version: '0025_workflow_run_completed_notifications' },
            { version: '0026_workflow_runs_recipe_created_started_index' },
            { version: '0027_control_admin_email_and_invitations' },
            { version: '0028_control_admin_email_change_requests' },
            { version: '0029_control_admin_deletion_audit' },
            { version: '0030_control_admin_password_reset_requests' },
            { version: '0031_control_admin_session_version' },
            { version: '0032_user_delete_audit_set_null' },
            { version: '0033_remove_team_owner_role' },
            { version: '0034_plugin_workload_sdk' },
            { version: '0035_plugin_workload_sdk_drop_super_admin_approved' },
            { version: '0036_user_notification_preferences_preferred_account' },
            { version: '0037_invitation_teams_and_purpose' },
            { version: '0038_notification_deliveries_delivered_medium' },
            { version: '0039_wama_communication_channel_ref' },
            { version: '0040_admin_desktop_access_invitation_purpose' },
          ],
          rowCount: 40,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql).trim())
    const migrationSql =
      sqls.find(sql => sql.includes('0041_control_admin_invitation_opened_status')) ||
      sqls.find(sql => sql.includes('ROW_NUMBER() OVER')) ||
      ''

    expect(migrationSql).toContain('ROW_NUMBER() OVER')
    expect(migrationSql).toContain('control_admin_deletion_audit')
    expect(migrationSql).toContain("status IN ('pending', 'opened')")
    expect(migrationSql).toContain('expires_at <= NOW()')
    expect(migrationSql).toContain("WHERE status IN ('pending', 'opened')")
    expect(migrationSql).toContain("SET status = 'revoked'")
    expect(migrationSql).toContain('ranked.duplicate_rank > 1')
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX idx_control_admin_invitations_pending_email'
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0041_control_admin_invitation_opened_status'
    )
    expect(recordCalls.length).toBe(1)
  })
})

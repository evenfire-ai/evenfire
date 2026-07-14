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

describe('db.initDb workflow_runs recipe ordering index migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('adds the index on clusters that already recorded earlier migrations', async () => {
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
          ],
          rowCount: 25,
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
      expect.stringContaining(
        'ON workflow_runs(recipe_namespace, recipe_name, created_at DESC, started_at DESC)'
      )
    )
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) =>
        Array.isArray(params) && params[0] === '0026_workflow_runs_recipe_created_started_index'
    )
    expect(recordCalls.length).toBe(1)
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })
})

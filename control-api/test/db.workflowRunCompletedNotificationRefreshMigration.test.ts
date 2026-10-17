import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onlineIndexAwareQuery } from './helpers/onlineIndexCatalogMock.js'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return {
      connect: mockConnect,
      query: vi.fn(),
    }
  }),
}))

const APPLIED_MIGRATIONS = [
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
  '0033_remove_team_owner_role',
  '0034_plugin_workload_sdk',
  '0035_plugin_workload_sdk_drop_super_admin_approved',
  '0036_user_notification_preferences_preferred_account',
  '0037_invitation_teams_and_purpose',
  '0038_notification_deliveries_delivered_medium',
  '0039_wama_communication_channel_ref',
  '0040_admin_desktop_access_invitation_purpose',
  '0041_control_admin_invitation_opened_status',
  '0042_oauth_grant_background_flag',
  '0043_usage_cache_tokens',
  '0044_llm_model_prices',
  '0045_token_budgets',
  '0046_budget_pending_reservations',
  '0047_budget_pending_reservations_host_ref',
  '0048_gfs_permission_store',
  '0049_registry_connection',
  '0050_host_wake_generations',
  '0051_host_heartbeats',
  '0052_workflow_approval_medium_display_name',
  '0053_workflow_approval_medium_reply_in_threads',
]

describe('workflow completion download detection refresh migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: onlineIndexAwareQuery(clientQuery),
      release: clientRelease,
    })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return {
          rows: APPLIED_MIGRATIONS.map(version => ({ version })),
          rowCount: APPLIED_MIGRATIONS.length,
        }
      }
      return { rows: [], rowCount: 0 }
    })
  })

  it('reinstalls the trigger on databases that already applied its original migration', async () => {
    const { initDb } = await import('../src/db.js')

    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContainEqual(
      expect.stringContaining("'hasDownloadableItems', wr_outputs.has_downloadable_items")
    )
    expect(sqls).toContainEqual(expect.stringContaining("IN ('telegram', 'slack', 'teams')"))
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      ['0054_workflow_run_completed_notification_download_detection']
    )
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })
})

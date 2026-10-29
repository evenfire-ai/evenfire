import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('0134 composable catalog revisions migration', () => {
  it('installs scoped transactional writers for every catalog writer table', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0134_composable_catalog_revisions'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    // The writer-class map is test data in the catalogRevisionComponents
    // real-PostgreSQL suite, not a production table.
    expect(sql).not.toContain('authorization_catalog_writer_components')
    expect(sql).toContain('authorization_bump_workflow_run_revision')
    expect(sql).toContain('authorization_bump_workflow_run_audit_revision')
    expect(sql).toContain('authorization_prelock_workflow_run_revisions(target_run_ids UUID[])')
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION authorization_prelock_workflow_run_revisions(UUID[]) FROM PUBLIC'
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION authorization_prelock_workflow_run_revisions\(UUID\[\]\)\s+TO control_api_runtime/
    )
    // The approval prelock also covers the runs its DELETE cascade rewrites.
    expect(sql).toContain(
      'authorization_prelock_workflow_approval_revisions(\n      target_request_ids UUID[]\n    )'
    )
    expect(sql).toContain('run.approval_request_id = ANY(target_request_ids)')
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION authorization_prelock_workflow_approval_revisions(UUID[]) FROM PUBLIC'
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION authorization_prelock_workflow_approval_revisions\(UUID\[\]\)\s+TO control_api_runtime/
    )
    // The approval-trigger prelock covers the run INSERT that a decision or a
    // consume performs, so its body reads the run intent and the decision team.
    expect(sql).toContain(
      'authorization_prelock_workflow_approval_trigger_revisions(\n      target_request_id UUID\n    )'
    )
    expect(sql).toContain('workflow_approval_trigger_run_intents')
    expect(sql).toContain("war.decision_maker->>'teamId'")
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION authorization_prelock_workflow_approval_trigger_revisions(UUID)\n      FROM PUBLIC'
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION authorization_prelock_workflow_approval_trigger_revisions\(UUID\)\s+TO control_api_runtime/
    )
    // Recipe deletion runs on the Workflow Recipes pool: its prelock derives the
    // recipe's grant and approval subjects, and only that runtime role executes
    // it. The grant-row phase must sit in the function, because the runtime role
    // cannot lock or read the subject columns.
    expect(sql).toContain(
      'authorization_prelock_workflow_recipe_policy_revisions(\n      target_recipe_namespace TEXT,\n      target_recipe_name TEXT\n    )'
    )
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION authorization_prelock_workflow_recipe_policy_revisions(TEXT, TEXT)\n      FROM PUBLIC'
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION authorization_prelock_workflow_recipe_policy_revisions\(TEXT, TEXT\)\s+TO workflow_recipes_runtime/
    )
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION authorization_prelock_workflow_recipe_policy_revisions\(TEXT, TEXT\)\s+TO control_api_runtime/
    )
    const recipePolicyFunction = sql.slice(
      sql.indexOf('FUNCTION authorization_prelock_workflow_recipe_policy_revisions'),
      sql.indexOf('CREATE OR REPLACE FUNCTION authorization_bump_user_row_revision')
    )
    expect(recipePolicyFunction).toContain('ORDER BY trigger_grant.user_id\n       FOR UPDATE')
    expect(recipePolicyFunction).toContain('ORDER BY trigger_grant.team_id\n       FOR UPDATE')
    expect(recipePolicyFunction).toContain('ORDER BY approval_target.team_id\n       FOR UPDATE')
    expect(recipePolicyFunction).not.toContain('workflow_recipe_allowed_users')
    expect(sql).toContain('authorization_bump_workflow_approval_revision')
    expect(sql).toContain('authorization_bump_notification_revision')
    expect(sql).toContain('authorization_bump_gfs_resource_revision')
    expect(sql).not.toContain('authorization_catalog_revision')
    expect(sql).not.toMatch(/\bDROP\s+(?:TRIGGER|TABLE|FUNCTION)\b/i)
  })

  it('replaces row-level revision triggers without dropping them', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0134_composable_catalog_revisions'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls
      .map(call => String(call[0]))
      .join('\n')
      .replace(/\s+/g, ' ')

    const replaced = [...sql.matchAll(/CREATE OR REPLACE TRIGGER (\w+) /g)].map(match => match[1])
    expect(replaced.sort()).toEqual(
      [
        'users_authorization_revision',
        'teams_authorization_revision',
        'workflow_runs_authorization_revision',
        'workflow_approval_requests_authorization_revision',
        'workflow_recipe_allowed_teams_authorization_revision',
        'workflow_approval_medium_accounts_authorization_revision',
        'workflow_runs_audit_authorization_revision',
        'notification_deliveries_authorization_revision',
        'gfs_grants_authorization_revision',
        'gfs_shares_authorization_revision',
        'gfs_resources_authorization_revision',
      ].sort()
    )
    expect(sql).not.toMatch(/DROP TRIGGER IF EXISTS \w+_authorization_revision/)
    expect(sql).not.toMatch(/CREATE TRIGGER /)
  })
})

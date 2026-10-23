import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('0133 composable catalog revisions migration', () => {
  it('installs scoped transactional writers for every catalog writer table', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0133_composable_catalog_revisions'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')
    const normalizedSql = sql.replace(/\s+/g, ' ')

    for (const table of [
      'users',
      'teams',
      'team_members',
      'user_contexts',
      'team_contexts',
      'user_agents',
      'team_agents',
      'user_workflow_triggers',
      'team_workflow_triggers',
      'workflow_runs',
      'workflow_approval_requests',
      'notification_deliveries',
      'gfs_resources',
      'gfs_grants',
      'gfs_shares',
      'operational_resource_index',
      'operational_resource_relationships',
      'operational_catalog_source_state',
    ]) {
      expect(normalizedSql).toContain(`('${table}',`)
    }
    expect(sql).toContain('authorization_bump_workflow_run_revision')
    expect(sql).toContain('authorization_bump_workflow_approval_revision')
    expect(sql).toContain('authorization_bump_notification_revision')
    expect(sql).toContain('authorization_bump_gfs_subject_revision')
    expect(sql).toContain('authorization_bump_gfs_resource_revision')
    expect(sql).not.toContain('authorization_catalog_revision')
    expect(sql).not.toMatch(/\bDROP\s+(?:TRIGGER|TABLE|FUNCTION)\b/i)
  })

  it('replaces row-level revision triggers without dropping them', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0133_composable_catalog_revisions'
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

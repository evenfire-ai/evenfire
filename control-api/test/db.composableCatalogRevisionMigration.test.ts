import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('010a composable catalog revisions migration', () => {
  it('replaces the singleton trigger class with scoped transactional writers', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '010a_composable_catalog_revisions'
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
      expect(normalizedSql).toContain(
        `DROP TRIGGER IF EXISTS ${table}_catalog_revision ON ${table}`
      )
    }
    expect(sql).toContain('authorization_bump_workflow_run_revision')
    expect(sql).toContain('authorization_bump_workflow_approval_revision')
    expect(sql).toContain('authorization_bump_notification_revision')
    expect(sql).toContain('authorization_bump_gfs_subject_revision')
    expect(sql).toContain('authorization_bump_gfs_resource_revision')
    expect(sql).toContain('DROP TABLE IF EXISTS authorization_catalog_revision')
    expect(sql).not.toContain('UPDATE authorization_catalog_revision')
  })
})

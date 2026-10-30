import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('0133 catalog UTF-8 ordering migration', () => {
  it('installs the immutable byte function and plans its index class online', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const { PR1_ONLINE_INDEX_PLAN } = await import('../src/migrations/pr1OnlineIndexPlan.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0133_catalog_utf8_ordering'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE OR REPLACE FUNCTION catalog_utf8_bytes(value TEXT)')
    expect(sql).toContain("SELECT convert_to(value, 'UTF8')")
    expect(sql.match(/catalog_utf8_bytes\(/g)).toHaveLength(1)
    expect(sql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i)

    const expectedIndexes = [
      'user_agents_catalog_utf8_idx',
      'team_agents_catalog_utf8_idx',
      'user_contexts_catalog_utf8_idx',
      'team_contexts_catalog_utf8_idx',
      'user_workflow_triggers_catalog_utf8_idx',
      'team_workflow_triggers_catalog_utf8_idx',
      'operational_relationship_catalog_utf8_target_idx',
    ]
    const planned = PR1_ONLINE_INDEX_PLAN.filter(
      entry => entry.migrationVersion === '0133_catalog_utf8_ordering'
    )
    expect(planned.map(entry => entry.name).sort()).toEqual([...expectedIndexes].sort())
    for (const entry of planned) expect(entry.createSql).toContain('catalog_utf8_bytes(')
  })
})

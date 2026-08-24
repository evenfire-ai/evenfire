import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('0103 catalog UTF-8 ordering migration', () => {
  it('installs the immutable byte function and complete supporting index class', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0103_catalog_utf8_ordering'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE OR REPLACE FUNCTION catalog_utf8_bytes(value TEXT)')
    expect(sql).toContain("SELECT convert_to(value, 'UTF8')")
    expect(sql.match(/catalog_utf8_bytes\(/g)).toHaveLength(8)
    expect(sql).toContain('user_agents_catalog_utf8_idx')
    expect(sql).toContain('team_agents_catalog_utf8_idx')
    expect(sql).toContain('user_contexts_catalog_utf8_idx')
    expect(sql).toContain('team_contexts_catalog_utf8_idx')
    expect(sql).toContain('user_workflow_triggers_catalog_utf8_idx')
    expect(sql).toContain('team_workflow_triggers_catalog_utf8_idx')
    expect(sql).toContain('operational_relationship_catalog_utf8_target_idx')
  })
})

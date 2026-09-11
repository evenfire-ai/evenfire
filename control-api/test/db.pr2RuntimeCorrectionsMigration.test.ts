import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

describe('PR2 runtime correction migrations', () => {
  it('admits workflow recipes while preserving a closed entity vocabulary', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0113_workflow_recipe_authority_entity'
    )!
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))

    await migration.apply({ query })

    const sql = query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain("'workflow_trigger', 'workflow_recipe', 'workflow_run'")
    expect(sql).toContain('ADD CONSTRAINT workflow_authority_bindings_entity_type_check')
    expect(sql).not.toContain('NOT VALID')
  })
})

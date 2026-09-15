import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

describe('PR2 runtime correction migrations', () => {
  it('grants the runtime role only the access used by PR2 services', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0112_pr2_runtime_privileges'
    )!
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))

    await migration.apply({ query })

    const sql = query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE workflow_authority_bindings')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE pr2_readiness_activations')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE pr2_readiness_evidence')
    expect(sql).not.toMatch(/GRANT .*DELETE|GRANT .*TRUNCATE/)
  })

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

  it('adds only the closed workflow authority failure vocabulary', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0114_workflow_run_failure_reason'
    )!
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))

    await migration.apply({ query })

    const sql = query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS failure_reason TEXT NULL')
    expect(sql).toContain("'workflow_authority_denied'")
    expect(sql).toContain("'workflow_authority_not_found'")
    expect(sql).toContain("'workflow_authority_access_path_stale'")
    expect(sql).toContain("'workflow_authority_invalid_binding'")
    expect(sql).not.toMatch(/token|delegation|https?:\/\//i)
  })
})

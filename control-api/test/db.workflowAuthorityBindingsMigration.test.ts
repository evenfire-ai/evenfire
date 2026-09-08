import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

describe('workflow authority bindings migration', () => {
  it('adds normalized immutable provenance and workflow links without rewriting legacy rows', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '010f_workflow_authority_bindings'
    )
    expect(migration).toBeDefined()

    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workflow_authority_bindings')
    expect(sql).toContain('delegation_jti UUID NOT NULL')
    expect(sql).toContain('binding_version SMALLINT NOT NULL CHECK (binding_version = 2)')
    expect(sql).toContain('user_id UUID NOT NULL')
    expect(sql).not.toContain('user_id UUID NOT NULL REFERENCES users')
    expect(sql).toContain('session_id UUID NOT NULL')
    expect(sql).not.toContain('session_id UUID NOT NULL REFERENCES external_user_sessions')
    expect(sql).toContain('effective_team_id UUID NULL')
    expect(sql).not.toContain('effective_team_id UUID NULL REFERENCES teams')
    expect(sql).toContain('source_expires_at TIMESTAMPTZ NOT NULL')
    expect(sql).toContain('workflow.approval.decide->workflow.approval.consume')
    expect(sql).toContain("'run_management', 'artifact_list', 'artifact_read', 'artifact_delete'")
    expect(sql).toContain('enforce_workflow_authority_binding_parent')
    expect(sql).toContain("parent_operation IS DISTINCT FROM 'workflow.approval.decide'")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS initiating_authority_binding_id')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS trigger_authority_binding_id')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS decision_authority_binding_id')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS consume_authority_binding_id')
    expect(sql).toContain('REFERENCES workflow_authority_bindings(id) ON DELETE RESTRICT')
    expect(sql).toContain('GRANT SELECT ON TABLE workflow_authority_bindings')
    expect(sql).not.toMatch(/UPDATE\s+workflow_(?:runs|approval_requests)/i)
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })
})

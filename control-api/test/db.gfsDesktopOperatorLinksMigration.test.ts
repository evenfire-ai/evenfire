import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0091_gfs_desktop_operator_links migration', () => {
  it('installs an additive one-to-one link with the closed initial-setup source contract', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0091_gfs_desktop_operator_links'
    )
    expect(migration).toBeDefined()
    const migrationIndex = CONTROL_API_MIGRATIONS.findIndex(
      candidate => candidate.version === migration?.version
    )
    expect(CONTROL_API_MIGRATIONS[migrationIndex - 1]?.version).toBe(
      '0090_plugin_workload_sdk_runtime_contract_reconciliation'
    )
    expect(CONTROL_API_MIGRATIONS[migrationIndex + 1]?.version).toBe(
      '0092_gfs_audit_actor_correlation'
    )

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gfs_desktop_operator_links')
    expect(sql).toContain('user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE')
    expect(sql).toContain(
      'control_admin_id UUID NOT NULL UNIQUE REFERENCES control_admin_users(id) ON DELETE CASCADE'
    )
    expect(sql).toContain("source TEXT NOT NULL CHECK (source IN ('initial_setup'))")
    expect(sql).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    expect(sql).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE gfs_desktop_operator_links TO control_api_runtime'
    )
    expect(sql).not.toMatch(/INSERT\s+INTO\s+gfs_desktop_operator_links/i)
    expect(sql).not.toMatch(/JOIN\s+.*email|lower\s*\(.*email/i)
    expect(sql).not.toContain('control_admin_invitation')
    expect(sql).not.toContain('admin_member_bridge')
    expect(sql).not.toContain('manual_repair')
  })
})

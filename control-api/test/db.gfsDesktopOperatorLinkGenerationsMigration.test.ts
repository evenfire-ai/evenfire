import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0093_gfs_desktop_operator_link_generations migration', () => {
  it('evolves links into immutable stateful generations with restricted parents', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0093_gfs_desktop_operator_link_generations'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lineage_id UUID')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS generation INTEGER')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS row_version BIGINT')
    expect(sql).toContain('created_by = COALESCE(created_by, control_admin_id)')
    expect(sql).toContain('ALTER COLUMN created_by SET NOT NULL')
    expect(sql).toContain("CHECK (state IN ('active', 'revoked'))")
    expect(sql).toContain('REFERENCES users(id) ON DELETE RESTRICT')
    expect(sql).toContain('REFERENCES control_admin_users(id) ON DELETE RESTRICT')
    expect(sql).not.toContain('gfs_desktop_operator_links(id) ON DELETE CASCADE')
    expect(sql).toContain('gfs_desktop_operator_links_active_user_key')
    expect(sql).toContain('gfs_desktop_operator_links_active_admin_key')
    expect(sql).toContain('gfs_desktop_operator_links_revoked_at_idx')
    expect(sql).toContain("revoked_by_type = 'control_admin'")
    expect(sql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER')
  })
})

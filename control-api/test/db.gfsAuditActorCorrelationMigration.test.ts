import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0092_gfs_audit_actor_correlation migration', () => {
  it('adds separate Desktop actor/source fields without weakening legacy audit rows', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0092_gfs_audit_actor_correlation'
    )
    expect(migration).toBeDefined()
    expect(CONTROL_API_MIGRATIONS.at(-2)?.version).toBe('0091_gfs_desktop_operator_links')
    expect(CONTROL_API_MIGRATIONS.at(-1)?.version).toBe(migration?.version)

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS desktop_user_id UUID NULL')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS authority_source TEXT NULL')
    expect(sql).toContain('gfs_audit_actor_correlation_valid')
    expect(sql).toContain("authority_source = 'user-session'")
    expect(sql).toContain("authority_source = 'linked-admin'")
    expect(sql).toContain('actor_on_behalf_of IS NULL')
    expect(sql).toContain('actor_on_behalf_of IS NOT NULL')
    expect(sql).not.toContain("authorization_source = 'linked-admin'")
  })
})

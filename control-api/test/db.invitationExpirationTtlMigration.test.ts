import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0131_invitation_expiration_writer_compatibility migration', () => {
  it('restores 48-hour invitation defaults without rewriting existing rows', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const previous = versions.indexOf('0130_invitation_expiration_ttl_one_week')
    const current = versions.indexOf('0131_invitation_expiration_writer_compatibility')
    expect(previous).toBeGreaterThanOrEqual(0)
    expect(current).toBeGreaterThan(previous)

    const migration = CONTROL_API_MIGRATIONS[current]
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toMatch(
      /ALTER TABLE invitations\s+ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '48 hours'\)/i
    )
    expect(sql).toMatch(
      /ALTER TABLE control_admin_invitations\s+ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '48 hours'\)/i
    )
    expect(sql).not.toMatch(/UPDATE\s+(?:invitations|control_admin_invitations)/i)
  })
})

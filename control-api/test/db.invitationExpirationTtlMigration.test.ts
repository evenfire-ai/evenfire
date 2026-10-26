import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0130_invitation_expiration_ttl_one_week migration', () => {
  it('updates member and Control Admin invitation defaults without rewriting existing rows', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const previous = versions.indexOf('0129_workflow_schedules_concurrency_policy')
    const current = versions.indexOf('0130_invitation_expiration_ttl_one_week')
    expect(previous).toBeGreaterThanOrEqual(0)
    expect(current).toBeGreaterThan(previous)

    const migration = CONTROL_API_MIGRATIONS[current]
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toMatch(
      /ALTER TABLE invitations\s+ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '7 days'\)/i
    )
    expect(sql).toMatch(
      /ALTER TABLE control_admin_invitations\s+ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '7 days'\)/i
    )
    expect(sql).not.toMatch(/UPDATE\s+(?:invitations|control_admin_invitations)/i)
  })
})

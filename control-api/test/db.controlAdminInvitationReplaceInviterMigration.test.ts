import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0117_control_admin_invitation_replace_inviter migration', () => {
  it('runs after the invitation opened-status migration and adds a non-null false-default flag', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const openedStatus = versions.indexOf('0041_control_admin_invitation_opened_status')
    const replaceInviter = versions.indexOf('0117_control_admin_invitation_replace_inviter')
    expect(openedStatus).toBeGreaterThanOrEqual(0)
    expect(replaceInviter).toBeGreaterThan(openedStatus)

    const migration = CONTROL_API_MIGRATIONS[replaceInviter]
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('ALTER TABLE control_admin_invitations')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS replace_inviter BOOLEAN NOT NULL DEFAULT false')
  })
})

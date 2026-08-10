import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

describe('user-session and authorization revision foundation migration', () => {
  it('is additive, indexed for user-first access, and actively invalidates revisions', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0091_user_session_access_foundation'
    )

    expect(migration).toBeDefined()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_sessions')
    expect(sql).toContain('current_jti')
    expect(sql).toContain('prior_jti_expires_at')
    expect(sql).toContain('idle_expires_at')
    expect(sql).toContain('absolute_expires_at')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS team_members_user_active_idx')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_user_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_team_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_resource_revisions')
    expect(sql).toContain('authorization_bump_team_membership_revision')
    expect(sql).toContain('authorization_bump_user_grant_revision')
    expect(sql).toContain('authorization_bump_team_grant_revision')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const withdrawnInvitationTtlMigrations = [
  '0130_invitation_expiration_ttl_one_week',
  '0131_invitation_expiration_writer_compatibility',
]

function expectWithdrawnInvitationTtlMigrationsToBeAbsent(versions: string[]) {
  for (const version of withdrawnInvitationTtlMigrations) {
    expect(versions).not.toContain(version)
  }
}

describe('invitation migration registry', () => {
  it('keeps the withdrawn invitation-expiration migrations out of the registry', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    expectWithdrawnInvitationTtlMigrationsToBeAbsent(versions)
  })

  it('allows the unrelated migration introduced by PR #1197 after the current dev sequence', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const candidateVersions = [...versions, '0130_password_login_success_admission']

    expect(candidateVersions).toContain('0130_password_login_success_admission')
    expectWithdrawnInvitationTtlMigrationsToBeAbsent(candidateVersions)
  })
})

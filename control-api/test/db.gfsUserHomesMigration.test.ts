import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0139_gfs_user_homes'

function recordingQuery(appliedVersions: string[]) {
  return vi.fn(async (sql: string) =>
    sql.includes('SELECT version FROM schema_migrations')
      ? { rows: appliedVersions.map(version => ({ version })), rowCount: appliedVersions.length }
      : { rows: [], rowCount: 0 }
  )
}

describe('0139_gfs_user_homes migration', () => {
  it("registers exactly once, last, immediately after dev's 0138 and with no legacy name", async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const index = versions.indexOf(VERSION)

    expect(index).toBeGreaterThan(0)
    expect(versions[index - 1]).toBe('0138_legacy_password_security_epoch_backfill')
    expect(index).toBe(versions.length - 1)
    expect(versions.filter(version => version === VERSION)).toHaveLength(1)
    // The earlier names (0130/0131_gfs_user_homes) ran only on this branch's own
    // Minikube profiles and local databases. Those are recreated, so no receipt
    // under them is accepted.
    expect(CONTROL_API_MIGRATIONS[index].legacyVersions).toBeUndefined()
  })

  it('applies and records the migration on upgrade but does not rerun it once recorded', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const earlier = CONTROL_API_MIGRATIONS.map(migration => migration.version).filter(
      version => version !== VERSION
    )
    const upgradeQuery = recordingQuery(earlier)
    const upgradeRelease = vi.fn()
    await initDb({
      connect: vi.fn().mockResolvedValue({ query: upgradeQuery, release: upgradeRelease }),
    } as never)

    expect(
      upgradeQuery.mock.calls.filter(([sql]) => sql.includes('CREATE TABLE gfs_user_homes'))
    ).toHaveLength(1)
    expect(upgradeQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      [VERSION]
    )
    expect(upgradeRelease).toHaveBeenCalledOnce()

    const currentQuery = recordingQuery([...earlier, VERSION])
    const currentRelease = vi.fn()
    await initDb({
      connect: vi.fn().mockResolvedValue({ query: currentQuery, release: currentRelease }),
    } as never)

    expect(
      currentQuery.mock.calls.some(([sql]) => sql.includes('CREATE TABLE gfs_user_homes'))
    ).toBe(false)
    expect(currentRelease).toHaveBeenCalledOnce()
  })
})

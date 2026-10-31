import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0131_gfs_user_homes'

function recordingQuery(appliedVersions: string[]) {
  return vi.fn(async (sql: string) =>
    sql.includes('SELECT version FROM schema_migrations')
      ? { rows: appliedVersions.map(version => ({ version })), rowCount: appliedVersions.length }
      : { rows: [], rowCount: 0 }
  )
}

describe('0131_gfs_user_homes migration', () => {
  it('registers exactly once immediately after 0130 and keeps its earlier name', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const index = versions.indexOf(VERSION)

    expect(index).toBeGreaterThan(0)
    expect(versions[index - 1]).toBe('0130_password_login_success_admission')
    expect(versions.filter(version => version === VERSION)).toHaveLength(1)
    expect(CONTROL_API_MIGRATIONS[index].legacyVersions).toEqual(['0130_gfs_user_homes'])
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

  it('records 0131 without re-running DDL when only 0130_gfs_user_homes is recorded', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const earlier = CONTROL_API_MIGRATIONS.map(migration => migration.version).filter(
      version => version !== VERSION
    )
    const legacyQuery = recordingQuery([...earlier, '0130_gfs_user_homes'])
    const legacyRelease = vi.fn()
    await initDb({
      connect: vi.fn().mockResolvedValue({ query: legacyQuery, release: legacyRelease }),
    } as never)

    expect(
      legacyQuery.mock.calls.some(([sql]) => sql.includes('CREATE TABLE gfs_user_homes'))
    ).toBe(false)
    // Witness: the renamed migration is recorded, so the run is not a no-op.
    expect(legacyQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      [VERSION]
    )
    expect(legacyRelease).toHaveBeenCalledOnce()
  })

  it('accepts the legacy 0130_gfs_user_homes receipt as evidence for 0131', async () => {
    const { CONTROL_API_MIGRATIONS, assertDbReady } = await import('../src/db.js')
    const recorded = [
      ...CONTROL_API_MIGRATIONS.map(migration => migration.version).filter(
        version => version !== VERSION
      ),
      '0130_gfs_user_homes',
    ]
    const query = vi.fn(async (sql: string) =>
      sql.includes('password_admission_rollout_is_ready')
        ? { rows: [{ ready: true }], rowCount: 1 }
        : { rows: recorded.map(version => ({ version })), rowCount: recorded.length }
    )

    await expect(assertDbReady({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'))
  })
})

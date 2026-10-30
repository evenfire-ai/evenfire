import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0132_gfs_entry_introducer'

function recordingQuery(appliedVersions: string[]) {
  return vi.fn(async (sql: string) =>
    sql.includes('SELECT version FROM schema_migrations')
      ? { rows: appliedVersions.map(version => ({ version })), rowCount: appliedVersions.length }
      : { rows: [], rowCount: 0 }
  )
}

describe('0132_gfs_entry_introducer migration', () => {
  it('registers exactly once immediately after 0131_gfs_user_homes', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const index = versions.indexOf(VERSION)

    expect(index).toBeGreaterThan(0)
    expect(versions[index - 1]).toBe('0131_gfs_user_homes')
    expect(versions.filter(version => version === VERSION)).toHaveLength(1)
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
      upgradeQuery.mock.calls.filter(([sql]) =>
        sql.includes('ALTER TABLE gfs_grants ADD COLUMN IF NOT EXISTS introduced_by')
      )
    ).toHaveLength(1)
    expect(
      upgradeQuery.mock.calls.filter(([sql]) =>
        sql.includes('ALTER TABLE gfs_shares ADD COLUMN IF NOT EXISTS introduced_by')
      )
    ).toHaveLength(1)
    // Witness: the DDL run is not a no-op, the version is recorded.
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
      currentQuery.mock.calls.some(([sql]) =>
        sql.includes('ALTER TABLE gfs_grants ADD COLUMN IF NOT EXISTS introduced_by')
      )
    ).toBe(false)
    expect(
      currentQuery.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO schema_migrations(version)')
      )
    ).toBe(false)
    expect(currentRelease).toHaveBeenCalledOnce()
  })

  it('adds no default, backfill or constraint to the new column', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === VERSION)
    expect(migration).toBeDefined()
    if (!migration) return

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS introduced_by TEXT NULL/i)
    expect(sql).not.toMatch(/\bDEFAULT\b/i)
    expect(sql).not.toMatch(/\bUPDATE\b/i)
    expect(sql).not.toMatch(/\bCHECK\b/i)
    expect(sql).not.toMatch(/\bCREATE INDEX\b/i)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0132_gfs_user_file_activity'
const PREVIOUS = '0131_gfs_user_homes'

function recordingQuery(appliedVersions: string[]) {
  return vi.fn(async (sql: string) =>
    sql.includes('SELECT version FROM schema_migrations')
      ? { rows: appliedVersions.map(version => ({ version })), rowCount: appliedVersions.length }
      : { rows: [], rowCount: 0 }
  )
}

/** The migration body as PostgreSQL receives it. */
async function migrationSql(): Promise<string> {
  const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
  const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === VERSION)
  if (!migration) throw new Error(`${VERSION} is not registered`)
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  await migration.apply({ query } as never)
  return query.mock.calls.map(([statement]) => String(statement)).join('\n')
}

describe('0132_gfs_user_file_activity migration', () => {
  it('registers exactly once, immediately after 0131_gfs_user_homes', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const index = versions.indexOf(VERSION)

    expect(index).toBeGreaterThan(0)
    expect(versions[index - 1]).toBe(PREVIOUS)
    expect(versions.filter(version => version === VERSION)).toHaveLength(1)
  })

  it('applies and records the migration on upgrade but not once recorded', async () => {
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
      upgradeQuery.mock.calls.filter(([sql]) => sql.includes('CREATE TABLE gfs_user_file_activity'))
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
      currentQuery.mock.calls.some(([sql]) => sql.includes('CREATE TABLE gfs_user_file_activity'))
    ).toBe(false)
    expect(currentRelease).toHaveBeenCalledOnce()
  })

  it('adds the D14 host namespace as a nullable column without backfilling bindings', async () => {
    const sql = await migrationSql()

    expect(sql).toMatch(
      /ALTER TABLE governed_run_attribution_bindings\s+ADD COLUMN IF NOT EXISTS host_namespace TEXT NULL\s+CHECK/
    )
    // Nullable, and the CHECK admits NULL as well as a Kubernetes name.
    expect(sql).toMatch(/host_namespace IS NULL/)
    expect(sql).toMatch(/host_namespace ~ '\^\[a-z0-9\]/)
    // Nothing backfills the column: the binding table is append-only, so an
    // UPDATE would be refused and a guessed namespace would be fabricated.
    expect(sql).not.toMatch(/UPDATE governed_run_attribution_bindings/i)
  })

  it('creates the activity table, its recency index and the user-deletion cascade', async () => {
    const sql = await migrationSql()

    expect(sql).toMatch(/CREATE TABLE gfs_user_file_activity/)
    expect(sql).toMatch(/user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/resource_id UUID NOT NULL/)
    expect(sql).toMatch(/last_activity_at TIMESTAMPTZ NOT NULL/)
    expect(sql).toMatch(/PRIMARY KEY \(user_id, resource_id\)/)
    // No FK on resource_id: no product path hard-deletes resources.
    expect(sql).not.toMatch(/resource_id UUID NOT NULL REFERENCES/)
    expect(sql).toMatch(
      /CREATE INDEX gfs_user_file_activity_recent_idx\s+ON gfs_user_file_activity \(user_id, last_activity_at DESC, resource_id DESC\)/
    )
  })

  it('keeps both recording functions definer-only and trims the user to 100 rows', async () => {
    const sql = await migrationSql()

    for (const signature of [
      'gfs_record_user_file_activity(UUID, UUID[])',
      'gfs_record_agent_file_activity(TEXT, UUID, UUID[])',
    ]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[\\()[\]]/g, '\\$&')} FROM PUBLIC`)
      )
    }
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION gfs_record_user_file_activity\(UUID, UUID\[\]\)\s+TO control_api_runtime, gfs_controller;/
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION gfs_record_agent_file_activity\(TEXT, UUID, UUID\[\]\)\s+TO gfs_controller, gfs_controller_reader;/
    )
    // The runtime reads the table directly; every write goes through a function.
    expect(sql).toMatch(/GRANT SELECT ON TABLE gfs_user_file_activity TO control_api_runtime;/)
    expect(sql).toMatch(/OFFSET 99 LIMIT 1/)
    expect(sql).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]*ON TABLE gfs_user_file_activity/i
    )
  })

  it('is listed in the control-api runtime access contract as a read-only relation', () => {
    const tsv = readFileSync(
      new URL('../../deploy/scripts/control-api-runtime-access-profiles.tsv', import.meta.url),
      'utf8'
    )
    const rows = tsv
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
      .map(line => line.split('\t'))

    expect(rows.filter(([relation]) => relation === 'gfs_user_file_activity')).toEqual([
      ['gfs_user_file_activity', 'read'],
    ])
  })
})

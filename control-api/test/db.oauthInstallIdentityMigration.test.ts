import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0121_oauth_install_identity migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('is registered after the dynamic-clients table and its runtime-access grant', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)
    expect(versions).toContain('0121_oauth_install_identity')
    // The columns extend dynamic_clients, so the table (0119) and its runtime
    // grant (0120) must already exist when 0121 runs.
    expect(versions.indexOf('0119_dynamic_clients_table')).toBeLessThan(
      versions.indexOf('0121_oauth_install_identity')
    )
    expect(versions.indexOf('0120_dynamic_clients_runtime_access')).toBeLessThan(
      versions.indexOf('0121_oauth_install_identity')
    )
  })

  it('adds install_id + cr_uid to dynamic_clients and cr_uid to oauth_grants, with the bound/length CHECKs', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const ddl = sqls.find(
      sql =>
        sql.includes('ALTER TABLE dynamic_clients ADD COLUMN IF NOT EXISTS install_id UUID') &&
        sql.includes('cr_uid')
    )
    expect(ddl, 'the 0121 DDL was applied').toBeDefined()
    const sql = ddl as string

    // Additive + idempotent columns.
    expect(sql).toContain('ALTER TABLE dynamic_clients ADD COLUMN IF NOT EXISTS install_id UUID')
    expect(sql).toContain('ALTER TABLE dynamic_clients ADD COLUMN IF NOT EXISTS cr_uid TEXT')
    expect(sql).toContain('ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS cr_uid TEXT')

    // cr_uid length bound on both tables.
    expect(sql).toContain('dynamic_clients_cr_uid_len')
    expect(sql).toContain('oauth_grants_cr_uid_len')
    expect(sql).toContain('char_length(cr_uid) <= 128')

    // A bound row (cr_uid set) must carry an install_id.
    expect(sql).toContain('dynamic_clients_bound_needs_install')
    expect(sql).toContain('cr_uid IS NULL OR install_id IS NOT NULL')

    // Constraints are guarded on pg_constraint (no ADD CONSTRAINT IF NOT EXISTS
    // in Postgres) so a re-run is a no-op rather than a duplicate-object error.
    expect(sql).toContain('FROM pg_constraint')

    // Unique keys are UNCHANGED — the DDL touches no unique constraint/index.
    expect(sql).not.toContain('UNIQUE')

    const recordedVersions = clientQuery.mock.calls
      .filter(([q]) => String(q).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))
    expect(recordedVersions).toContain('0121_oauth_install_identity')
  })

  it('needs no new runtime-access grant — ADD COLUMN is covered by the table GRANTs', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    // No GRANT is emitted for the 0121 columns: they inherit the 0119/0120
    // table-level GRANTs. Any GRANT on dynamic_clients belongs to 0120, not here.
    const grantsInInstallIdentity = sqls.filter(
      sql => sql.includes('install_id') && sql.includes('cr_uid') && sql.includes('GRANT')
    )
    expect(grantsInInstallIdentity).toEqual([])
  })

  it('is idempotent — a second initDb re-runs the guarded DDL without error', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    await expect(initDb()).resolves.not.toThrow()
  })
})

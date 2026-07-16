import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})
vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0049_registry_connection migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates the registry_connection table and a singleton unique index', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS registry_connection')
    )
    // singleton: at most one row (partial unique on a constant column)
    expect(
      sqls.some(sql => /CREATE UNIQUE INDEX IF NOT EXISTS registry_connection_singleton/.test(sql))
    ).toBe(true)
    // secrets are stored encrypted (column names carry _encrypted)
    expect(
      sqls.some(sql => /private_key_encrypted/.test(sql) && /client_secret_encrypted/.test(sql))
    ).toBe(true)
    // registers under the 0049 version (recorded as a param to INSERT INTO schema_migrations)
    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))
    expect(recordedVersions).toContain('0049_registry_connection')
  })
})

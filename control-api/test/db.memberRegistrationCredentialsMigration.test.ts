import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})
vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0055_member_registration_credentials migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates the table with an active-domain partial unique index and encrypted secret column', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS member_registration_credentials')
    )
    // The rotation re-mint path depends on the LITERAL partial-index predicate (spec §8.8).
    expect(
      sqls.some(
        sql =>
          /CREATE UNIQUE INDEX IF NOT EXISTS member_registration_credentials_active_domain_idx/.test(
            sql
          ) &&
          /ON member_registration_credentials \(bound_domain\)/.test(sql) &&
          /WHERE revoked_at IS NULL/.test(sql)
      )
    ).toBe(true)
    expect(sqls.some(sql => /secret_encrypted/.test(sql))).toBe(true)
    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))
    expect(recordedVersions).toContain('0055_member_registration_credentials')
  })
})

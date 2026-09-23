import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0116_dynamic_clients_table migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('is registered LAST (the next free version after 0115)', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)
    expect(versions).toContain('0116_dynamic_clients_table')
    expect(versions.at(-1)).toBe('0116_dynamic_clients_table')
    expect(versions.indexOf('0115_llm_allowed_models_image_input')).toBeLessThan(
      versions.indexOf('0116_dynamic_clients_table')
    )
  })

  it('creates the dynamic_clients table with the encrypted columns, owner-unique constraint and issuer index', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const ddl = sqls.find(
      sql => sql.includes('CREATE TABLE IF NOT EXISTS dynamic_clients') && sql.includes('client_id')
    )
    expect(ddl, 'the dynamic_clients DDL was applied').toBeDefined()
    const sql = ddl as string

    // Idempotent create.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS dynamic_clients')

    // Owner coordinates mirror oauth_grants / the pre-registered Secret (DEC-18).
    expect(sql).toContain("owner_kind TEXT NOT NULL DEFAULT 'mcpserver'")
    expect(sql).toContain('server_namespace TEXT NOT NULL')
    expect(sql).toContain('server_name TEXT NOT NULL')
    expect(sql).toContain('issuer TEXT NOT NULL')
    expect(sql).toContain('client_id TEXT NOT NULL')
    expect(sql).toContain('client_mode TEXT NOT NULL')

    // Secret material is stored ENCRYPTED, never in the clear.
    expect(sql).toContain('client_secret_encrypted TEXT')
    expect(sql).toContain('registration_access_token_encrypted TEXT')
    expect(sql).toContain('registration_client_uri TEXT')
    expect(sql).toContain('client_id_issued_at TIMESTAMPTZ')
    expect(sql).toContain('client_secret_expires_at TIMESTAMPTZ')

    // One dynamic client per server CR.
    expect(sql).toContain(
      'CONSTRAINT dynamic_clients_owner_unique UNIQUE (owner_kind, server_namespace, server_name)'
    )

    // Issuer index (audit + future additive per-issuer dedup).
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS dynamic_clients_issuer_idx ON dynamic_clients (issuer)'
    )
  })

  it('is idempotent — a second initDb re-runs the IF NOT EXISTS DDL without error', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    await expect(initDb()).resolves.not.toThrow()
  })
})

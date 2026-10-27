import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0130_oidc_protocol_attempts'

describe(`${VERSION} migration`, () => {
  it('is registered after the latest development migration', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    expect(CONTROL_API_MIGRATIONS.at(-1)?.version).toBe(VERSION)
    expect(CONTROL_API_MIGRATIONS.at(-2)?.version).toBe(
      '0129_workflow_schedules_concurrency_policy'
    )
  })

  it('creates only purpose-bound OIDC protocol attempts with encrypted transient proof inputs', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === VERSION)
    expect(migration).toBeDefined()
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query } as never)

    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS oidc_protocol_attempts')
    expect(sql).toContain("purpose TEXT NOT NULL CHECK (purpose = 'identity-proof-v1')")
    expect(sql).toContain("status IN ('pending', 'redeeming', 'completed', 'failed', 'cancelled')")
    expect(sql).toContain('pkce_verifier_encrypted TEXT')
    expect(sql).toContain('nonce_encrypted TEXT')
    expect(sql).toContain("response_mode TEXT NOT NULL CHECK (response_mode = 'query')")
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oidc_protocol_attempts TO control_api_runtime'
    )
    expect(sql).not.toMatch(
      /CREATE TABLE IF NOT EXISTS (users|teams|invitations|sessions|access_requests)/i
    )
  })

  it('applies exactly once through initDb after earlier migrations are present', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const applied = CONTROL_API_MIGRATIONS.filter(candidate => candidate.version !== VERSION).map(
      candidate => ({
        version: candidate.version,
      })
    )
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT version FROM schema_migrations')
        ? { rows: applied, rowCount: applied.length }
        : { rows: [], rowCount: 0 }
    )
    const release = vi.fn()
    await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)

    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('oidc_protocol_attempts'))
    ).toHaveLength(1)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      [VERSION]
    )
    expect(release).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0094_desktop_user_retirement_lifecycle migration', () => {
  it('is ordered after operator-link generations and backfills an additive active lifecycle', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    expect(versions.indexOf('0094_desktop_user_retirement_lifecycle')).toBeGreaterThan(
      versions.indexOf('0093_gfs_desktop_operator_link_generations')
    )

    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0094_desktop_user_retirement_lifecycle'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lifecycle_state TEXT')
    expect(sql).toContain("lifecycle_state = COALESCE(lifecycle_state, 'active')")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lifecycle_version BIGINT')
    expect(sql).toContain("lifecycle_state = 'retired'")
    expect(sql).toContain('retired_by_control_admin_id')
    expect(sql).toContain('retired_by_desktop_user_id')
    expect(sql).toContain('retirement_operation_id')
  })

  it('stores only scoped, hashed idempotency outcomes with separated actor identities', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0094_desktop_user_retirement_lifecycle'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS desktop_user_retirement_operations')
    expect(sql).toContain("operation = 'retire_desktop_user'")
    expect(sql).toContain("actor_type IN ('control_admin', 'platform_user')")
    expect(sql).toContain("idempotency_key_hash ~ '^[0-9a-f]{64}$'")
    expect(sql).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'")
    expect(sql).toContain("outcome IN ('retired', 'deleted')")
    expect(sql).toContain('desktop_user_retirement_operations_control_admin_key')
    expect(sql).toContain('desktop_user_retirement_operations_platform_user_key')
    expect(sql).toContain('a legacy-compatible hard-delete for')
    expect(sql).not.toContain('idempotency_key TEXT NOT NULL')
  })

  it('preserves restricted lifecycle parents and broadens link revocation without cascade', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0094_desktop_user_retirement_lifecycle'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('REFERENCES control_admin_users(id) ON DELETE RESTRICT')
    expect(sql).toContain('REFERENCES users(id) ON DELETE RESTRICT')
    expect(sql).toContain('revoked_by_control_admin_id')
    expect(sql).toContain('revoked_by_desktop_user_id')
    expect(sql).toContain("revoked_by_type = 'platform_user'")
    expect(sql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER')
    expect(sql).not.toContain('desktop_user_retirement_operations(id) ON DELETE CASCADE')
  })
})

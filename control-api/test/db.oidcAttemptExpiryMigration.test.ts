import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const VERSION = '0132_oidc_protocol_attempt_expiry_index'

describe(`${VERSION} migration`, () => {
  it('follows the existing OIDC attempt schema without rewriting its receipt', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const schemaIndex = CONTROL_API_MIGRATIONS.findIndex(
      migration => migration.version === '0131_oidc_protocol_attempts'
    )
    const upgrade = CONTROL_API_MIGRATIONS.find(migration => migration.version === VERSION)

    expect(schemaIndex).toBeGreaterThanOrEqual(0)
    expect(CONTROL_API_MIGRATIONS[schemaIndex + 1]?.version).toBe(VERSION)
    expect(upgrade).toBeDefined()
  })

  it('does not create protocol-attempt state when only a legacy receipt exists', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const upgrade = CONTROL_API_MIGRATIONS.find(migration => migration.version === VERSION)
    const query = vi.fn().mockResolvedValue({ rows: [{ relation: null }], rowCount: 1 })

    await upgrade!.apply({ query } as never)

    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "to_regclass('public.oidc_protocol_attempts')"
    )
  })

  it('adds the all-state ordered index before removing the pending-only index', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const upgrade = CONTROL_API_MIGRATIONS.find(migration => migration.version === VERSION)
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ relation: 'public.oidc_protocol_attempts' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await upgrade!.apply({ query } as never)

    expect(query).toHaveBeenCalledTimes(2)
    const sql = String(query.mock.calls[1]?.[0])
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS oidc_protocol_attempts_expiry_idx')
    expect(sql).toContain('(expires_at, id)')
    expect(sql).toContain('DROP INDEX IF EXISTS public.oidc_protocol_attempts_pending_expiry_idx')
    expect(sql.indexOf('CREATE INDEX')).toBeLessThan(sql.indexOf('DROP INDEX'))
    expect(sql).not.toMatch(/CREATE TABLE/i)
  })
})

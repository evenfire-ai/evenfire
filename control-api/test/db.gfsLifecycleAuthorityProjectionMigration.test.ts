import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0095_gfs_lifecycle_authority_projection migration', () => {
  it('follows the retirement lifecycle migration and grants only the resolver projection', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    expect(versions.indexOf('0095_gfs_lifecycle_authority_projection')).toBeGreaterThan(
      versions.indexOf('0094_desktop_user_retirement_lifecycle')
    )

    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0095_gfs_lifecycle_authority_projection'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('GRANT SELECT (id, lifecycle_state, lifecycle_version)')
    expect(sql).toContain('GRANT SELECT (id, status, session_version)')
    expect(sql).toContain(
      'GRANT SELECT (id, lineage_id, generation, user_id, control_admin_id, state, source)'
    )
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    expect(sql).toContain('gfs_controller, gfs_controller_reader')
    expect(sql).toContain('FROM PUBLIC')
  })
})

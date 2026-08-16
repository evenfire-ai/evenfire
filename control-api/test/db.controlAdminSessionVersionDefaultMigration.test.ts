import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('0096_control_admin_session_version_default migration', () => {
  it('runs after the lifecycle projection and makes the authorization epoch one-based', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const sessionVersionMigration = versions.indexOf('0031_control_admin_session_version')
    const lifecycleProjectionMigration = versions.indexOf('0095_gfs_lifecycle_authority_projection')
    const defaultMigration = versions.indexOf('0096_control_admin_session_version_default')
    expect(sessionVersionMigration).toBeGreaterThanOrEqual(0)
    expect(lifecycleProjectionMigration).toBeGreaterThan(sessionVersionMigration)
    expect(defaultMigration).toBeGreaterThan(lifecycleProjectionMigration)
    expect(defaultMigration).toBe(versions.length - 1)

    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0096_control_admin_session_version_default'
    )
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration!.apply({ query })
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('SET session_version = 1')
    expect(sql).toContain('ALTER COLUMN session_version SET DEFAULT 1')
    expect(sql).toContain('ALTER COLUMN session_version SET NOT NULL')
    expect(sql).toContain('control_admin_session_version_positive')
    expect(sql).toContain('CHECK (session_version >= 1)')
  })
})

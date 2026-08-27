import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: { databaseUrl: 'postgresql://test' },
}))

describe('0105 GFS catalog revision components migration', () => {
  it('fixes forward after a database has already recorded migration 0104', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0105_gfs_catalog_revision_components'
    )
    const composableIndex = CONTROL_API_MIGRATIONS.findIndex(
      candidate => candidate.version === '0104_composable_catalog_revisions'
    )
    const gfsIndex = CONTROL_API_MIGRATIONS.findIndex(
      candidate => candidate.version === '0105_gfs_catalog_revision_components'
    )
    expect(migration).toBeDefined()
    expect(gfsIndex).toBe(composableIndex + 1)

    const recordedVersions = CONTROL_API_MIGRATIONS.filter(
      candidate => candidate.version !== migration?.version
    ).map(candidate => ({ version: candidate.version }))
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: recordedVersions, rowCount: recordedVersions.length }
      }
      return { rows: [], rowCount: params?.length ?? 0 }
    })
    const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }))

    await initDb({ connect })

    const appliedSql = clientQuery.mock.calls.map(([sql]) => String(sql)).join('\n')
    expect(appliedSql).toContain('authorization_catalog_environment')
    expect(appliedSql).toContain('authorization_bump_gfs_resource_component')
    expect(appliedSql).toContain('authorization_bump_gfs_resource_revision')
    expect(appliedSql).toContain('INSERT INTO authorization_resource_revisions')
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations'),
      ['0105_gfs_catalog_revision_components']
    )
  })
})

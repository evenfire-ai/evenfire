import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return {
    connect: mockConnect,
    query: vi.fn(),
  }
})

vi.mock('pg', () => ({
  Pool: mockPoolCtor,
}))

// Migration 0048: the gfs (Global File System) permission store — resources,
// folder grants, URI-bound shares, append-only hash-chained audit, plus the
// gfsc least-privilege role. No tenant_id (that is the managed P6 edition).
describe('db migration 0048_gfs_permission_store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    // schema_migrations empty → every migration (incl. 0048) runs.
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates the four gfs tables with spec-correct shape', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS gfs_resources'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS gfs_grants'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS gfs_shares'))
    expect(sqls).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS gfs_audit'))

    // resource_id is the immutable PK; bytes are keyed by it.
    const resources = sqls.find(s => s.includes('CREATE TABLE IF NOT EXISTS gfs_resources'))
    expect(resources).toContain('resource_id UUID PRIMARY KEY')
    expect(resources).toContain(
      'parent_resource_id UUID NULL REFERENCES gfs_resources(resource_id)'
    )
    expect(resources).toContain('deleted_at TIMESTAMPTZ NULL')
  })

  it('grants/shares use the spec {type,id} subject and grants carry an inherit flag', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const grants = sqls.find(s => s.includes('CREATE TABLE IF NOT EXISTS gfs_grants'))
    // Structured subject {type, id?} — operator has no id (subject_id default '').
    expect(grants).toContain(
      "subject_type TEXT NOT NULL CHECK (subject_type IN ('operator','user','team','host','context'))"
    )
    expect(grants).toContain("subject_id TEXT NOT NULL DEFAULT ''")
    // §Inheritance: no inherit-down unless inherit = true.
    expect(grants).toContain('inherit BOOLEAN NOT NULL DEFAULT false')
    expect(grants).toContain('UNIQUE (drive, resource_id, subject_type, subject_id)')

    const shares = sqls.find(s => s.includes('CREATE TABLE IF NOT EXISTS gfs_shares'))
    expect(shares).toContain('subject_type TEXT NOT NULL')
    expect(shares).toContain("subject_id TEXT NOT NULL DEFAULT ''")
    expect(shares).toContain('include_descendants BOOLEAN NOT NULL DEFAULT false')
  })

  it('enforces sibling uniqueness with a partial unique index (non-deleted only)', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const idx = sqls.find(s => s.includes('gfs_resources_sibling_uniq'))
    expect(idx).toBeDefined()
    expect(idx).toContain('(drive, parent_resource_id, name)')
    expect(idx).toContain('WHERE deleted_at IS NULL')
    // Exactly one synthetic root per drive (NULL parent is not deduped by the
    // sibling index, so the root needs its own partial unique index).
    expect(idx).toContain('gfs_resources_root_uniq')
    expect(idx).toContain('WHERE parent_resource_id IS NULL AND deleted_at IS NULL')
  })

  it('the audit table is append-only and hash-chained', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const audit = sqls.find(s => s.includes('CREATE TABLE IF NOT EXISTS gfs_audit'))
    expect(audit).toContain('sequence_no BIGSERIAL PRIMARY KEY')
    expect(audit).toContain('prev_hash TEXT NULL')
    expect(audit).toContain('row_hash TEXT NOT NULL')
  })

  it('gfsc role is least-privilege: writer can mutate resources but not grants or audit', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const grants = sqls.find(s => s.includes('GRANT INSERT ON gfs_audit TO gfs_controller'))
    expect(grants).toBeDefined()
    // gfsc can read the permission store but never write grants/shares.
    expect(grants).toContain(
      'GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller'
    )
    expect(grants).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_grants FROM gfs_controller'
    )
    expect(grants).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_shares FROM gfs_controller'
    )
    expect(grants).toContain('GRANT INSERT, UPDATE ON gfs_resources TO gfs_controller')
    expect(grants).toContain('REVOKE DELETE, TRUNCATE ON gfs_resources FROM gfs_controller')
    expect(grants).not.toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_resources')
    // Audit is append-only: gfsc may INSERT but never mutate history.
    expect(grants).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit FROM gfs_controller')
    // The role is created NOLOGIN — no credential lives in code.
    const role = sqls.find(s => s.includes("rolname = 'gfs_controller'"))
    expect(role).toContain('CREATE ROLE gfs_controller NOLOGIN')
  })

  it('invalidates gfsc authorization cache on resource hierarchy changes', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const invalidation = sqls.find(s => s.includes('gfs_resources_perm_invalidate'))
    expect(invalidation).toBeDefined()
    expect(invalidation).toContain(
      'AFTER UPDATE OF parent_resource_id, deleted_at OR DELETE OR TRUNCATE'
    )
    expect(invalidation).toContain('ON gfs_resources')
    expect(invalidation).toContain('gfs_notify_perm_invalidate')
  })

  it('records the 0043 version exactly once', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0048_gfs_permission_store'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('applies on BOTH fresh (baseline) and existing (migration) cluster paths', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    // Baseline (0001) calls the same schema function as migration 0048, so on a
    // fresh DB the gfs DDL is emitted by both paths — proving fresh clusters get
    // the tables, not only already-migrated ones.
    const ddlCount = sqls.filter(s => s.includes('CREATE TABLE IF NOT EXISTS gfs_resources')).length
    expect(ddlCount).toBeGreaterThanOrEqual(2)
  })

  it('has NO tenant_id column (multi-tenancy is the managed P6 edition)', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const gfsDdl = sqls.filter(s => s.includes('gfs_resources') || s.includes('gfs_grants'))
    for (const sql of gfsDdl) {
      expect(sql).not.toMatch(/tenant_id/i)
    }
  })
})

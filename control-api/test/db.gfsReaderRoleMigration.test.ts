import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('0072_gfs_reader_database_role', () => {
  it('adds a NOLOGIN least-privilege reader after immutable blob generations', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    const previous = source.indexOf("version: '0071_gfs_immutable_blob_generations'")
    const start = source.indexOf("version: '0072_gfs_reader_database_role'")
    const sql = source.slice(
      start,
      source.indexOf("version: '0073_gfs_audit_decision_evidence'", start)
    )

    expect(previous).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(previous)
    expect(sql).toContain('CREATE ROLE gfs_controller_reader NOLOGIN')
    expect(sql).toContain(
      'NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(sql).toContain("WHERE member_role.rolname = 'gfs_controller_reader'")
    expect(sql).toContain('REVOKE %I FROM gfs_controller_reader')
    expect(sql).toContain(
      'GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller_reader'
    )
    expect(sql).toContain('GRANT SELECT (id, status) ON control_admin_users')
    expect(sql).toContain('GRANT SELECT (team_id, user_id, status) ON team_members')
    expect(sql).toContain('GRANT INSERT ON gfs_audit TO gfs_controller_reader')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON gfs_blob_manifests FROM gfs_controller_reader')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_resources')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit')
    expect(sql).not.toMatch(/ALTER ROLE gfs_controller\s/)
    expect(sql).not.toMatch(/DROP\s+(ROLE|TABLE|COLUMN)/i)
  })
})

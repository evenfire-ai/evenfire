import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('0074_gfs_runtime_role_exact_contract', () => {
  it('normalizes both roles without changing credential state', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    const previous = source.indexOf("version: '0073_gfs_audit_decision_evidence'")
    const start = source.indexOf("version: '0074_gfs_runtime_role_exact_contract'")
    const sql = source.slice(start, source.indexOf('\n  },\n]', start))

    expect(start).toBeGreaterThan(previous)
    expect(sql).toContain(
      'ALTER ROLE gfs_controller\n          NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(sql).toContain(
      'ALTER ROLE gfs_controller_reader\n          NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    )
    expect(sql).not.toMatch(/ALTER ROLE gfs_controller(?:_reader)?\s+(?:NO)?LOGIN/)
    expect(sql).not.toMatch(/ALTER\s+ROLE[^;]*PASSWORD|DROP\s+ROLE/i)
    expect(sql).toContain("ARRAY['gfs_controller', 'gfs_controller_reader']")
    expect(sql).toContain("EXECUTE format('REVOKE %I FROM %I'")
  })

  it('rebuilds exact table, sequence, audit, and subject-column grants', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    const start = source.indexOf("version: '0074_gfs_runtime_role_exact_contract'")
    const sql = source.slice(start, source.indexOf('\n  },\n]', start))

    expect(sql).toContain(
      'gfs_blob_manifests, gfs_audit FROM gfs_controller, gfs_controller_reader, PUBLIC'
    )
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON gfs_resources TO gfs_controller')
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON gfs_blob_manifests TO gfs_controller'
    )
    expect(sql).toContain(
      'GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller_reader'
    )
    expect(sql).toContain('GRANT INSERT ON gfs_audit TO gfs_controller_reader')
    expect(sql).toContain(
      'GRANT SELECT (id, status) ON control_admin_users\n          TO gfs_controller, gfs_controller_reader'
    )
    expect(sql).toContain(
      'GRANT SELECT (team_id, user_id, status) ON team_members\n          TO gfs_controller, gfs_controller_reader'
    )
  })
})

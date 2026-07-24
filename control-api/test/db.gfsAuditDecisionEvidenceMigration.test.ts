import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('0073_gfs_audit_decision_evidence', () => {
  it('adds constrained decision evidence without rewriting existing audit rows', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    const previous = source.indexOf("version: '0072_gfs_reader_database_role'")
    const start = source.indexOf("version: '0073_gfs_audit_decision_evidence'")
    const sql = source.slice(start, source.indexOf('\n  },\n]', start))

    expect(previous).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(previous)
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'legacy'")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS matched_subject TEXT NULL')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS authorization_source TEXT NULL')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS cached_authorization_source TEXT NULL')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS mutation_outcome TEXT NULL')
    expect(sql).toContain("'direct_grant', 'inherited_grant', 'direct_share'")
    expect(sql).toContain("'inherited_share', 'operator', 'cache'")
    expect(sql).toContain("mutation_outcome IN ('succeeded', 'failed')")
    expect(sql).toContain("record_type = 'authorization_decision' AND mutation_outcome IS NULL")
    expect(sql).toContain("record_type = 'mutation_outcome' AND mutation_outcome IS NOT NULL")
    expect(sql).toContain('GRANT INSERT ON gfs_audit TO gfs_controller, gfs_controller_reader')
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit\n          FROM gfs_controller, gfs_controller_reader'
    )
    expect(sql).not.toMatch(/UPDATE\s+gfs_audit|DELETE\s+FROM\s+gfs_audit/i)
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i)
  })
})

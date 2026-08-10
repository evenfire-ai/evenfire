import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('0091_gfs_upload_sessions', () => {
  it('is additive and keeps the protocol ceiling separate from the product policy', () => {
    const schema = readFileSync(
      new URL('../src/services/gfsUploadSchema.ts', import.meta.url),
      'utf8'
    )
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')

    expect(source).toContain("version: '0091_gfs_upload_sessions'")
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS gfs_upload_sessions')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS gfs_upload_parts')
    expect(schema).toContain('expected_bytes BETWEEN 0 AND 1073741824')
    expect(schema).toContain('part_bytes BETWEEN 1048576 AND 16777216')
    expect(schema).toContain('part_count BETWEEN 0 AND 1024')
    expect(schema).toContain('UNIQUE (owner_subject, drive, idempotency_key)')
    expect(schema).toContain('UNIQUE (upload_id, offset_bytes)')
    expect(schema).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE gfs_upload_sessions, gfs_upload_parts FROM PUBLIC'
    )
    expect(schema).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE gfs_upload_sessions, gfs_upload_parts FROM gfs_controller_reader'
    )
    expect(schema).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE gfs_upload_sessions, gfs_upload_parts TO gfs_controller'
    )
    expect(schema).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(schema).not.toContain('209715200')
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function runtimeAccessProfile(): Map<string, string> {
  const source = readFileSync(
    new URL('../../deploy/scripts/control-api-runtime-access-profiles.tsv', import.meta.url),
    'utf8'
  )
  return new Map(
    source
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t') as [string, string])
  )
}

describe('0097_gfs_upload_sessions', () => {
  it('is additive and keeps the protocol ceiling separate from the product policy', () => {
    const schema = readFileSync(
      new URL('../src/services/gfsUploadSchema.ts', import.meta.url),
      'utf8'
    )
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')

    expect(source).toContain("version: '0097_gfs_upload_sessions'")
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

  it('classifies every upload relation as inaccessible to control_api_runtime', () => {
    const schema = readFileSync(
      new URL('../src/services/gfsUploadSchema.ts', import.meta.url),
      'utf8'
    )
    const uploadRelations = [
      ...schema.matchAll(/CREATE TABLE IF NOT EXISTS (gfs_upload_[a-z0-9_]+)/g),
    ]
      .map(([, relation]) => relation)
      .sort()
    const profile = runtimeAccessProfile()

    expect(uploadRelations).toEqual(['gfs_upload_parts', 'gfs_upload_sessions'])
    expect(uploadRelations.map(relation => [relation, profile.get(relation)])).toEqual([
      ['gfs_upload_parts', 'none'],
      ['gfs_upload_sessions', 'none'],
    ])
  })

  it('registers the additive finalizing recovery migration', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    const schema = readFileSync(
      new URL('../src/services/gfsUploadSchema.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain("version: '0099_gfs_upload_finalizing_recovery'")
    expect(schema).toContain('finalizing_started_at TIMESTAMPTZ')
  })
})

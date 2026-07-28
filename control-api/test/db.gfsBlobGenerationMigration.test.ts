import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('0071_gfs_immutable_blob_generations', () => {
  it('is one additive migration with generation pointers, cleanup state, and path invalidation', () => {
    const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
    expect(source.match(/version: '0071_gfs_immutable_blob_generations'/g)).toHaveLength(1)
    const start = source.indexOf("version: '0071_gfs_immutable_blob_generations'")
    const sql = source.slice(start, source.indexOf("\n  },\n]", start))

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS blob_key TEXT NULL')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS content_sha256 TEXT NULL')
    expect(sql).toContain("split_part(blob_key, '/', 1) = replace(resource_id::text, '-', '')")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gfs_blob_manifests')
    expect(sql).toContain('request_id UUID NOT NULL')
    expect(sql).toContain("state IN ('staged', 'committed', 'deleting')")
    expect(sql).toContain('UPDATE OF parent_resource_id, name, path_cache, deleted_at')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON gfs_blob_manifests')
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
  })
})

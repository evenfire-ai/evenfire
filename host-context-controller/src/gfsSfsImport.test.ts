import { describe, expect, it } from 'vitest'
import { SfsImportError, assertImportWritable, importSfsTree } from './gfsSfsImport'

/**
 * P5-S01 — SFS import (import-only). Imported SFS is browsable under
 * /shared/<name>/ and READ-ONLY: gfs never writes the SFS tree.
 */

describe('importSfsTree', () => {
  it('surfaces entries under /shared/<sfs-name>/ as read-only resources', () => {
    const out = importSfsTree('teamdrive', [
      { path: 'docs', kind: 'directory' },
      { path: 'docs/readme.md', kind: 'file' },
    ])
    expect(out).toEqual([
      { path: '/shared/teamdrive/docs', kind: 'directory', readOnly: true },
      { path: '/shared/teamdrive/docs/readme.md', kind: 'file', readOnly: true },
    ])
  })

  it('rejects path traversal in an SFS entry', () => {
    expect(() => importSfsTree('d', [{ path: '../etc/passwd', kind: 'file' }])).toThrow(
      SfsImportError
    )
  })

  it('rejects an invalid sfs name', () => {
    expect(() => importSfsTree('a/b', [])).toThrow(SfsImportError)
  })
})

describe('assertImportWritable', () => {
  it('rejects a write to an imported (read-only) resource', () => {
    expect(() => assertImportWritable({ readOnly: true })).toThrow(SfsImportError)
    try {
      assertImportWritable({ readOnly: true })
    } catch (e) {
      expect((e as SfsImportError).code).toBe('sfs_import_read_only')
    }
  })

  it('allows a write to a non-imported resource', () => {
    expect(() => assertImportWritable({ readOnly: false })).not.toThrow()
  })
})

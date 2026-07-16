/**
 * SFS → gfs import (spec community.md §Storage-plane taxonomy, §Operator
 * workflows; plan P5-S01). Existing SharedFileSystem trees are surfaced in gfs
 * under `/shared/<sfs-name>/…` with equivalent permissions, IMPORT-ONLY: gfs
 * never writes the SFS tree — imported resources are read-only, and a write to
 * one is rejected. Pure mapping + the write guard; the reconcile/index is I/O.
 */

export const SFS_IMPORT_ROOT = '/shared'

export type GfsKind = 'file' | 'directory'

export interface SfsEntry {
  /** Path relative to the SFS root (e.g. "docs/readme.md"). */
  path: string
  kind: GfsKind
}

export interface ImportedResource {
  /** Absolute gfs path under /shared/<sfs-name>/. */
  path: string
  kind: GfsKind
  /** Imports are read-only — gfs never writes the SFS tree. */
  readOnly: true
}

export class SfsImportError extends Error {
  constructor(
    readonly code: 'path_invalid' | 'sfs_import_read_only',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'SfsImportError'
  }
}

function joinUnderSfs(sfsName: string, rel: string): string {
  const clean = rel.split('/').filter(s => s.length > 0 && s !== '.' && s !== '..')
  if (clean.length !== rel.split('/').filter(s => s.length > 0).length) {
    throw new SfsImportError('path_invalid', `unsafe SFS path: ${JSON.stringify(rel)}`)
  }
  return [SFS_IMPORT_ROOT, sfsName, ...clean].join('/')
}

/** Map an SFS tree to read-only gfs resources under /shared/<sfsName>/. */
export function importSfsTree(sfsName: string, entries: SfsEntry[]): ImportedResource[] {
  if (!sfsName || sfsName.includes('/')) {
    throw new SfsImportError('path_invalid', `invalid sfs name: ${JSON.stringify(sfsName)}`)
  }
  return entries.map(entry => ({
    path: joinUnderSfs(sfsName, entry.path),
    kind: entry.kind,
    readOnly: true,
  }))
}

/** gfs never writes the SFS tree — a write to an imported resource is rejected. */
export function assertImportWritable(resource: { readOnly: boolean }): void {
  if (resource.readOnly) {
    throw new SfsImportError('sfs_import_read_only', 'gfs does not write the imported SFS tree')
  }
}

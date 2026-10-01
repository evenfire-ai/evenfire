import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type FsPort, nodeFs } from './fsPort'
import {
  type Binding,
  type CandidateId,
  CanonicalStoreError,
  type FileFingerprint,
  LIMITS,
} from './types'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SQLITE_FILES = [
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'state.db-journal',
] as const
export function assertUuid(
  value: unknown,
  reason: 'JournalInvalid' | 'AdoptBindingMismatch' = 'JournalInvalid'
): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new CanonicalStoreError(reason)
}
export function validateBinding(binding: Binding): void {
  for (const key of ['hostUid', 'pvcUid'] as const) {
    if (
      typeof binding[key] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(binding[key])
    ) {
      throw new CanonicalStoreError(key === 'hostUid' ? 'HostUidMismatch' : 'PvcUidMismatch')
    }
  }
}
export function compareBinding(actual: Binding, expected: Binding): void {
  validateBinding(expected)
  if (actual.hostUid !== expected.hostUid) throw new CanonicalStoreError('HostUidMismatch')
  if (actual.pvcUid !== expected.pvcUid) throw new CanonicalStoreError('PvcUidMismatch')
}
export function exists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
/** Validate every existing ancestor without following links, including ancestors above root. */
export function safePath(root: string, file: string, allowMissing = false): string {
  const base = path.resolve(root)
  const target = path.resolve(file)
  const relative = path.relative(base, target)
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new CanonicalStoreError('LayoutUnsafe')
  }
  const components = target.split(path.sep).filter(Boolean)
  let current = path.parse(target).root
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i])
    if (!exists(current)) {
      if (allowMissing) break
      throw new CanonicalStoreError('LayoutUnsafe')
    }
    const stat = fs.lstatSync(current)
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1) ||
      (i < components.length - 1 && !stat.isDirectory())
    )
      throw new CanonicalStoreError('LayoutUnsafe')
    if (fs.realpathSync(current) !== current) throw new CanonicalStoreError('LayoutUnsafe')
  }
  if (!exists(base) || !fs.lstatSync(base).isDirectory())
    throw new CanonicalStoreError('LayoutUnsafe')
  return target
}
export function privateDirectory(root: string, directory: string, port: FsPort = nodeFs): void {
  const target = safePath(root, directory, true)
  let current = path.resolve(root)
  for (const component of path.relative(current, target).split(path.sep).filter(Boolean)) {
    const parent = current
    current = path.join(current, component)
    if (!exists(current)) port.mkdirSync(current, { mode: 0o700 })
    safePath(root, current)
    if (!fs.statSync(current).isDirectory()) throw new CanonicalStoreError('LayoutUnsafe')
    // Existing names may be remnants of a process cut after mkdir but before the parent's fsync.
    // Repeat both synchronizations before descending or moving any original source.
    syncDirectory(root, current, port)
    syncDirectory(root, parent, port)
  }
}
export function syncDirectory(root: string, directory: string, port: FsPort = nodeFs): void {
  safePath(root, directory)
  const fd = port.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    port.fsyncSync(fd)
  } finally {
    port.closeSync(fd)
  }
}
export function syncFile(root: string, file: string, port: FsPort = nodeFs): void {
  safePath(root, file)
  const fd = port.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    port.fsyncSync(fd)
  } finally {
    port.closeSync(fd)
  }
}
export function candidateDirectory(root: string, id: CandidateId): string {
  if (id === 'C_root') return root
  if (id === 'C_ws') return path.join(root, 'workspace')
  if (id === 'C_state') return path.join(root, 'state')
  if (id.startsWith('C_import:')) {
    const suffix = id.slice('C_import:'.length)
    assertUuid(suffix)
    return path.join(root, '.canonical-store-import', suffix)
  }
  throw new CanonicalStoreError('JournalInvalid')
}
export function operationDirectory(root: string, migrationId: string): string {
  assertUuid(migrationId)
  return path.join(root, 'state', '.canonical-store', migrationId)
}
export function candidateKey(id: CandidateId): string {
  return id.startsWith('C_import:') ? `C_import-${id.slice(9)}` : id
}
export function fileHash(
  root: string,
  file: string,
  deadline = Date.now() + LIMITS.timeoutMs,
  port: FsPort = nodeFs
): string {
  safePath(root, file)
  const hash = createHash('sha256')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const bytes = Buffer.allocUnsafe(64 * 1024)
  try {
    let read: number
    while ((read = port.readSync(fd, bytes, 0, bytes.length, null)) > 0) {
      if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
      hash.update(bytes.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => stableJson(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
export function objectHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}
export function validateSqliteSetPaths(root: string, file: string): number {
  let bytes = 0
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${file}${suffix}`
    if (!exists(target)) continue
    safePath(root, target)
    const stat = fs.lstatSync(target)
    if (!stat.isFile()) throw new CanonicalStoreError('LayoutUnsafe')
    bytes += stat.size
    if (bytes > LIMITS.maxBytes) throw new CanonicalStoreError('ManifestTooLarge')
  }
  return bytes
}
export function fingerprints(root: string, directory: string): FileFingerprint[] {
  return SQLITE_FILES.map(name => {
    const file = path.join(directory, name)
    if (!exists(file)) return { name, present: false, size: 0, sha256: null }
    safePath(root, file)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > LIMITS.maxBytes)
      throw new CanonicalStoreError('ManifestTooLarge')
    return { name, present: true, size: stat.size, sha256: fileHash(root, file) }
  })
}
export function treeFingerprint(
  root: string,
  target: string
): { fingerprint: string; size: number; identity: { dev: number; ino: number }; entries: number } {
  const rows: unknown[] = []
  let size = 0
  function visit(file: string): void {
    safePath(root, file)
    if (rows.length >= LIMITS.maxEntries) throw new CanonicalStoreError('ManifestTooLarge')
    const stat = fs.lstatSync(file)
    const relative = path.relative(target, file)
    if (stat.isDirectory()) {
      rows.push(['directory', relative, stat.mode, stat.uid, stat.gid])
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name))
    } else {
      size += stat.size
      if (size > LIMITS.maxBytes) throw new CanonicalStoreError('ManifestTooLarge')
      rows.push(['file', relative, stat.mode, stat.uid, stat.gid, stat.size, fileHash(root, file)])
    }
  }
  visit(target)
  const stat = fs.lstatSync(target)
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino))
    throw new CanonicalStoreError('LayoutUnsafe')
  return {
    fingerprint: objectHash(rows),
    size,
    identity: { dev: stat.dev, ino: stat.ino },
    entries: rows.length,
  }
}

export function isReservedSqliteName(name: string): boolean {
  return (
    (SQLITE_FILES as readonly string[]).includes(name) ||
    /^state\.db(?:-wal|-shm|-journal)?(?:\.pre-[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?\.bak$/.test(name)
  )
}
/** Unknown SQLite-shaped artifacts are reported before relocation; ordinary similarly named notes remain user files. */
export function assertNotUnknownSqliteArtifact(root: string, name: string): void {
  if (isReservedSqliteName(name) || !/^state\.db[.-]/.test(name)) return
  const file = path.join(root, name)
  safePath(root, file)
  if (!fs.statSync(file).isFile()) return
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const bytes = Buffer.alloc(16)
  try {
    fs.readSync(fd, bytes, 0, bytes.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const sqlite = bytes.equals(Buffer.from('SQLite format 3\0'))
  const magic = bytes.readUInt32BE(0)
  if (
    sqlite ||
    magic === 0x377f0682 ||
    magic === 0x377f0683 ||
    /\.(?:db|sqlite|sqlite3|wal|shm|journal|bak)$/.test(name)
  ) {
    throw new CanonicalStoreError(
      'CandidateIncomplete',
      'Unknown SQLite artifact requires explicit inventory and recovery'
    )
  }
}

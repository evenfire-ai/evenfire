import * as fs from 'node:fs'
import * as path from 'node:path'

/** Platform-owned SQLite files and migration records are never agent documents. */
export const PROTECTED_STATE_DB_FILES: ReadonlySet<string> = new Set([
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'state.db-journal',
])
export const PROTECTED_STATE_DIR = '.clerum-state'
const STATE_BACKUP = /^state\.db(?:-(?:wal|shm|journal))?(?:\.bak|\.pre-[^.]+\.bak)$/

export function stateDbProtectedMessage(filename: string): string {
  return `${filename} is part of the session state database and cannot be accessed by the agent.`
}
export class StateDbPathError extends Error {
  constructor(filename: string) {
    super(stateDbProtectedMessage(filename))
    this.name = 'StateDbPathError'
  }
}
export function isStateDbPath(requestedPath: string): boolean {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) return false
  const segments = path.posix.normalize(requestedPath).split('/').filter(Boolean)
  if (
    segments.some(
      segment =>
        segment === PROTECTED_STATE_DIR ||
        segment.startsWith('.canonical-store') ||
        segment.startsWith('.clerum-canonical-store')
    )
  )
    return true
  const basename = segments.at(-1)
  return (
    basename !== undefined &&
    (PROTECTED_STATE_DB_FILES.has(basename) || STATE_BACKUP.test(basename))
  )
}
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Check both the requested name and existing target/ancestor at the point of use. */
export function assertStateDbPathAllowed(requestedPath: string, workspacePath: string): void {
  if (isStateDbPath(requestedPath)) throw new StateDbPathError(requestedPath)
  const root = path.resolve(workspacePath)
  const target = path.resolve(root, requestedPath)
  if (!isWithin(target, root)) throw new Error('Path resolves outside workspace')
  let ancestor = target
  while (true) {
    let resolved: string
    try {
      resolved = fs.realpathSync(ancestor)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      if (ancestor === root) return // A newly created workspace has no aliases yet.
      const parent = path.dirname(ancestor)
      if (parent === ancestor || !isWithin(parent, root)) throw err
      ancestor = parent
      continue
    }
    const realRoot = fs.realpathSync(root)
    if (!isWithin(resolved, realRoot)) throw new Error('Path resolves outside workspace')
    if (isStateDbPath(path.relative(realRoot, resolved))) throw new StateDbPathError(requestedPath)
    // Hard links can alias protected bytes under unrelated names. Unlike a
    // symlink, their target cannot be established by realpath.
    const stat = fs.statSync(resolved)
    if (stat.isFile() && stat.nlink > 1) throw new StateDbPathError(requestedPath)
    return
  }
}

/** Enumeration fails closed when an entry's target cannot be verified. */
export function isStateDbPathAllowed(requestedPath: string, workspacePath: string): boolean {
  try {
    assertStateDbPathAllowed(requestedPath, workspacePath)
    return true
  } catch {
    return false
  }
}

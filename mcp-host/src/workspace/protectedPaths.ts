import * as path from 'path'
import { ProtectedWorkspacePathError, StateDbPathError, isStateDbPath } from './stateProtection'

export {
  PROTECTED_STATE_DB_FILES,
  ProtectedWorkspacePathError,
  StateDbPathError,
  isStateDbPath,
  stateDbProtectedMessage,
} from './stateProtection'

export const PROTECTED_WORKSPACE_DIRS: ReadonlySet<string> = new Set([
  '.clerum-state',
  '.gfs-download-store',
  '.gfs-downloads',
])

function normalizeWorkspacePath(relativePath: string): string {
  let normalized = path.posix.normalize(relativePath || '')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('/')) normalized = normalized.slice(1)
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/**
 * True for platform-owned state paths that must never be exposed through the
 * agent-facing workspace API. This is a lexical defense-in-depth check; callers
 * that resolve symlinks must also use isProtectedRealPath.
 */
export function isProtectedWorkspacePath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const segments = normalizeWorkspacePath(relativePath)
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  if (segments.some(segment => PROTECTED_WORKSPACE_DIRS.has(segment))) return true
  return isStateDbPath(relativePath)
}

export function isGfsDownloadPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const segments = normalizeWorkspacePath(relativePath)
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  return segments.some(segment => segment === '.gfs-downloads' || segment === '.gfs-download-store')
}

export class GfsDownloadPathError extends ProtectedWorkspacePathError {
  constructor(filename: string) {
    super(
      `${filename} is a governed GFS download/accounting artifact and cannot be accessed through workspace file tools.`
    )
    this.name = 'GfsDownloadPathError'
  }
}

export function protectedWorkspacePathError(relativePath: string): ProtectedWorkspacePathError {
  if (isGfsDownloadPath(relativePath)) return new GfsDownloadPathError(relativePath)
  return new StateDbPathError(relativePath)
}

export function protectedWorkspacePathMessage(relativePath: string): string {
  return protectedWorkspacePathError(relativePath).message
}

/**
 * Check a resolved absolute path independently of a workspace anchor. This
 * protects the case where a stale workspace root itself was replaced by a
 * platform-owned directory; path.relative would otherwise turn its children
 * into apparently harmless relative paths.
 */
function isProtectedAbsoluteRealPath(realPath: string): boolean {
  if (!path.isAbsolute(realPath)) return false
  const segments = realPath.split(path.sep).filter(segment => segment.length > 0)
  if (segments.some(segment => PROTECTED_WORKSPACE_DIRS.has(segment))) return true
  return isStateDbPath(realPath)
}

export function isProtectedGfsRealPath(realPath: string): boolean {
  if (!path.isAbsolute(realPath)) return false
  const segments = realPath.split(path.sep).filter(segment => segment.length > 0)
  return segments.some(segment => segment === '.gfs-download-store' || segment === '.gfs-downloads')
}

/**
 * Check a fully resolved path against the real workspace root. This catches
 * aliases whose lexical path looks harmless but whose symlink target is a
 * protected platform directory or database lateral.
 */
export function isProtectedRealPath(realPath: string, realWorkspaceRoot: string): boolean {
  if (isProtectedAbsoluteRealPath(realPath)) return true
  const relative = path.relative(realWorkspaceRoot, realPath)
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') return false
  const segments = relative.split(path.sep).filter(segment => segment.length > 0)
  if (segments.some(segment => PROTECTED_WORKSPACE_DIRS.has(segment))) return true
  return isStateDbPath(relative)
}

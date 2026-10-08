import * as path from 'path'

export const PROTECTED_WORKSPACE_DIRS: ReadonlySet<string> = new Set([
  '.clerum-state',
  '.gfs-download-store',
  '.gfs-downloads',
])

/**
 * Name prefix of a pre-#1028 store directory the GFS download store renamed
 * before removing it. A tree left by a failed removal still holds copies of
 * user files, so it is protected like the directory it replaced.
 */
export const RETIRED_GFS_DOWNLOAD_STORE_PREFIX = '.gfs-download-store.retired-'

function isRetiredGfsStoreSegment(segment: string): boolean {
  return segment.startsWith(RETIRED_GFS_DOWNLOAD_STORE_PREFIX)
}

function isProtectedSegment(segment: string): boolean {
  return PROTECTED_WORKSPACE_DIRS.has(segment) || isRetiredGfsStoreSegment(segment)
}

export const PROTECTED_STATE_DB_FILES: ReadonlySet<string> = new Set([
  'state.db',
  'state.db-wal',
  'state.db-shm',
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
  if (segments.some(isProtectedSegment)) return true
  const base = segments[segments.length - 1]
  return base !== undefined && PROTECTED_STATE_DB_FILES.has(base)
}

/** Backward-compatible helper for callers that specifically report state-db access. */
export function isStateDbPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const segments = normalizeWorkspacePath(relativePath)
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  if (segments.includes('.clerum-state')) return true
  const base = segments[segments.length - 1]
  return base !== undefined && PROTECTED_STATE_DB_FILES.has(base)
}

export function isGfsDownloadPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const segments = normalizeWorkspacePath(relativePath)
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  return segments.some(
    segment =>
      segment === '.gfs-downloads' ||
      segment === '.gfs-download-store' ||
      isRetiredGfsStoreSegment(segment)
  )
}

export function stateDbProtectedMessage(filename: string): string {
  return `${filename} is part of the session state database and cannot be accessed by the agent.`
}

export class ProtectedWorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtectedWorkspacePathError'
  }
}

export class StateDbPathError extends ProtectedWorkspacePathError {
  constructor(filename: string) {
    super(stateDbProtectedMessage(filename))
    this.name = 'StateDbPathError'
  }
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
  if (segments.some(isProtectedSegment)) return true
  const base = segments[segments.length - 1]
  return base !== undefined && PROTECTED_STATE_DB_FILES.has(base)
}

export function isProtectedGfsRealPath(realPath: string): boolean {
  if (!path.isAbsolute(realPath)) return false
  const segments = realPath.split(path.sep).filter(segment => segment.length > 0)
  return segments.some(
    segment =>
      segment === '.gfs-download-store' ||
      segment === '.gfs-downloads' ||
      isRetiredGfsStoreSegment(segment)
  )
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
  if (segments.some(isProtectedSegment)) return true
  const base = segments[segments.length - 1]
  return base !== undefined && PROTECTED_STATE_DB_FILES.has(base)
}

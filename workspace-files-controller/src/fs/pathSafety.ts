/**
 * Path safety for wfc. All paths arriving from clients are validated against
 * a fixed mount root before any FS call. Mirrors the spec's "Path safety
 * (server-side, mandatory)" section.
 *
 *   1. Reject paths containing `..`, ASCII control characters, or backslash.
 *   2. Normalize via path.posix and resolve against the mount root; reject
 *      anything escaping the mount root.
 *   3. For filesystem sinks, resolve the existing physical path chain from the
 *      mount root and reject symlinked ancestors before kernel path resolution
 *      can leave the mounted tree.
 *   4. Enforce max depth.
 */
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { err } from '../errors'

export interface ResolvePathOptions {
  /** Absolute mount root (e.g. /workspace). */
  mountRoot: string
  /** Max depth (segments) under the mount root. */
  maxDepth: number
}

export type PhysicalPathMode = 'existing-target' | 'existing-parent'

export interface PhysicalPathSafetyOptions extends ResolvePathOptions {
  /**
   * existing-target requires the full target to exist.
   * existing-parent permits a missing target or missing descendants after the
   * deepest safe existing directory, for create-style operations.
   */
  mode: PhysicalPathMode
}

export interface ResolvedPhysicalPath {
  absPath: string
}

const FORBIDDEN_CHARS = /[\\\x00-\x1f\x7f]/

/**
 * Validate + resolve a client-supplied relative path. Returns the absolute
 * on-disk path (still inside `mountRoot`). Throws an HttpError(400, path_invalid)
 * for any rule violation.
 *
 * Empty / "/" / "." map to the mount root itself (useful for listing root).
 */
export function resolveSafePath(rel: string, opts: ResolvePathOptions): string {
  if (typeof rel !== 'string') {
    throw err('path_invalid', 'path must be a string')
  }

  // Normalize the empty / leading-slash root cases up-front.
  const trimmed = rel.replace(/^\/+/, '')
  if (trimmed === '' || trimmed === '.') {
    return opts.mountRoot
  }

  if (FORBIDDEN_CHARS.test(rel)) {
    throw err('path_invalid', 'path contains forbidden characters (\\, ASCII controls)')
  }

  // Reject any segment that is exactly "..".
  const segments = trimmed.split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '..')) {
    throw err('path_invalid', 'path traversal (..) is not allowed')
  }
  if (segments.length > opts.maxDepth) {
    throw err('path_invalid', `path depth exceeds maximum (${opts.maxDepth})`)
  }

  // Normalize and resolve under the mount root. path.posix is used so
  // backslashes are not interpreted as separators on any platform.
  const normalised = path.posix.normalize(segments.join('/'))
  const resolved = path.posix.resolve(opts.mountRoot, normalised)

  // Belt and suspenders: ensure resolved is within mountRoot.
  const rootWithSep = opts.mountRoot.endsWith('/') ? opts.mountRoot : `${opts.mountRoot}/`
  if (resolved !== opts.mountRoot && !resolved.startsWith(rootWithSep)) {
    throw err('path_invalid', 'path escapes mount root')
  }
  return resolved
}

export function isPhysicalSubpath(realPath: string, realRoot: string): boolean {
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
  return realPath === realRoot || realPath.startsWith(rootWithSep)
}

async function safeRealpath(candidate: string, realRoot: string): Promise<string> {
  const realCandidate = await fs.realpath(candidate)
  if (!isPhysicalSubpath(realCandidate, realRoot)) {
    throw err('path_invalid', 'path escapes mount root')
  }
  return realCandidate
}

/**
 * Validate lexical containment and the existing physical filesystem chain.
 *
 * This rejects symlinked ancestors centrally before route handlers call
 * readdir, stream, mkdir, rename, unlink, or rm on a client-derived path.
 */
export async function resolveSafePhysicalPath(
  rel: string,
  opts: PhysicalPathSafetyOptions
): Promise<ResolvedPhysicalPath> {
  const absPath = resolveSafePath(rel, opts)
  const realRoot = await fs.realpath(opts.mountRoot)
  const rootStat = await fs.lstat(opts.mountRoot)
  if (rootStat.isSymbolicLink()) {
    throw err('path_invalid', 'symlinks are not allowed')
  }
  const relative = path.posix.relative(opts.mountRoot, absPath)
  const segments = relative === '' ? [] : relative.split(path.posix.sep).filter(Boolean)
  let current = opts.mountRoot

  for (let i = 0; i < segments.length; i += 1) {
    current = path.posix.join(current, segments[i])
    let stat: Stats
    try {
      stat = await fs.lstat(current)
    } catch (e) {
      const fsErr = e as NodeJS.ErrnoException
      if (fsErr.code === 'ENOENT' && opts.mode === 'existing-parent') {
        return { absPath }
      }
      throw e
    }

    if (stat.isSymbolicLink()) {
      throw err('path_invalid', 'symlinks are not allowed')
    }

    // lstat rejects symlink nodes; realpath containment also catches unusual
    // mount/canonicalization cases before a route reaches an FS sink.
    await safeRealpath(current, realRoot)

    const isFinal = i === segments.length - 1
    if (!isFinal && !stat.isDirectory()) {
      throw err('not_a_directory', 'not a directory')
    }
  }

  return { absPath }
}

/** Express-friendly query parser: extracts `path` query param as a string. */
export function pathFromQuery(q: unknown): string {
  if (q === undefined || q === null) return ''
  if (typeof q === 'string') return q
  // Multiple values — reject; clients should send a single path query.
  throw err('path_invalid', 'path query must be a single string')
}

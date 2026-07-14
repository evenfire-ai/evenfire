/**
 * Context-files tools — read-only access to SharedFileSystems mounted into
 * the mcp-host pod by HCC. The pod sees one PVC per Context-referenced
 * SharedFileSystem (mounted at the path the Context spec asked for) plus a
 * JSON manifest in `CLERUM_CONTEXT_FILES_MOUNTS` that maps SFS name → mountPath.
 *
 * The LLM sees a virtual unified root keyed by SharedFileSystem name:
 *
 *   <sfs-name>/<path-inside-sfs>
 *
 * So if the Host's Context references "team-mission" mounted at
 * /context-files/team-mission, the LLM uses paths like
 * `team-mission/docs/runbook.md` regardless of where the volume actually
 * landed inside the container. This keeps the tool surface stable across
 * Hosts and decouples the LLM's mental model from k8s mount paths.
 *
 * Why "list" + "read" only:
 *   - The mcp-host volumes are mounted RO; writes are out of scope here
 *     and are mediated by the per-SFS workspace-files-controller.
 *   - Symlinks, directories, and oversize files are refused by name so the
 *     LLM never accidentally exfiltrates a path-traversal foothold.
 */
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { InternalToolDefinition, InternalToolResult } from './types'

interface ContextFilesMount {
  /** Logical name (SFS metadata.name); used as the top-level key in the virtual root. */
  name: string
  /** SharedFileSystem CRD namespace (always "mcp-host" in v1). */
  namespace: string
  /** Absolute path inside the container where the PVC is mounted (RO). */
  mountPath: string
  /** Underlying PVC name — surfaced for diagnostics; the LLM does not use it. */
  pvcName: string
}

const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024 // 10 MiB
const DEFAULT_MAX_LIST_ENTRIES = 1000
const FORBIDDEN_PATH_CHARS = /[\\\x00-\x1f\x7f]/

function maxReadBytes(): number {
  const raw = process.env.CLERUM_CONTEXT_FILES_MAX_READ_BYTES
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_READ_BYTES
}

function maxListEntries(): number {
  const raw = process.env.CLERUM_CONTEXT_FILES_MAX_LIST_ENTRIES
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LIST_ENTRIES
}

/**
 * Parse `CLERUM_CONTEXT_FILES_MOUNTS` (set by the host reconciler) into a
 * deduplicated, sorted list. Returns [] if the env is missing or malformed
 * — callers see "no SFS mounted" rather than crash.
 */
export function loadContextFilesMounts(env: NodeJS.ProcessEnv = process.env): ContextFilesMount[] {
  const raw = env.CLERUM_CONTEXT_FILES_MOUNTS
  if (!raw || raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ContextFilesMount[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const m = item as Partial<ContextFilesMount>
    if (
      typeof m.name !== 'string' ||
      typeof m.mountPath !== 'string' ||
      typeof m.namespace !== 'string' ||
      typeof m.pvcName !== 'string'
    ) {
      continue
    }
    if (seen.has(m.name)) continue
    seen.add(m.name)
    out.push({ name: m.name, namespace: m.namespace, mountPath: m.mountPath, pvcName: m.pvcName })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * Split a virtual path of the form `<sfs-name>/<rest>` into its sfs name
 * and the rest. Returns null if the path is empty or only "/" (which means
 * "list the virtual root"). Throws when:
 *   - the input contains a `..` segment (traversal)
 *   - the input contains backslash or ASCII control characters
 *   - the sfs name is unknown to the current pod
 *   - the resolved real path isn't the SFS mountPath or below it
 *     (defense-in-depth — symlink-on-disk could otherwise escape)
 */
export function resolveVirtualPath(
  input: string,
  mounts: ContextFilesMount[]
): { mount: ContextFilesMount; absPath: string; rel: string } | null {
  const trimmed = input.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  if (FORBIDDEN_PATH_CHARS.test(trimmed)) {
    throw new Error('path is invalid: contains backslash or ASCII control characters')
  }
  const segments = trimmed.split('/').filter(s => s.length > 0)
  if (segments.length === 0) return null
  if (segments.some(s => s === '..')) {
    throw new Error('path is invalid: contains ".."')
  }
  const [sfsName, ...rest] = segments
  const mount = mounts.find(m => m.name === sfsName)
  if (!mount) {
    throw new Error(
      `sharedFileSystem "${sfsName}" is not mounted in this Host. Known: ${
        mounts.map(m => m.name).join(', ') || '(none)'
      }`
    )
  }
  const rel = rest.join('/')
  const mountRoot = path.posix.resolve(mount.mountPath)
  const mountRootWithSep = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`
  const absPath = path.posix.resolve(mountRoot, rel)
  if (absPath !== mountRoot && !absPath.startsWith(mountRootWithSep)) {
    throw new Error('path resolved outside of the SharedFileSystem mount')
  }
  return { mount, absPath, rel }
}

interface VirtualEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'sharedfilesystem' | 'other'
  size?: number
  mtime?: string
}

async function entryFromStat(
  name: string,
  abs: string,
  virtualPath: string
): Promise<VirtualEntry | null> {
  let st: Stats
  try {
    st = await fs.lstat(abs)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) return null // never expose symlinks
  if (st.isFile()) {
    return {
      name,
      path: virtualPath,
      kind: 'file',
      size: st.size,
      mtime: st.mtime.toISOString(),
    }
  }
  if (st.isDirectory()) {
    return { name, path: virtualPath, kind: 'directory', mtime: st.mtime.toISOString() }
  }
  return { name, path: virtualPath, kind: 'other' }
}

export const contextFilesList: InternalToolDefinition = {
  name: 'clerum__context_files_list',
  description:
    'List entries in the virtual context-files root. Pass an empty path or "/" to list available SharedFileSystems mounted into this Host. ' +
    'Pass "<sharedFileSystemName>" or "<sharedFileSystemName>/<subdir>" to list inside a SharedFileSystem. ' +
    'Symlinks are filtered out. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Virtual path to list. Empty / "/" lists the SharedFileSystems available in this Host; otherwise "<sfs-name>/<subdir>".',
      },
    },
    required: [],
  },
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    try {
      const mounts = loadContextFilesMounts()
      const inputRaw = typeof args.path === 'string' ? args.path : ''
      const input = inputRaw.trim()
      // Top-level virtual root: list SharedFileSystems.
      if (input === '' || input === '/') {
        const entries: VirtualEntry[] = mounts.map(m => ({
          name: m.name,
          path: m.name,
          kind: 'sharedfilesystem',
        }))
        return {
          success: true,
          content: JSON.stringify(
            { path: '', entries, mountedSharedFileSystems: mounts.length },
            null,
            2
          ),
        }
      }
      const resolved = resolveVirtualPath(input, mounts)
      if (!resolved) {
        return { success: false, error: `path "${inputRaw}" is empty or invalid` }
      }
      const lst = await fs.lstat(resolved.absPath)
      if (lst.isSymbolicLink()) {
        return { success: false, error: 'symlinks are not allowed' }
      }
      if (!lst.isDirectory()) {
        return { success: false, error: 'path is not a directory' }
      }
      const cap = maxListEntries()
      const dirents = await fs.readdir(resolved.absPath, { withFileTypes: true })
      const truncated = dirents.length > cap
      const slice = truncated ? dirents.slice(0, cap) : dirents
      const entries: VirtualEntry[] = []
      for (const dirent of slice) {
        const childAbs = path.posix.join(resolved.absPath, dirent.name)
        const childVirtual = path.posix.join(resolved.mount.name, resolved.rel, dirent.name)
        const e = await entryFromStat(dirent.name, childAbs, childVirtual)
        if (e) entries.push(e)
      }
      return {
        success: true,
        content: JSON.stringify({ path: input, entries, truncated }, null, 2),
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const contextFilesRead: InternalToolDefinition = {
  name: 'clerum__context_files_read',
  description:
    'Read a UTF-8 text file from a SharedFileSystem mounted into this Host. Path is "<sharedFileSystemName>/<file-path>". ' +
    'Caps file size at CLERUM_CONTEXT_FILES_MAX_READ_BYTES (default 10 MiB). Refuses directories and symlinks. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Virtual path "<sfs-name>/<file>" of the file to read.',
      },
    },
    required: ['path'],
  },
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    try {
      const mounts = loadContextFilesMounts()
      const inputRaw = typeof args.path === 'string' ? args.path : ''
      const resolved = resolveVirtualPath(inputRaw.trim(), mounts)
      if (!resolved) {
        return { success: false, error: 'path is required and must be "<sfs-name>/<file>"' }
      }
      const lst = await fs.lstat(resolved.absPath)
      if (lst.isSymbolicLink()) {
        return { success: false, error: 'symlinks are not allowed' }
      }
      if (lst.isDirectory()) {
        return { success: false, error: 'path is a directory; use clerum__context_files_list' }
      }
      if (!lst.isFile()) {
        return { success: false, error: 'path is not a regular file' }
      }
      const cap = maxReadBytes()
      if (lst.size > cap) {
        return {
          success: false,
          error: `file size ${lst.size} exceeds CLERUM_CONTEXT_FILES_MAX_READ_BYTES (${cap})`,
        }
      }
      const content = await fs.readFile(resolved.absPath, { encoding: 'utf8' })
      return {
        success: true,
        content: JSON.stringify(
          {
            path: inputRaw,
            sharedFileSystem: resolved.mount.name,
            size: lst.size,
            mtime: lst.mtime.toISOString(),
            content,
          },
          null,
          2
        ),
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const CONTEXT_FILES_TOOLS: InternalToolDefinition[] = [contextFilesList, contextFilesRead]

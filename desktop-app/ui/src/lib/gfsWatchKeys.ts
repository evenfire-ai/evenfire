import { GFS_WATCH_MAX_KEYS } from '@constants/gfsWatch'

export type GfsWatchKeyKind = 'file' | 'dir'

export interface GfsWatchKeyParts {
  kind: GfsWatchKeyKind
  drive: string
  rid: string
}

export interface GfsWatchKeySource {
  kind: GfsWatchKeyKind
  uri: string | null | undefined
}

// Same grammar as the gfs:// resolver: a single 32-hex segment is the rid, a
// human path carries it as the trailing `-<32hex>` of its last segment, and
// anything else resolves by path. Main only validates; it never rewrites.
const RID_RE = /^[0-9a-f]{32}$/
const TRAILING_RID_RE = /-([0-9a-f]{32})$/
const DRIVE_RE = /^[a-z0-9-]{1,63}$/
const KEY_RE = /^(file|dir):gfs:\/\/([a-z0-9-]{1,63})\/([0-9a-f]{32})$/

/**
 * The canonical watch key of a gfs:// URI, or null when it cannot be watched.
 * A by-path URI without a rid has no stable identity to watch: it is
 * subscribed once it resolves to a URI that carries one.
 */
export function gfsWatchKey(kind: GfsWatchKeyKind, uri: string | null | undefined): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('gfs://')) return null
  const segments = uri
    .slice('gfs://'.length)
    .split('/')
    .filter(segment => segment.length > 0)
  const [drive, ...path] = segments
  if (drive === undefined || path.length === 0 || !DRIVE_RE.test(drive)) return null
  let rid: string | null = null
  if (path.length === 1 && RID_RE.test(path[0]!)) {
    rid = path[0]!
  } else {
    rid = TRAILING_RID_RE.exec(path[path.length - 1]!)?.[1] ?? null
  }
  return rid ? `${kind}:gfs://${drive}/${rid}` : null
}

export function parseGfsWatchKey(key: string): GfsWatchKeyParts | null {
  const match = KEY_RE.exec(key)
  if (!match) return null
  return { kind: match[1] as GfsWatchKeyKind, drive: match[2]!, rid: match[3]! }
}

/** A resource id (UUID) as the rid its gfs:// URI carries. */
export function gfsRidOfResourceId(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

/**
 * The watch list in priority order: the first occurrence of a key keeps its
 * place, unwatchable URIs are skipped, and the list is cut at main's cap so the
 * lowest-priority keys are the ones left out.
 */
export function buildGfsWatchKeys(sources: readonly GfsWatchKeySource[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const key = gfsWatchKey(source.kind, source.uri)
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
    if (keys.length === GFS_WATCH_MAX_KEYS) break
  }
  return keys
}

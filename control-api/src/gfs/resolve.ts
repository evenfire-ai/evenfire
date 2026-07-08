/**
 * gfs:// URI parsing + resolution (spec §Global reference scheme).
 *
 * URI forms:
 *   identity (canonical):  gfs://<drive>/<rid>
 *   human (display+id):    gfs://<drive>/<display/path>/<slug>-<rid>
 *
 * Precedence: the identity form (a single 32-hex segment) is ALWAYS the rid,
 * never by-path. In the human form the rid is the trailing 32 hex of the final
 * segment; the rest is display. `rid` ALWAYS wins when it resolves; only when
 * the parsed UUID has no row does resolution fall back to by-path (so a file
 * legitimately named with trailing hex is not mis-parsed).
 */

const RID_RE = /^[0-9a-f]{32}$/
const TRAILING_RID_RE = /-([0-9a-f]{32})$/

export class GfsUriError extends Error {
  readonly code = 'path_invalid'
  constructor(message: string) {
    super(message)
    this.name = 'GfsUriError'
  }
}

export interface ParsedGfsUri {
  drive: string
  /** A candidate 32-hex rid, when the URI carries one (identity or human form). */
  rid: string | null
  /** The absolute display path, for by-path fallback. Null for the identity form. */
  byPath: string | null
}

export function parseGfsUri(uri: string): ParsedGfsUri {
  if (typeof uri !== 'string' || !uri.startsWith('gfs://')) {
    throw new GfsUriError(`not a gfs URI: ${JSON.stringify(uri)}`)
  }
  const segments = uri.slice('gfs://'.length).split('/').filter(s => s.length > 0)
  if (segments.length < 2) {
    throw new GfsUriError(`gfs URI must be gfs://<drive>/<resource>: ${uri}`)
  }
  const drive = segments[0]
  const pathSegments = segments.slice(1)

  // Identity form — a single 32-hex segment is ALWAYS the rid (never by-path).
  if (pathSegments.length === 1 && RID_RE.test(pathSegments[0])) {
    return { drive, rid: pathSegments[0], byPath: null }
  }

  const byPath = '/' + pathSegments.join('/')
  // Human form — rid = trailing 32 hex of the final segment, after the last '-'.
  const match = TRAILING_RID_RE.exec(pathSegments[pathSegments.length - 1])
  if (match) {
    return { drive, rid: match[1], byPath }
  }
  // Pure by-path form — no trailing rid.
  return { drive, rid: null, byPath }
}

export interface ResolvedResource {
  resourceId: string
  drive: string
  name: string
  kind: string
  pathCache: string | null
}

export interface ResolveStore {
  getByRid(drive: string, rid: string): Promise<ResolvedResource | null>
  getByPath(drive: string, path: string): Promise<ResolvedResource | null>
}

/**
 * Resolve a gfs:// URI to a resource. Returns null when nothing resolves (the
 * route maps that to 404). Throws GfsUriError only when the URI is malformed.
 */
export async function resolveGfsUri(
  store: ResolveStore,
  uri: string
): Promise<ResolvedResource | null> {
  const parsed = parseGfsUri(uri)
  if (parsed.rid) {
    const byRid = await store.getByRid(parsed.drive, parsed.rid)
    if (byRid) return byRid // rid always wins
  }
  if (parsed.byPath) {
    const byPath = await store.getByPath(parsed.drive, parsed.byPath)
    if (byPath) return byPath
  }
  return null
}

/** Minimal query surface — a pg client/pool satisfies this; tests inject a fake. */
export interface ResolveDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

const SELECT_COLS = 'resource_id, drive, name, kind, path_cache'

function rowToResource(row: unknown): ResolvedResource {
  const r = row as {
    resource_id: unknown
    drive: unknown
    name: unknown
    kind: unknown
    path_cache: unknown
  }
  return {
    resourceId: String(r.resource_id),
    drive: String(r.drive),
    name: String(r.name),
    kind: String(r.kind),
    pathCache: r.path_cache == null ? null : String(r.path_cache),
  }
}

/**
 * DB-backed resolver. getByRid is a single keyed lookup; getByPath walks the
 * path segments from the synthetic root (parent IS NULL), one hop per segment.
 * A missing rid row or a missing path segment resolves to null (→ 404).
 */
export class DbResolveStore implements ResolveStore {
  constructor(private readonly db: ResolveDb) {}

  async getByRid(drive: string, rid: string): Promise<ResolvedResource | null> {
    const result = await this.db.query(
      `SELECT ${SELECT_COLS} FROM gfs_resources
       WHERE drive = $1 AND resource_id = $2::uuid AND deleted_at IS NULL`,
      [drive, rid]
    )
    return result.rows.length > 0 ? rowToResource(result.rows[0]) : null
  }

  async getByPath(drive: string, path: string): Promise<ResolvedResource | null> {
    const segments = path.split('/').filter(s => s.length > 0)
    const root = await this.db.query(
      `SELECT ${SELECT_COLS} FROM gfs_resources
       WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL`,
      [drive]
    )
    if (root.rows.length === 0) return null
    let current = rowToResource(root.rows[0])
    for (const segment of segments) {
      const child = await this.db.query(
        `SELECT ${SELECT_COLS} FROM gfs_resources
         WHERE drive = $1 AND parent_resource_id = $2::uuid AND name = $3 AND deleted_at IS NULL`,
        [drive, current.resourceId, segment]
      )
      if (child.rows.length === 0) return null
      current = rowToResource(child.rows[0])
    }
    return current
  }
}

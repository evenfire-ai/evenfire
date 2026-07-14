/**
 * Cursor-paginated listing of a directory's children over the permission store
 * (gfs_resources). Mirrors the gfsc read API's pagination shape: fetch limit+1
 * to detect a next page without a count(*), order by (name, resource_id), and
 * encode the last row as an opaque cursor. Bounded memory regardless of folder
 * size.
 */

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

export class GfsTreeError extends Error {
  readonly code = 'path_invalid'
  constructor(message: string) {
    super(message)
    this.name = 'GfsTreeError'
  }
}

export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

interface CursorPayload {
  n: string
  i: string
}

export function encodeCursor(name: string, resourceId: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: resourceId }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload
    if (typeof parsed.n !== 'string' || typeof parsed.i !== 'string') {
      throw new Error('malformed cursor payload')
    }
    return parsed
  } catch {
    throw new GfsTreeError('invalid cursor')
  }
}

export interface ChildRow {
  resourceId: string
  name: string
  kind: string
  pathCache: string | null
  bytes: number
  version: number
}

export interface ChildView {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: string
  path: string | null
  bytes: number
  version: number
}

export function toChildView(drive: string, row: ChildRow): ChildView {
  const rid = row.resourceId.replace(/-/g, '').toLowerCase()
  return {
    resourceId: row.resourceId,
    rid,
    gfsUri: `gfs://${drive}/${rid}`,
    name: row.name,
    kind: row.kind,
    path: row.pathCache,
    bytes: row.bytes,
    version: row.version,
  }
}

export interface ChildrenStore {
  listChildren(
    drive: string,
    parentResourceId: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<ChildRow[]>
}

export async function listChildrenPaged(
  store: ChildrenStore,
  drive: string,
  parentResourceId: string,
  opts: { limit?: unknown; cursor?: string }
): Promise<{ items: ChildView[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit)
  const after = opts.cursor ? decodeCursor(opts.cursor) : undefined
  const rows = await store.listChildren(drive, parentResourceId, {
    limit: limit + 1,
    afterName: after?.n,
    afterId: after?.i,
  })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.name, last.resourceId) : null
  return { items: page.map(row => toChildView(drive, row)), nextCursor }
}

/** Minimal query surface — a pg client/pool satisfies this; tests inject a fake. */
export interface TreeDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export class DbChildrenStore implements ChildrenStore {
  constructor(private readonly db: TreeDb) {}

  async listChildren(
    drive: string,
    parentResourceId: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<ChildRow[]> {
    // Keyset pagination on (name, resource_id). When afterName is null (first
    // page) the cursor predicate is a no-op; otherwise it skips everything up to
    // and including the cursor row.
    const result = await this.db.query(
      `SELECT resource_id, name, kind, path_cache, bytes, version
         FROM gfs_resources
        WHERE drive = $1 AND parent_resource_id = $2::uuid AND deleted_at IS NULL
          AND ($3::text IS NULL OR (name, resource_id) > ($3, $4::uuid))
        ORDER BY name, resource_id
        LIMIT $5`,
      [drive, parentResourceId, opts.afterName ?? null, opts.afterId ?? null, opts.limit]
    )
    return result.rows.map(row => {
      const r = row as {
        resource_id: unknown
        name: unknown
        kind: unknown
        path_cache: unknown
        bytes: unknown
        version: unknown
      }
      return {
        resourceId: String(r.resource_id),
        name: String(r.name),
        kind: String(r.kind),
        pathCache: r.path_cache == null ? null : String(r.path_cache),
        bytes: Number(r.bytes ?? 0),
        version: Number(r.version ?? 0),
      }
    })
  }
}

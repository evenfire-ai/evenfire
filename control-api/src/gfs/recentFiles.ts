import { type GfsCaller, type GrantsDb, readableResourceIds } from '../routes/gfs/grants.js'

/**
 * One row of the caller's "Recent files" list. There is no `path`: the card is a
 * flat list of files (D3-D8), and the renderer never prints a location.
 */
export interface GfsRecentFile {
  resourceId: string
  gfsUri: string
  drive: string
  name: string
  version: number
  bytes: number
  /** When this user (or an agent run bound to this user) last opened or changed the file, ISO 8601 UTC. */
  lastActivityAt: string
}

interface RecentActivityRow {
  resource_id: string
  drive: string
  name: string
  version: number | string | null
  bytes: number | string | null
  last_activity_at: unknown
}

/** gfs:// path segment for a resource id: the rid form the proxy and gfsc use. */
function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
  }
  throw new Error('gfs_user_file_activity.last_activity_at is required')
}

/**
 * The caller's recent files, newest first.
 *
 * The whole list (at most 100 rows, the per-user cap) is returned in one
 * response: D20 decided on a client-side page of 10 with no cursor, so no
 * server page size exists here. Rows are the user's own recorded activity joined
 * to live file rows and then filtered by the caller's own `read` authority, so a
 * file an agent read but the user may no longer read stays hidden. Server order
 * is the index order (`last_activity_at DESC, resource_id DESC`).
 */
export async function listRecentFiles(
  db: GrantsDb,
  caller: GfsCaller,
  userId: string,
  drive: string
): Promise<GfsRecentFile[]> {
  const result = await db.query(
    `SELECT r.resource_id, r.drive, r.name, r.version, r.bytes, a.last_activity_at
       FROM gfs_user_file_activity a
       JOIN gfs_resources r ON r.resource_id = a.resource_id
      WHERE a.user_id = $1 AND r.drive = $2 AND r.kind = 'file' AND r.deleted_at IS NULL
      ORDER BY a.last_activity_at DESC, a.resource_id DESC`,
    [userId, drive]
  )
  const rows = result.rows as RecentActivityRow[]
  const readable = await readableResourceIds(
    db,
    caller,
    drive,
    rows.map(row => String(row.resource_id))
  )
  return rows
    .filter(row => readable.has(String(row.resource_id)))
    .map(row => {
      const resourceId = String(row.resource_id)
      const rid = ridOf(resourceId)
      return {
        resourceId,
        gfsUri: `gfs://${String(row.drive)}/${rid}`,
        drive: String(row.drive),
        name: String(row.name),
        version: Number(row.version ?? 0),
        bytes: Number(row.bytes ?? 0),
        lastActivityAt: toIsoTimestamp(row.last_activity_at),
      }
    })
}

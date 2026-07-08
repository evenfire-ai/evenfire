import { GfsResource, ResourceStore } from "../api/read";
import { normalizeResourceId } from "../storage/paths";

/**
 * Postgres-backed ResourceStore (the metadata side of the read path).
 *
 * Implements the api/read.ts ResourceStore interface against `gfs_resources` —
 * the deferred concrete impl the interface comment points at. The authorization
 * decision is made separately by PermissionClient (the store is the source of
 * truth); this class only reads resource metadata, ordered for stable
 * cursor pagination.
 *
 * Two node-postgres type quirks are normalized here so callers see clean JS
 * values: a `BIGINT` (`bytes`) comes back as a string, and a `TIMESTAMPTZ`
 * (`deleted_at`) comes back as a Date — both are coerced to the shapes
 * GfsResource declares (`number`, ISO `string | null`).
 */

/** Minimal query surface — a pg Pool satisfies this; tests inject a fake. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToResource(row: Record<string, unknown>): GfsResource {
  return {
    resourceId: String(row.resource_id),
    drive: String(row.drive),
    parentResourceId: row.parent_resource_id == null ? null : String(row.parent_resource_id),
    name: String(row.name),
    kind: String(row.kind) === "directory" ? "directory" : "file",
    pathCache: row.path_cache == null ? null : String(row.path_cache),
    version: Number(row.version),
    bytes: Number(row.bytes),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

const SELECT_COLUMNS =
  "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, deleted_at";

function toDbResourceId(resourceId: string): string {
  const rid = normalizeResourceId(resourceId);
  return `${rid.slice(0, 8)}-${rid.slice(8, 12)}-${rid.slice(12, 16)}-${rid.slice(16, 20)}-${rid.slice(20)}`;
}

export class PgResourceStore implements ResourceStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Fetch a single resource by id — INCLUDING a tombstoned row, so the read
   * executor (`requireLive`) can map a deleted resource to `410 gone` rather
   * than `404` for a caller who is allowed to see it.
   */
  async getResource(drive: string, resourceId: string): Promise<GfsResource | null> {
    const dbResourceId = toDbResourceId(resourceId);
    const res = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM gfs_resources WHERE drive = $1 AND resource_id = $2`,
      [drive, dbResourceId]
    );
    const row = res.rows[0];
    return row ? rowToResource(row) : null;
  }

  /**
   * List a directory's LIVE children ordered by (name, resourceId) — the stable
   * total order encodeCursor/decodeCursor assume — returning rows strictly after
   * the (afterName, afterId) cursor. Tombstoned rows are excluded. The caller
   * asks for limit+1 rows to detect a next page without a count(*).
   */
  async listChildren(
    drive: string,
    parentResourceId: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<GfsResource[]> {
    const afterName = opts.afterName ?? null;
    const parentId = toDbResourceId(parentResourceId);
    const afterId = opts.afterId ? toDbResourceId(opts.afterId) : null;
    const res = await this.db.query(
      `SELECT ${SELECT_COLUMNS}
         FROM gfs_resources
        WHERE drive = $1
          AND parent_resource_id = $2
          AND deleted_at IS NULL
          AND ($3::text IS NULL OR (name, resource_id) > ($3::text, $4::uuid))
        ORDER BY name ASC, resource_id ASC
        LIMIT $5`,
      [drive, parentId, afterName, afterId, opts.limit]
    );
    return res.rows.map(rowToResource);
  }
}

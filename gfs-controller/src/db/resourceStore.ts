import { GfsResource, ResourceStore } from "../api/read";
import type { CopyDestinationSnapshot, CopySnapshotNode } from "../api/copy";
import { normalizeResourceId } from "../storage/paths";
import { withDeadlineTransaction, type DeadlineBudget, type DeadlineClient } from "./deadlineQuery";

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
  connect?: () => Promise<DeadlineClient>;
}

export type CopyQueryBudget = DeadlineBudget;

export interface CopyAdmissionSnapshot {
  sourceRoot: CopySnapshotNode | null;
  destinationParent: CopySnapshotNode | null;
}

async function copyQuery(
  db: Queryable,
  text: string,
  values: unknown[],
  budget?: CopyQueryBudget
): Promise<{ rows: Record<string, unknown>[] }> {
  if (!budget) return db.query(text, values);
  return withDeadlineTransaction(db, budget, true, client => client.query(text, values));
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
    blobKey: row.blob_key == null ? null : String(row.blob_key),
    contentSha256: row.content_sha256 == null ? null : String(row.content_sha256),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

function rowToCopyNode(row: Record<string, unknown>): CopySnapshotNode {
  return {
    resourceId: String(row.resource_id),
    drive: String(row.drive),
    parentResourceId: row.parent_resource_id == null ? null : String(row.parent_resource_id),
    name: String(row.name),
    kind: String(row.kind) === "directory" ? "directory" : "file",
    pathCache: row.path_cache == null ? null : String(row.path_cache),
    version: Number(row.version),
    bytes: BigInt(String(row.bytes)),
    blobKey: row.blob_key == null ? null : String(row.blob_key),
    contentSha256: row.content_sha256 == null ? null : String(row.content_sha256),
    deletedAt: toIsoOrNull(row.deleted_at),
    depth: Number(row.depth),
    cycle: Boolean(row.cycle),
    underTombstone: Boolean(row.under_tombstone),
  };
}

const SELECT_COLUMNS =
  "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key, content_sha256, deleted_at";

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

  /** Cheap direct metadata admission before any recursive tree materialization. */
  async loadCopyAdmission(
    drive: string,
    sourceResourceId: string,
    destinationParentId: string,
    budget?: CopyQueryBudget
  ): Promise<CopyAdmissionSnapshot> {
    const values: unknown[] = [drive, toDbResourceId(sourceResourceId), toDbResourceId(destinationParentId)];
    const res = await copyQuery(this.db,
      `WITH admission AS (
         SELECT 'source' AS record_type, ${SELECT_COLUMNS}
           FROM gfs_resources
          WHERE drive = $1 AND resource_id = $2
         UNION ALL
         SELECT 'destination' AS record_type, ${SELECT_COLUMNS}
           FROM gfs_resources
          WHERE drive = $1 AND resource_id = $3
       )
       SELECT *, 0 AS depth, false AS cycle, false AS under_tombstone FROM admission`,
      values,
      budget
    );
    const source = res.rows.find(row => row.record_type === "source");
    const destination = res.rows.find(row => row.record_type === "destination");
    return {
      sourceRoot: source ? rowToCopyNode(source) : null,
      destinationParent: destination ? rowToCopyNode(destination) : null,
    };
  }

  /** Load a complete source subtree with one deterministic recursive query. */
  async loadCopySnapshot(drive: string, sourceResourceId: string, limit: bigint, budget?: CopyQueryBudget): Promise<CopySnapshotNode[]> {
    const sourceId = toDbResourceId(sourceResourceId);
    const values: unknown[] = [drive, sourceId, limit];
    const res = await copyQuery(this.db,
      `WITH RECURSIVE source_tree AS (
         SELECT r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.path_cache,
                r.version, r.bytes, r.blob_key, r.content_sha256, r.deleted_at,
                0 AS depth, ARRAY[r.resource_id]::uuid[] AS visited, false AS cycle,
                false AS under_tombstone
           FROM gfs_resources r
          WHERE r.drive = $1 AND r.resource_id = $2
         UNION ALL
         SELECT child.resource_id, child.drive, child.parent_resource_id, child.name, child.kind, child.path_cache,
                child.version, child.bytes, child.blob_key, child.content_sha256, child.deleted_at,
                parent.depth + 1, parent.visited || child.resource_id,
                child.resource_id = ANY(parent.visited) AS cycle,
                parent.under_tombstone OR child.deleted_at IS NOT NULL AS under_tombstone
           FROM source_tree parent
           JOIN gfs_resources child
             ON child.drive = $1 AND child.parent_resource_id = parent.resource_id
          WHERE NOT parent.cycle
       )
       SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes,
              blob_key, content_sha256, deleted_at, depth, cycle, under_tombstone
         FROM source_tree
        WHERE depth = 0 OR deleted_at IS NULL
        LIMIT $3`,
      values,
      budget
    );
    return res.rows.map(rowToCopyNode);
  }

  /**
   * Load destination ancestry and live direct children in one statement so the
   * collision set and ancestry are one database observation, never an N+1 loop.
   */
  async loadCopyDestination(drive: string, destinationParentId: string, rootName: string, budget?: CopyQueryBudget): Promise<CopyDestinationSnapshot> {
    const destinationId = toDbResourceId(destinationParentId);
    const values: unknown[] = [drive, destinationId, rootName];
    const res = await copyQuery(this.db,
      `WITH RECURSIVE destination_ancestors AS (
         SELECT r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.path_cache,
                r.version, r.bytes, r.blob_key, r.content_sha256, r.deleted_at,
                0 AS depth, ARRAY[r.resource_id]::uuid[] AS visited, false AS cycle,
                false AS under_tombstone
           FROM gfs_resources r
          WHERE r.drive = $1 AND r.resource_id = $2
         UNION ALL
         SELECT parent.resource_id, parent.drive, parent.parent_resource_id, parent.name, parent.kind, parent.path_cache,
                parent.version, parent.bytes, parent.blob_key, parent.content_sha256, parent.deleted_at,
                child.depth + 1, child.visited || parent.resource_id,
                parent.resource_id = ANY(child.visited) AS cycle,
                false AS under_tombstone
           FROM destination_ancestors child
           JOIN gfs_resources parent
             ON parent.resource_id = child.parent_resource_id
          WHERE NOT child.cycle
       )
       SELECT 'ancestor' AS record_type, resource_id, drive, parent_resource_id,
              name, kind, path_cache, version, bytes, blob_key, content_sha256, deleted_at, depth, cycle, under_tombstone
         FROM destination_ancestors
       UNION ALL
       SELECT 'child' AS record_type, child.resource_id, child.drive, child.parent_resource_id,
              child.name, child.kind, child.path_cache, child.version, child.bytes, child.blob_key,
              child.content_sha256, child.deleted_at, 0 AS depth, false AS cycle,
              false AS under_tombstone
         FROM gfs_resources child
        WHERE child.drive = $1 AND child.parent_resource_id = $2
          AND child.deleted_at IS NULL AND child.name = $3
       ORDER BY record_type ASC, depth ASC, resource_id ASC`,
      values,
      budget
    );
    const ancestorRows = res.rows.filter(row => row.record_type === "ancestor");
    const childRows = res.rows.filter(row => row.record_type === "child");
    return {
      ancestors: ancestorRows.map(rowToCopyNode),
      liveChildren: childRows.map(row => ({ resourceId: String(row.resource_id), name: String(row.name) })),
    };
  }
}

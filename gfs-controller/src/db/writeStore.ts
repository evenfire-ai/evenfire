import type { Readable } from "node:stream";
import { GfsError } from "../api/errors";
import { GfsResource } from "../api/read";
import { assertIfMatch } from "../api/write";
import { normalizeResourceId } from "../storage/paths";

/**
 * gfs write data plane (the metadata side of create/replace/delete). Pairs the
 * pure write PLAN (api/write.ts) and the blob bytes (storage/blobStore.ts) with
 * the transactional Postgres mutation that keeps the two consistent.
 *
 * Consistency model — blob writes are NOT transactional with Postgres, so the
 * mutation is ordered to make a DANGLING metadata row (metadata present, blob
 * missing) impossible; only a harmless orphan blob (blob present, no metadata)
 * is possible and is GC-able:
 *
 *   create : INSERT (in tx) → write blob → COMMIT. Blob failure ROLLBACKs the
 *            insert; a post-blob COMMIT failure leaves an orphan blob, never a
 *            dangling row.
 *   replace: SELECT … FOR UPDATE (serializes concurrent replaces) → assertIfMatch
 *            → write blob under the row lock → UPDATE version+1, bytes → COMMIT.
 *   delete : SELECT … FOR UPDATE → assertIfMatch → refuse a non-empty directory
 *            → soft-delete (deleted_at). The blob is RETAINED (erasure is P5).
 */

/** Minimal transaction-scoped query surface (a pg PoolClient satisfies it). */
export interface TxClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Runs `fn` inside a single BEGIN/COMMIT, rolling back on any throw. */
export interface Transactor {
  transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T>;
}

/** A pg Pool checked out for one transaction (connect → BEGIN → fn → COMMIT). */
export interface PoolLike {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}

/**
 * Postgres-backed Transactor: checks out one client, BEGINs, runs `fn`, and
 * COMMITs — ROLLBACKing (best-effort) on any throw so a failed write never
 * leaves a half-applied mutation. The client is always released.
 */
export class PgTransactor implements Transactor {
  constructor(private readonly pool: PoolLike) {}

  async transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        console.error(
          `[gfsc] ROLLBACK failed after a write error: ${
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          }`
        );
      });
      throw err;
    } finally {
      client.release();
    }
  }
}

/** The blob side of a write (BlobStore satisfies this; reader replicas reject). */
export interface BlobWriter {
  write(resourceId: string, data: Readable | Buffer): Promise<{ bytes: number }>;
}

const RETURNING =
  "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, deleted_at";

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

/** Postgres unique_violation — a duplicate live sibling name. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "23505";
}

function toDbResourceId(resourceId: string): string {
  const rid = normalizeResourceId(resourceId);
  return `${rid.slice(0, 8)}-${rid.slice(8, 12)}-${rid.slice(12, 16)}-${rid.slice(16, 20)}-${rid.slice(20)}`;
}

export interface CreateInput {
  drive: string;
  parentId: string;
  name: string;
  kind?: "file" | "directory";
  content?: Buffer;
}
export interface ReplaceInput {
  drive: string;
  resourceId: string;
  ifMatch?: number;
  content: Buffer;
}
export interface DeleteInput {
  drive: string;
  resourceId: string;
  ifMatch?: number;
}

export class GfsWriteService {
  constructor(
    private readonly tx: Transactor,
    private readonly blobs: BlobWriter
  ) {}

  /**
   * Create a new resource under `parentId`. The parent must be a live directory;
   * the sibling name must be unique among live rows (else `already_exists`). File
   * resources write blob bytes; directories create metadata only.
   */
  async create(input: CreateInput): Promise<GfsResource> {
    return this.tx.transaction(async (client) => {
      const kind = input.kind ?? "file";
      if (kind !== "file" && kind !== "directory") {
        throw new GfsError("path_invalid", `unsupported resource kind: ${String(kind)}`);
      }
      const content = input.content ?? Buffer.alloc(0);
      const parentId = toDbResourceId(input.parentId);
      const parent = await this.liveResource(client, input.drive, parentId);
      if (!parent) throw new GfsError("not_found", `parent not found: ${input.parentId}`);
      if (parent.kind !== "directory") {
        throw new GfsError("not_a_directory", `parent is not a directory: ${input.parentId}`);
      }
      const pathCache =
        parent.pathCache == null ? null : `${parent.pathCache === "/" ? "" : parent.pathCache}/${input.name}`;

      let row: Record<string, unknown>;
      try {
        const res = await client.query(
          `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, version, bytes)
           VALUES ($1, $2, $3, $4, $5, 0, $6)
           RETURNING ${RETURNING}`,
          [input.drive, parentId, input.name, kind, pathCache, kind === "file" ? content.length : 0]
        );
        row = res.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new GfsError("already_exists", `a resource named '${input.name}' already exists here`);
        }
        throw err;
      }

      const created = rowToResource(row);
      if (kind === "file") {
        // Blob written INSIDE the tx: a failure here ROLLBACKs the insert, so a
        // metadata row never outlives a failed blob write.
        await this.blobs.write(created.resourceId, content);
      }
      return created;
    });
  }

  /**
   * Replace a FILE's bytes. The row is locked FOR UPDATE so concurrent replaces
   * serialize; `assertIfMatch` enforces optimistic concurrency (a stale If-Match
   * is `precondition_failed`). version is bumped, bytes updated.
   */
  async replace(input: ReplaceInput): Promise<GfsResource> {
    return this.tx.transaction(async (client) => {
      const resourceId = toDbResourceId(input.resourceId);
      const current = await this.lockResource(client, input.drive, resourceId);
      if (!current) throw new GfsError("not_found", `resource not found: ${input.resourceId}`);
      if (current.deletedAt) {
        throw GfsError.gone(`resource is deleted: ${input.resourceId}`, "resource_deleted");
      }
      if (current.kind === "directory") {
        throw new GfsError("is_a_directory", `resource is a directory: ${input.resourceId}`);
      }
      this.assertVersion(current.version, input.ifMatch);

      // Overwrite the blob while holding the row lock, then bump metadata.
      await this.blobs.write(input.resourceId, input.content);
      const res = await client.query(
        `UPDATE gfs_resources
            SET version = version + 1, bytes = $3, updated_at = now()
          WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL
          RETURNING ${RETURNING}`,
        [input.drive, resourceId, input.content.length]
      );
      return rowToResource(res.rows[0]);
    });
  }

  /**
   * Soft-delete a resource (tombstone). A non-empty directory is refused
   * (`not_empty`). The blob is RETAINED — hard erasure is a separate P5 path.
   */
  async delete(input: DeleteInput): Promise<void> {
    return this.tx.transaction(async (client) => {
      const resourceId = toDbResourceId(input.resourceId);
      const current = await this.lockResource(client, input.drive, resourceId);
      if (!current) throw new GfsError("not_found", `resource not found: ${input.resourceId}`);
      if (current.deletedAt) {
        throw GfsError.gone(`resource is already deleted: ${input.resourceId}`, "resource_deleted");
      }
      this.assertVersion(current.version, input.ifMatch);

      if (current.kind === "directory") {
        const children = await client.query(
          `SELECT 1 FROM gfs_resources
            WHERE drive = $1 AND parent_resource_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [input.drive, resourceId]
        );
        if (children.rows.length > 0) {
          throw new GfsError("not_empty", `directory is not empty: ${input.resourceId}`);
        }
      }

      await client.query(
        `UPDATE gfs_resources SET deleted_at = now(), updated_at = now()
          WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL`,
        [input.drive, resourceId]
      );
    });
  }

  /** Throw precondition_failed when a provided If-Match does not match. */
  private assertVersion(currentVersion: number, ifMatch: number | undefined): void {
    try {
      assertIfMatch(currentVersion, ifMatch);
    } catch {
      throw new GfsError(
        "precondition_failed",
        `If-Match ${ifMatch} does not match current version ${currentVersion}`
      );
    }
  }

  /** Fetch a resource (any state) without a lock — for the create parent check. */
  private async liveResource(
    client: TxClient,
    drive: string,
    resourceId: string
  ): Promise<GfsResource | null> {
    const res = await client.query(
      `SELECT ${RETURNING} FROM gfs_resources
        WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL`,
      [drive, resourceId]
    );
    return res.rows[0] ? rowToResource(res.rows[0]) : null;
  }

  /** Fetch + row-lock a resource (FOR UPDATE) to serialize concurrent mutations. */
  private async lockResource(
    client: TxClient,
    drive: string,
    resourceId: string
  ): Promise<GfsResource | null> {
    const res = await client.query(
      `SELECT ${RETURNING} FROM gfs_resources
        WHERE drive = $1 AND resource_id = $2 FOR UPDATE`,
      [drive, resourceId]
    );
    return res.rows[0] ? rowToResource(res.rows[0]) : null;
  }
}

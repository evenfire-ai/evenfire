import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { CopyDestinationSnapshot, CopyPreflightPlan } from "../api/copy";
import { GfsError } from "../api/errors";
import { GfsResource } from "../api/read";
import { assertIfMatch } from "../api/write";
import type { AuditSink } from "../authz/audit";
import type { PermissionEpoch } from "../authz/cache";
import { normalizeResourceId } from "../storage/paths";
import { discardCandidate, PgBlobStagingStore, stageVerifiedBlob, type GfsContent } from "./blobStaging";
export type { GfsContent, GfsContentSource } from "./blobStaging";
import { publishCopy, type CopyPublicationResult } from "./copyPublication";
import { acquireBeforeDeadline } from "./deadlineQuery";
import {
  inspectCreateOutcome,
  inspectReplaceRollback,
  recordManagedMutation,
  type ManagedMutationContext,
} from "./managedMutationAudit";
import { publishRename, type RenameInput } from "./renamePublication";

/** Minimal transaction-scoped query surface (a pg PoolClient satisfies it). */
export interface TxClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Runs `fn` inside a single BEGIN/COMMIT, rolling back on any throw. */
export interface Transactor {
  transaction<T>(fn: (client: TxClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export interface TransactionOptions {
  deadlineAtMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

/** A pg Pool checked out for one transaction (connect → BEGIN → fn → COMMIT). */
export interface PoolLike {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    /** Passing an error destroys the client instead of returning it to the pool. */
    release(error?: Error | boolean): void;
  }>;
}

export class CommitOutcomeUnknownError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("transaction commit outcome is unknown");
    this.name = "CommitOutcomeUnknownError";
    this.cause = cause;
  }
}

export class RollbackOutcomeUnknownError extends Error {
  readonly cause: unknown;
  readonly rollbackCause: unknown;
  constructor(cause: unknown, rollbackCause: unknown) {
    super("transaction rollback outcome is unknown");
    this.name = "RollbackOutcomeUnknownError";
    this.cause = cause;
    this.rollbackCause = rollbackCause;
  }
}

// PgTransactor serves every deadline-armed mutation (copy AND rename), so its
// expiry message is mutation-generic; the copy pipeline's own gates keep the
// copy-specific wording.
function remainingMs(options: TransactionOptions): number {
  options.signal?.throwIfAborted();
  const remaining = options.deadlineAtMs - (options.now ?? Date.now)();
  if (remaining <= 0) throw new GfsError("precondition_failed", "synchronous mutation deadline exceeded");
  return Math.max(1, Math.min(remaining, 2_147_483_647));
}

/**
 * Postgres-backed Transactor: checks out one client, BEGINs, runs `fn`, and
 * COMMITs — ROLLBACKing (best-effort) on any throw so a failed write never
 * leaves a half-applied mutation. The client is always released.
 */
export class PgTransactor implements Transactor {
  constructor(private readonly pool: PoolLike) {}

  async transaction<T>(fn: (client: TxClient) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const client = options
      ? await acquireBeforeDeadline(() => this.pool.connect(), options)
      : await this.pool.connect();
    let commitSent = false;
    let poison: Error | undefined;
    try {
      await client.query("BEGIN");
      if (options) {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(options))]);
      }
      const result = await fn(client);
      if (options) remainingMs(options); // the final gate is immediately before COMMIT
      commitSent = true;
      await client.query("COMMIT");
      return result;
    } catch (err) {
      let rollbackFailure: unknown;
      await client.query("ROLLBACK").catch((rollbackErr) => {
        rollbackFailure = rollbackErr;
        console.error(
          `[gfsc] ROLLBACK failed after a write error: ${
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          }`
        );
      });
      if (commitSent) {
        poison = err instanceof Error ? err : new Error(String(err));
        throw new CommitOutcomeUnknownError(err);
      }
      if (rollbackFailure !== undefined) {
        poison = rollbackFailure instanceof Error ? rollbackFailure : new Error(String(rollbackFailure));
        throw new RollbackOutcomeUnknownError(err, rollbackFailure);
      }
      if (options && ((err as { code?: string }).code === "57014"
        || options.signal?.aborted
        || (options.now ?? Date.now)() >= options.deadlineAtMs)) {
        throw new GfsError("precondition_failed", "synchronous mutation deadline exceeded");
      }
      throw err;
    } finally {
      client.release(poison);
    }
  }
}

/** The blob side of a write (BlobStore satisfies this; reader replicas reject). */
export interface BlobWriter {
  writeImmutable(
    resourceId: string,
    generation: string,
    data: Readable | Buffer
  ): Promise<{ blobKey: string; bytes: number; contentSha256: string }>;
  verify(blobKey: string, expectedBytes: number, expectedSha256: string): Promise<void>;
  deleteByKey(blobKey: string): Promise<void>;
  deleteLegacyFlat(resourceId: string): Promise<void>;
  /** Copy-only capabilities. BlobStore implements both; simple write fakes need not. */
  read?(resourceId: string, blobKey?: string | null): Promise<Readable>;
  availableBytes?(): Promise<bigint>;
}

const RETURNING =
  "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key, content_sha256, deleted_at";

interface AncestorRow {
  resourceId: string;
  drive: string;
  parentResourceId: string | null;
  name: string;
  kind: string;
  deletedAt: string | null;
  cycle: boolean;
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
  /** Reserved by an idempotent caller such as an upload session. */
  resourceId?: string;
  content?: GfsContent;
  mutation?: ManagedMutationContext;
  /** Optional hook executed in the same transaction as resource publication. */
  onPublished?: (client: TxClient, resource: GfsResource, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}
export interface ReplaceInput {
  drive: string;
  resourceId: string;
  ifMatch?: number;
  content: GfsContent;
  mutation?: ManagedMutationContext;
  /** Optional hook executed in the same transaction as resource publication. */
  onPublished?: (client: TxClient, resource: GfsResource, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}
export interface DeleteInput {
  drive: string;
  resourceId: string;
  ifMatch?: number;
}

export interface CopyInput {
  requestId: string;
  subject: string;
  audit: AuditSink;
  drive: string;
  destinationParentId: string;
  plan: CopyPreflightPlan;
  destination: CopyDestinationSnapshot;
  deadlineAtMs: number;
  signal?: AbortSignal;
  now?: () => number;
  /**
   * Permission epoch captured at authorization time plus a reader for the live
   * epoch. `revalidate` compares them inside the writer transaction so a grant
   * revoked while blobs were staged is caught before the INSERT (TOCTOU close).
   * Optional so non-route copy callers/tests are unaffected.
   */
  authzEpoch?: { captured: PermissionEpoch; current: () => PermissionEpoch };
}

export class GfsWriteService {
  constructor(
    private readonly tx: Transactor,
    private readonly blobs: BlobWriter,
    private readonly manifests: PgBlobStagingStore,
    private readonly ids: { resourceId: () => string; generation: () => string; requestId: () => string } = {
      resourceId: randomUUID,
      generation: randomUUID,
      requestId: randomUUID,
    }
  ) {}

  async copy(input: CopyInput): Promise<CopyPublicationResult> {
    return publishCopy(
      { tx: this.tx, blobs: this.blobs, manifests: this.manifests, ids: this.ids },
      input
    );
  }

  async rename(input: RenameInput): Promise<GfsResource> {
    return publishRename(this.tx, input);
  }

  async create(input: CreateInput): Promise<GfsResource> {
    const kind = input.kind ?? "file";
    if (kind !== "file" && kind !== "directory") {
      throw new GfsError("path_invalid", `unsupported resource kind: ${String(kind)}`);
    }
    const content = input.content ?? Buffer.alloc(0);
    const resourceId = input.resourceId ?? this.ids.resourceId();
    const dbResourceId = toDbResourceId(resourceId);
    const parentId = toDbResourceId(input.parentId);
    let staged: Awaited<ReturnType<typeof stageVerifiedBlob>> | null = null;
    let expected: GfsResource | undefined;

    try {
      staged = kind === "file"
        ? await stageVerifiedBlob(this.manifests, this.blobs, this.ids, resourceId, content, {
          signal: input.signal,
          ...(input.deadlineAtMs ? { checkDeadline: () => {
            if (Date.now() >= input.deadlineAtMs!) throw new GfsError("precondition_failed", "upload finalization timed out");
          } } : {}),
        })
        : null;
      const created = await this.tx.transaction(async client => {
        input.signal?.throwIfAborted();
        await this.lockStructure(client, input.drive);
        const observedAncestors = await this.loadAncestorChain(client, parentId);
        if (observedAncestors.length === 0) {
          throw new GfsError("not_found", `parent not found: ${input.parentId}`);
        }
        await this.lockRows(
          client,
          observedAncestors.map(row => row.resourceId)
        );
        const ancestors = await this.loadAncestorChain(client, parentId);
        if (!this.sameAncestorChain(observedAncestors, ancestors)) {
          throw new GfsError("precondition_failed", "parent ancestry changed during create");
        }
        if (ancestors[0].kind !== "directory") {
          throw new GfsError("not_a_directory", `parent is not a directory: ${input.parentId}`);
        }
        const parentPath = this.canonicalDirectoryPath(ancestors, input.drive);
        const pathCache = `${parentPath === "/" ? "" : parentPath}/${input.name}`;
        let row: Record<string, unknown>;
        try {
          const res = await client.query(
            `INSERT INTO gfs_resources
               (resource_id, drive, parent_resource_id, name, kind, path_cache,
                version, bytes, blob_key, content_sha256)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)
             RETURNING ${RETURNING}`,
            [
              dbResourceId,
              input.drive,
              parentId,
              input.name,
              kind,
              pathCache,
              kind === "file" ? staged?.bytes ?? 0 : 0,
              staged?.blobKey ?? null,
              staged?.contentSha256 ?? null,
            ]
          );
          row = res.rows[0];
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new GfsError("already_exists", `a resource named '${input.name}' already exists here`);
          }
          throw err;
        }
        if (staged) await this.manifests.markCommitted(client, staged.blobKey);
        expected = rowToResource(row);
        await input.onPublished?.(client, expected, input.signal);
        input.signal?.throwIfAborted();
        await recordManagedMutation(input.mutation, { op: "create", resourceId: dbResourceId, drive: input.drive }, "succeeded", undefined, client);
        input.signal?.throwIfAborted();
        return expected;
      }, input.deadlineAtMs ? { deadlineAtMs: input.deadlineAtMs, signal: input.signal } : undefined);
      if (staged) await this.manifests.removeCommitted(staged.blobKey).catch(() => undefined);
      return created;
    } catch (err) {
      if (err instanceof CommitOutcomeUnknownError || err instanceof RollbackOutcomeUnknownError) {
        if (staged) {
          const published = await this.manifests.resolvePublished(input.drive, dbResourceId, staged.blobKey).catch(() => null);
          if (published && expected) {
            await this.manifests.removeCommitted(staged.blobKey).catch(() => undefined);
            return rowToResource(published);
          }
        }
        const outcome = await inspectCreateOutcome(this.tx, input.drive, dbResourceId, expected);
        if (outcome === "full" && expected) return expected;
        if (outcome !== "zero") throw err;
      }
      if (staged) await discardCandidate(this.manifests, this.blobs, staged.blobKey).catch(() => undefined);
      await recordManagedMutation(input.mutation, { op: "create", resourceId: dbResourceId, drive: input.drive }, "failed", err instanceof GfsError ? err.code : "internal_error");
      throw err;
    }
  }

  async replace(input: ReplaceInput): Promise<GfsResource> {
    const resourceId = toDbResourceId(input.resourceId);
    let staged: Awaited<ReturnType<typeof stageVerifiedBlob>> | null = null;
    let previous: GfsResource | undefined;
    try {
      const candidate = await stageVerifiedBlob(this.manifests, this.blobs, this.ids, resourceId, input.content, {
        signal: input.signal,
        ...(input.deadlineAtMs ? { checkDeadline: () => {
          if (Date.now() >= input.deadlineAtMs!) throw new GfsError("precondition_failed", "upload finalization timed out");
        } } : {}),
      });
      staged = candidate;
      const updated = await this.tx.transaction(async client => {
        input.signal?.throwIfAborted();
        const current = await this.lockResource(client, input.drive, resourceId);
        if (!current) throw new GfsError("not_found", `resource not found: ${input.resourceId}`);
        if (current.deletedAt) {
          throw GfsError.gone(`resource is deleted: ${input.resourceId}`, "resource_deleted");
        }
        if (current.kind === "directory") {
          throw new GfsError("is_a_directory", `resource is a directory: ${input.resourceId}`);
        }
        previous = current;
        this.assertVersion(current.version, input.ifMatch);
        const res = await client.query(
          `UPDATE gfs_resources
              SET version = version + 1, bytes = $3, blob_key = $4,
                  content_sha256 = $5, updated_at = now()
            WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL
            RETURNING ${RETURNING}`,
            [input.drive, resourceId, candidate.bytes, candidate.blobKey, candidate.contentSha256]
        );
        await this.manifests.markCommitted(client, candidate.blobKey);
        if (current.blobKey && current.contentSha256) {
          await this.manifests.markSuperseded(client, {
            blobKey: current.blobKey,
            resourceId,
            contentSha256: current.contentSha256,
            bytes: current.bytes,
          });
        } else {
          await this.manifests.markLegacySuperseded(client, resourceId, current.bytes);
        }
        const published = rowToResource(res.rows[0]);
        await input.onPublished?.(client, published, input.signal);
        input.signal?.throwIfAborted();
        await recordManagedMutation(input.mutation, { op: "replace", resourceId, drive: input.drive }, "succeeded", undefined, client);
        input.signal?.throwIfAborted();
        return published;
      }, input.deadlineAtMs ? { deadlineAtMs: input.deadlineAtMs, signal: input.signal } : undefined);
      await this.manifests.removeCommitted(staged.blobKey).catch(() => undefined);
      return updated;
    } catch (err) {
      if (err instanceof CommitOutcomeUnknownError || err instanceof RollbackOutcomeUnknownError) {
        if (staged) {
          const published = await this.manifests.resolvePublished(input.drive, resourceId, staged.blobKey).catch(() => null);
          if (published) {
            await this.manifests.removeCommitted(staged.blobKey).catch(() => undefined);
            return rowToResource(published);
          }
        }
        if (!previous || await inspectReplaceRollback(this.tx, previous) !== "old") throw err;
      }
      if (staged) await discardCandidate(this.manifests, this.blobs, staged.blobKey).catch(() => undefined);
      await recordManagedMutation(input.mutation, { op: "replace", resourceId, drive: input.drive }, "failed", err instanceof GfsError ? err.code : "internal_error");
      throw err;
    }
  }

  async delete(input: DeleteInput): Promise<void> {
    return this.tx.transaction(async (client) => {
      await this.lockStructure(client, input.drive);
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

  private async lockStructure(client: TxClient, drive: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`,
      [drive]
    );
  }

  private async loadAncestorChain(client: TxClient, resourceId: string): Promise<AncestorRow[]> {
    const result = await client.query(
      `WITH RECURSIVE ancestor_chain AS (
         SELECT r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.deleted_at,
                ARRAY[r.resource_id]::uuid[] AS visited, false AS cycle, 0 AS depth
           FROM gfs_resources r
          WHERE r.resource_id = $1::uuid
         UNION ALL
         SELECT parent.resource_id, parent.drive, parent.parent_resource_id,
                parent.name, parent.kind, parent.deleted_at,
                child.visited || parent.resource_id,
                parent.resource_id = ANY(child.visited) AS cycle,
                child.depth + 1
           FROM ancestor_chain child
           JOIN gfs_resources parent ON parent.resource_id = child.parent_resource_id
          WHERE NOT child.cycle
       )
       SELECT resource_id, drive, parent_resource_id, name, kind, deleted_at, cycle
         FROM ancestor_chain
        ORDER BY depth ASC`,
      [resourceId]
    );
    return result.rows.map(row => ({
      resourceId: String(row.resource_id),
      drive: String(row.drive),
      parentResourceId:
        row.parent_resource_id == null ? null : String(row.parent_resource_id),
      name: String(row.name),
      kind: String(row.kind),
      deletedAt: toIsoOrNull(row.deleted_at),
      cycle: row.cycle === true,
    }));
  }

  private async lockRows(client: TxClient, resourceIds: string[]): Promise<void> {
    const ids = [...new Set(resourceIds)].sort();
    await client.query(
      `SELECT resource_id
         FROM gfs_resources
        WHERE resource_id = ANY($1::uuid[])
        ORDER BY resource_id
        FOR UPDATE`,
      [ids]
    );
  }

  private sameAncestorChain(observed: AncestorRow[], locked: AncestorRow[]): boolean {
    return (
      observed.length === locked.length &&
      observed.every((row, index) => {
        const current = locked[index];
        return (
          current !== undefined &&
          row.resourceId === current.resourceId &&
          row.drive === current.drive &&
          row.parentResourceId === current.parentResourceId &&
          row.name === current.name &&
          row.kind === current.kind &&
          row.deletedAt === current.deletedAt &&
          row.cycle === current.cycle
        );
      })
    );
  }

  private canonicalDirectoryPath(ancestors: AncestorRow[], drive: string): string {
    if (
      ancestors.some(
        row =>
          row.cycle ||
          row.deletedAt !== null ||
          row.drive !== drive ||
          row.kind !== "directory"
      ) ||
      ancestors.at(-1)?.parentResourceId !== null ||
      ancestors.at(-1)?.name !== ""
    ) {
      throw new GfsError("precondition_failed", "parent ancestry is not a live same-drive chain");
    }
    const segments = ancestors
      .slice(0, -1)
      .map(row => row.name)
      .reverse();
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

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

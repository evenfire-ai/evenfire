import type { AuditSink } from "../authz/audit";
import { GfsError } from "../api/errors";
import type { GfsResource } from "../api/read";
import { normalizeResourceId } from "../storage/paths";
import type { CommitOutcomeUnknownError, Transactor, TxClient } from "./writeStore";

const AMBIGUOUS_COMMIT_INSPECTION_MS = 2_000;
const POST_FAILURE_AUDIT_MS = 2_000;

export interface RenameInput {
  requestId: string;
  subject: string;
  audit: AuditSink;
  drive: string;
  resourceId: string;
  newName: string;
  ifMatch: number;
  /** Maximum live subtree size admitted by one synchronous rename. */
  maxObjects: number;
  /** Absolute deadline; arms statement_timeout on the publication transaction. */
  deadlineAtMs: number;
  now?: () => number;
}

interface Row {
  resourceId: string;
  drive: string;
  parentResourceId: string | null;
  name: string;
  kind: "file" | "directory";
  pathCache: string | null;
  version: number;
  bytes: number;
  blobKey: string | null;
  contentSha256: string | null;
  deletedAt: string | null;
  updatedAt: string | null;
  depth: number;
  cycle: boolean;
  underTombstone: boolean;
}

const COLUMNS = "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key, content_sha256, deleted_at, updated_at";
// The publication UPDATE joins jsonb_to_recordset AS path(resource_id, ...),
// so its RETURNING list must qualify every column: an unqualified resource_id
// there is ambiguous between the updated row and the path record set.
const RETURNING_COLUMNS = COLUMNS.split(", ")
  .map(column => `resource.${column}`)
  .join(", ");

function dbId(value: string): string {
  const rid = normalizeResourceId(value);
  return `${rid.slice(0, 8)}-${rid.slice(8, 12)}-${rid.slice(12, 16)}-${rid.slice(16, 20)}-${rid.slice(20)}`;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function row(value: Record<string, unknown>): Row {
  return {
    resourceId: String(value.resource_id), drive: String(value.drive),
    parentResourceId: value.parent_resource_id == null ? null : String(value.parent_resource_id),
    name: String(value.name), kind: String(value.kind) === "directory" ? "directory" : "file",
    pathCache: value.path_cache == null ? null : String(value.path_cache), version: Number(value.version),
    bytes: Number(value.bytes), blobKey: value.blob_key == null ? null : String(value.blob_key),
    contentSha256: value.content_sha256 == null ? null : String(value.content_sha256),
    deletedAt: iso(value.deleted_at), updatedAt: iso(value.updated_at),
    depth: Number(value.depth ?? 0), cycle: value.cycle === true,
    underTombstone: value.under_tombstone === true,
  };
}

function resource(value: Row): GfsResource {
  return { resourceId: value.resourceId, drive: value.drive, parentResourceId: value.parentResourceId,
    name: value.name, kind: value.kind, pathCache: value.pathCache, version: value.version,
    bytes: value.bytes, blobKey: value.blobKey, contentSha256: value.contentSha256, deletedAt: value.deletedAt };
}

function same(a: readonly Row[], b: readonly Row[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return other !== undefined && JSON.stringify(item) === JSON.stringify(other);
  });
}

// The drive predicate on the recursive join is redundant with validateTree's
// cross-drive rejection, but it lets the planner drive-lead the
// (drive, parent_resource_id) index instead of scanning per recursion level.
// LIMIT bounds the rows materialized into this process; the SQL-side work is
// bounded by the transaction's statement_timeout.
async function loadTree(client: TxClient, drive: string, resourceId: string, limit: number): Promise<Row[]> {
  const result = await client.query(
    `WITH RECURSIVE rename_tree AS (
       SELECT r.*, 0 AS depth, ARRAY[r.resource_id]::uuid[] AS visited,
              false AS cycle, false AS under_tombstone
         FROM gfs_resources r WHERE r.drive = $1 AND r.resource_id = $2
       UNION ALL
       SELECT child.*, parent.depth + 1, parent.visited || child.resource_id,
              child.resource_id = ANY(parent.visited) AS cycle,
              parent.under_tombstone OR child.deleted_at IS NOT NULL AS under_tombstone
         FROM rename_tree parent
         JOIN gfs_resources child ON child.drive = $1 AND child.parent_resource_id = parent.resource_id
        WHERE NOT parent.cycle
     )
     SELECT ${COLUMNS}, depth, cycle, under_tombstone
       FROM rename_tree
      WHERE depth = 0 OR deleted_at IS NULL
      ORDER BY resource_id
      LIMIT $3`,
    [drive, resourceId, limit]
  );
  return result.rows.map(row);
}

function loadLimit(input: RenameInput): number {
  return input.maxObjects + 1;
}

function assertWithinLimit(tree: readonly Row[], input: RenameInput): void {
  if (tree.length > input.maxObjects) {
    throw new GfsError("payload_too_large", "rename subtree exceeds the synchronous rename object limit");
  }
}

function validateTree(tree: readonly Row[], input: RenameInput): { root: Row; oldPath: string } {
  const root = tree.find(item => item.resourceId === dbId(input.resourceId) && item.depth === 0);
  if (!root) throw new GfsError("not_found", "rename resource not found");
  if (root.parentResourceId === null) throw new GfsError("path_invalid", "drive root cannot be renamed");
  if (root.deletedAt !== null) throw GfsError.gone("resource is deleted", "resource_deleted");
  if (root.version !== input.ifMatch) throw new GfsError("precondition_failed", "rename If-Match is stale");
  const ids = new Set<string>();
  for (const item of tree) {
    if (ids.has(item.resourceId) || item.cycle || item.underTombstone
      || item.drive !== input.drive || item.deletedAt !== null) {
      throw new GfsError("precondition_failed", "rename subtree is not a stable live tree");
    }
    ids.add(item.resourceId);
  }
  return { root, oldPath: root.pathCache ?? "" };
}

function childPath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

function buildPaths(tree: readonly Row[], root: Row, parentPath: string, newName: string) {
  const oldPaths = new Map<string, string>();
  const newPaths = new Map<string, string>();
  const ordered = [...tree].sort((a, b) => a.depth - b.depth || a.resourceId.localeCompare(b.resourceId));
  for (const item of ordered) {
    if (item.resourceId === root.resourceId) {
      const expected = childPath(parentPath, item.name);
      if (item.pathCache !== expected) throw new GfsError("precondition_failed", "rename root path is non-canonical");
      oldPaths.set(item.resourceId, expected);
      newPaths.set(item.resourceId, childPath(parentPath, newName));
      continue;
    }
    if (item.parentResourceId === null) throw new GfsError("precondition_failed", "rename subtree parent map is inconsistent");
    const oldParentPath = oldPaths.get(item.parentResourceId);
    const newParentPath = newPaths.get(item.parentResourceId);
    if (!oldParentPath || !newParentPath) throw new GfsError("precondition_failed", "rename subtree parent map is inconsistent");
    const expected = childPath(oldParentPath, item.name);
    if (item.pathCache !== expected) throw new GfsError("precondition_failed", "rename descendant path is non-canonical");
    oldPaths.set(item.resourceId, expected);
    newPaths.set(item.resourceId, childPath(newParentPath, item.name));
  }
  return ordered.map(item => ({ resourceId: item.resourceId, pathCache: newPaths.get(item.resourceId)! }));
}

function auditEvent(input: RenameInput, outcome: "succeeded" | "failed", reason?: string) {
  return {
    recordType: "mutation_outcome" as const, subject: input.subject, op: "rename",
    resourceId: normalizeResourceId(input.resourceId), drive: input.drive,
    outcome: outcome === "succeeded" ? "allow" as const : "error" as const,
    reason, requestId: input.requestId, matchedSubject: null,
    authorizationSource: null, cachedAuthorizationSource: null, mutationOutcome: outcome,
  };
}

function recoveryBudget(durationMs: number) {
  return { deadlineAtMs: Date.now() + durationMs };
}

async function inspectAmbiguousRename(
  tx: Transactor,
  input: RenameInput,
  before: readonly Row[],
  expected: readonly Row[]
): Promise<"full" | "zero" | "unsafe"> {
  try {
    return await tx.transaction(async client => {
      const current = await loadTree(client, input.drive, dbId(input.resourceId), loadLimit(input));
      if (same(current, expected)) return "full";
      if (same(current, before)) return "zero";
      return "unsafe";
    }, recoveryBudget(AMBIGUOUS_COMMIT_INSPECTION_MS));
  } catch {
    return "unsafe";
  }
}

export async function publishRename(tx: Transactor, input: RenameInput): Promise<GfsResource> {
  let before: Row[] | undefined;
  let expected: Row[] | undefined;
  let expectedRoot: GfsResource | undefined;
  try {
    return await tx.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`, [input.drive]);
      const observed = await loadTree(client, input.drive, dbId(input.resourceId), loadLimit(input));
      assertWithinLimit(observed, input);
      const { root } = validateTree(observed, input);
      const lockIds = [...new Set([...observed.map(item => item.resourceId), root.parentResourceId!])].sort();
      await client.query(`SELECT resource_id FROM gfs_resources WHERE resource_id = ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE`, [lockIds]);
      const locked = await loadTree(client, input.drive, dbId(input.resourceId), loadLimit(input));
      assertWithinLimit(locked, input);
      if (!same(observed, locked)) throw new GfsError("precondition_failed", "rename subtree changed concurrently");
      validateTree(locked, input);
      const parent = await client.query(`SELECT path_cache, deleted_at FROM gfs_resources WHERE drive = $1 AND resource_id = $2`, [input.drive, root.parentResourceId]);
      const parentRow = parent.rows[0];
      if (!parentRow || parentRow.deleted_at != null || typeof parentRow.path_cache !== "string") {
        throw new GfsError("precondition_failed", "rename parent changed concurrently");
      }
      const paths = buildPaths(locked, root, parentRow.path_cache, input.newName);
      const pathById = new Map(paths.map(item => [item.resourceId, item.pathCache]));
      const collision = await client.query(`SELECT 1 FROM gfs_resources WHERE drive = $1 AND parent_resource_id = $2 AND name = $3 AND resource_id <> $4 AND deleted_at IS NULL LIMIT 1`, [input.drive, root.parentResourceId, input.newName, root.resourceId]);
      if (collision.rows.length > 0) throw new GfsError("already_exists", `a resource named '${input.newName}' already exists here`);
      let updated;
      try { updated = await client.query(
        `UPDATE gfs_resources AS resource SET
           name = CASE WHEN resource.resource_id = $1 THEN $2 ELSE resource.name END,
           path_cache = path.path_cache,
           version = CASE WHEN resource.resource_id = $1 THEN resource.version + 1 ELSE resource.version END,
           updated_at = now()
          FROM jsonb_to_recordset($3::jsonb) AS path(resource_id uuid, path_cache text)
         WHERE resource.drive = $4 AND resource.resource_id = path.resource_id
         RETURNING ${RETURNING_COLUMNS}`,
        [root.resourceId, input.newName, JSON.stringify(paths.map(item => ({ resource_id: item.resourceId, path_cache: item.pathCache }))), input.drive]
      ); } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new GfsError("already_exists", `a resource named '${input.newName}' already exists here`);
        }
        throw error;
      }
      const updatedRoot = updated.rows.find(item => String(item.resource_id) === root.resourceId);
      if (!updatedRoot || updated.rows.length !== observed.length) throw new Error("rename update set was incomplete");
      before = locked.map(item => ({ ...item }));
      const updatedById = new Map(updated.rows.map(item => [String(item.resource_id), row(item)]));
      expected = locked.map(item => {
        const updatedItem = updatedById.get(item.resourceId);
        if (!updatedItem || updatedItem.pathCache !== pathById.get(item.resourceId)) {
          throw new Error("rename returned an inconsistent update set");
        }
        return { ...updatedItem, depth: item.depth, cycle: item.cycle };
      });
      expectedRoot = resource(row(updatedRoot));
      await input.audit.record(auditEvent(input, "succeeded"), client);
      return expectedRoot;
    }, { deadlineAtMs: input.deadlineAtMs, now: input.now });
  } catch (error) {
    if ((error as Error).name === "CommitOutcomeUnknownError") {
      if (before && expected && expectedRoot) {
        // The request that lost COMMIT may already be cancelled or expired.
        // Resolve once on a fresh bounded connection before reporting failure
        // or treating the committed rename as unknown.
        const outcome = await inspectAmbiguousRename(tx, input, before, expected);
        if (outcome === "full") return expectedRoot;
        if (outcome === "zero") {
          await input.audit.record(
            auditEvent(input, "failed", "internal_error"),
            undefined,
            recoveryBudget(POST_FAILURE_AUDIT_MS)
          );
        }
      }
      throw error as CommitOutcomeUnknownError;
    }
    await input.audit.record(auditEvent(input, "failed", error instanceof GfsError ? error.code : "internal_error"));
    throw error;
  }
}

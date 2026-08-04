import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { CopyDestinationSnapshot, CopyPreflightPlan, CopySnapshotNode } from "../api/copy";
import { GfsError } from "../api/errors";
import type { GfsResource } from "../api/read";
import { normalizeResourceId } from "../storage/paths";
import { discardCandidate, stageCopiedBlob, type PgBlobStagingStore, type PublishedTreeRef } from "./blobStaging";
import type { DeadlineBudget } from "./deadlineQuery";
import type { BlobWriter, CommitOutcomeUnknownError, CopyInput, Transactor, TxClient } from "./writeStore";

interface Dependencies {
  tx: Transactor;
  blobs: BlobWriter;
  manifests: PgBlobStagingStore;
  ids: { resourceId: () => string; generation: () => string };
}

interface ReservedNode extends PublishedTreeRef {
  source: CopySnapshotNode;
  generation: string | null;
}

export interface CopyPublicationResult {
  root: GfsResource;
  requestId: string;
  objectCount: number;
  fileCount: number;
  folderCount: number;
  totalBytes: bigint;
}

const RETURNING = "resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key, content_sha256, deleted_at";
const AMBIGUOUS_COMMIT_INSPECTION_MS = 2_000;
const POST_FAILURE_AUDIT_MS = 2_000;

function dbId(value: string): string {
  const rid = normalizeResourceId(value);
  return `${rid.slice(0, 8)}-${rid.slice(8, 12)}-${rid.slice(12, 16)}-${rid.slice(16, 20)}-${rid.slice(20)}`;
}

function deadline(input: CopyInput): void {
  input.signal?.throwIfAborted();
  if ((input.now ?? Date.now)() >= input.deadlineAtMs) {
    throw new GfsError("precondition_failed", "synchronous copy deadline exceeded");
  }
}

function capabilities(blobs: BlobWriter): asserts blobs is BlobWriter & {
  read(resourceId: string, blobKey?: string | null): Promise<Readable>;
  availableBytes(): Promise<bigint>;
} {
  if (!blobs.read || !blobs.availableBytes) throw new Error("copy requires readable capacity-aware blob storage");
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function matchesSnapshot(row: Record<string, unknown>, expected: CopySnapshotNode): boolean {
  let bytes: bigint;
  try { bytes = BigInt(String(row.bytes)); } catch { return false; }
  return String(row.resource_id) === dbId(expected.resourceId)
    && String(row.drive) === expected.drive
    && nullable(row.parent_resource_id) === (expected.parentResourceId === null ? null : dbId(expected.parentResourceId))
    && String(row.name) === expected.name
    && String(row.kind) === expected.kind
    && nullable(row.path_cache) === expected.pathCache
    && Number(row.version) === expected.version
    && bytes === expected.bytes
    && nullable(row.blob_key) === expected.blobKey
    && nullable(row.content_sha256) === expected.contentSha256
    && nullable(row.deleted_at) === expected.deletedAt
    && (!("depth" in row) || Number(row.depth) === expected.depth)
    && (!("cycle" in row) || Boolean(row.cycle) === expected.cycle)
    && (!("under_tombstone" in row) || Boolean(row.under_tombstone) === expected.underTombstone);
}

function sameRows(rows: Record<string, unknown>[], expected: readonly CopySnapshotNode[]): boolean {
  if (rows.length !== expected.length) return false;
  const byId = new Map(rows.map(row => [String(row.resource_id), row]));
  return expected.every(node => {
    const row = byId.get(dbId(node.resourceId));
    return row !== undefined && matchesSnapshot(row, node);
  });
}

function sameChildren(rows: Record<string, unknown>[], expected: CopyDestinationSnapshot["liveChildren"]): boolean {
  if (rows.length !== expected.length) return false;
  const actual = rows.map(row => `${String(row.resource_id)}\0${String(row.name)}`).sort();
  const wanted = expected.map(child => `${dbId(child.resourceId)}\0${child.name}`).sort();
  return actual.every((value, index) => value === wanted[index]);
}

function resource(ref: PublishedTreeRef, drive: string): GfsResource {
  return {
    resourceId: ref.resourceId, drive, parentResourceId: ref.parentResourceId,
    name: ref.name, kind: ref.kind, pathCache: ref.pathCache, version: 0,
    bytes: Number(ref.bytes), blobKey: ref.blobKey, contentSha256: ref.contentSha256, deletedAt: null,
  };
}

async function hashLegacy(stream: Readable, input: CopyInput, expectedBytes: bigint): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0n;
  for await (const chunk of stream) {
    deadline(input);
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += BigInt(value.length);
    hash.update(value);
  }
  if (bytes !== expectedBytes) throw new GfsError("precondition_failed", "legacy copy source changed after preflight");
  return hash.digest("hex");
}

function reserve(plan: CopyPreflightPlan, input: CopyInput, deps: Dependencies): ReservedNode[] {
  const ids = new Map(plan.nodes.map(node => [normalizeResourceId(node.resourceId), dbId(deps.ids.resourceId())]));
  const destinationId = dbId(input.destinationParentId);
  const destination = input.destination.ancestors.find(node => dbId(node.resourceId) === destinationId && node.depth === 0)!;
  const paths = new Map<string, string>();
  return plan.nodes.map(source => {
    const sourceId = normalizeResourceId(source.resourceId);
    const oldParent = plan.parentByResourceId.get(sourceId);
    if (oldParent === undefined) throw new GfsError("precondition_failed", "copy plan parent map is incomplete");
    const parentResourceId = oldParent === null ? destinationId : ids.get(oldParent)!;
    const name = oldParent === null ? plan.rootName : source.name;
    const parentPath = oldParent === null ? destination.pathCache! : paths.get(oldParent)!;
    const pathCache = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    paths.set(sourceId, pathCache);
    return {
      source, resourceId: ids.get(sourceId)!, parentResourceId, name, kind: source.kind,
      pathCache, version: 0, bytes: source.bytes, blobKey: null, contentSha256: null,
      generation: source.kind === "file" ? deps.ids.generation() : null,
    };
  });
}

async function cleanup(deps: Dependencies, budget: DeadlineBudget, blobKeys: readonly string[]): Promise<void> {
  await Promise.all(blobKeys.map(key => discardCandidate(deps.manifests, deps.blobs, key, budget).catch(() => undefined)));
}

function inputBudget(input: CopyInput): DeadlineBudget {
  return { deadlineAtMs: input.deadlineAtMs, signal: input.signal, now: input.now };
}
function ambiguousCommitBudget(): DeadlineBudget {
  return { deadlineAtMs: Date.now() + AMBIGUOUS_COMMIT_INSPECTION_MS };
}
function postFailureAuditBudget(): DeadlineBudget {
  return { deadlineAtMs: Date.now() + POST_FAILURE_AUDIT_MS };
}

async function revalidate(client: TxClient, input: CopyInput): Promise<void> {
  deadline(input);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`, [input.drive]);
  deadline(input);
  const observedIds = [...new Set([
    ...input.plan.nodes.map(node => dbId(node.resourceId)),
    ...input.destination.ancestors.map(node => dbId(node.resourceId)),
    ...input.destination.liveChildren.map(node => dbId(node.resourceId)),
  ])].sort();
  await client.query(`SELECT resource_id FROM gfs_resources WHERE resource_id = ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE`, [observedIds]);
  deadline(input);
  const source = await client.query(
    `WITH RECURSIVE copy_recheck AS (
       SELECT r.*, 0 AS depth, ARRAY[r.resource_id]::uuid[] AS visited,
              false AS cycle, false AS under_tombstone
         FROM gfs_resources r WHERE r.drive = $1 AND r.resource_id = $2
       UNION ALL
       SELECT child.*, parent.depth + 1, parent.visited || child.resource_id,
              child.resource_id = ANY(parent.visited) AS cycle,
              parent.under_tombstone OR child.deleted_at IS NOT NULL AS under_tombstone
         FROM copy_recheck parent
         JOIN gfs_resources child ON child.drive = $1 AND child.parent_resource_id = parent.resource_id
        WHERE NOT parent.cycle
     )
     SELECT ${RETURNING}, depth, cycle, under_tombstone
       FROM copy_recheck
      WHERE depth = 0 OR deleted_at IS NULL
      LIMIT $3`,
    [input.drive, dbId(input.plan.nodes[0].resourceId), BigInt(input.plan.objectCount) + 1n]
  );
  deadline(input);
  const ancestors = await client.query(`SELECT ${RETURNING} FROM gfs_resources WHERE drive = $1 AND resource_id = ANY($2::uuid[]) ORDER BY resource_id`, [input.drive, input.destination.ancestors.map(node => dbId(node.resourceId))]);
  deadline(input);
  const children = await client.query(
    `SELECT resource_id, name FROM gfs_resources
      WHERE drive = $1 AND parent_resource_id = $2 AND deleted_at IS NULL AND name = $3
      ORDER BY resource_id`,
    [input.drive, dbId(input.destinationParentId), input.plan.rootName]
  );
  deadline(input);
  if (children.rows.some(row => String(row.name) === input.plan.rootName)) {
    throw new GfsError("already_exists", `a resource named '${input.plan.rootName}' already exists here`);
  }
  if (!sameRows(source.rows, input.plan.nodes)
    || !sameRows(ancestors.rows, input.destination.ancestors)
    || !sameChildren(children.rows, input.destination.liveChildren)) {
    throw new GfsError("precondition_failed", "copy source or destination changed after preflight");
  }
  // Permission-epoch re-check (TOCTOU close): the snapshot was authorized before
  // blobs were staged, so a grant revoked mid-copy must be caught here — inside
  // the writer transaction, under the advisory lock, immediately before INSERT.
  // A bumped `generation` means a revocation NOTIFY flushed the cache after we
  // authorized; a `bypassed` epoch (either at capture or now) means the LISTEN is
  // degraded and NOTIFYs are not processed, so a revocation cannot be observed —
  // both fail closed rather than publishing against stale authorization.
  if (input.authzEpoch) {
    const started = input.authzEpoch.captured;
    const nowEpoch = input.authzEpoch.current();
    if (started.bypassed || nowEpoch.bypassed || nowEpoch.generation !== started.generation) {
      throw new GfsError("precondition_failed", "authorization changed during copy");
    }
  }
}

function insertSql(nodes: readonly ReservedNode[]): { sql: string; values: unknown[] } {
  const payload = nodes.map((node, ordinal) => ({
    ordinal, resource_id: node.resourceId, drive: node.source.drive,
    parent_resource_id: node.parentResourceId, name: node.name, kind: node.kind,
    path_cache: node.pathCache, bytes: node.bytes.toString(), blob_key: node.blobKey,
    content_sha256: node.contentSha256, version: 0,
  }));
  return {
    sql: `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache, bytes, blob_key, content_sha256, version)
      SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, bytes, blob_key, content_sha256, version
        FROM jsonb_to_recordset($1::jsonb) AS node(resource_id uuid, drive text, parent_resource_id uuid,
          name text, kind text, path_cache text, bytes bigint, blob_key text, content_sha256 text, version integer, ordinal bigint)
       ORDER BY ordinal
      RETURNING ${RETURNING}`,
    values: [JSON.stringify(payload)],
  };
}

function result(input: CopyInput, root: PublishedTreeRef): CopyPublicationResult {
  return { root: resource(root, input.drive), requestId: input.requestId, objectCount: input.plan.objectCount,
    fileCount: input.plan.fileCount, folderCount: input.plan.folderCount, totalBytes: input.plan.totalBytes };
}

function auditEvent(input: CopyInput, resourceId: string, mutationOutcome: "succeeded" | "failed", reason?: string) {
  return {
    recordType: "mutation_outcome" as const,
    subject: input.subject,
    op: "copy",
    resourceId: normalizeResourceId(resourceId),
    drive: input.drive,
    outcome: mutationOutcome === "succeeded" ? "allow" as const : "error" as const,
    reason,
    requestId: input.requestId,
    matchedSubject: null,
    authorizationSource: null,
    cachedAuthorizationSource: null,
    mutationOutcome,
  };
}

async function auditFailure(input: CopyInput, error: unknown): Promise<void> {
  const sourceRoot = input.plan.nodes[0];
  const reason = error instanceof GfsError ? error.code : "internal_error";
  await input.audit.record(
    auditEvent(input, sourceRoot.resourceId, "failed", reason),
    undefined,
    postFailureAuditBudget()
  );
}

async function inspectAmbiguous(
  deps: Dependencies,
  input: CopyInput,
  reserved: ReservedNode[],
  budget: DeadlineBudget
): Promise<"full" | "zero" | "unsafe"> {
  try {
    const published = await deps.manifests.resolvePublishedTree(input.drive, reserved, budget);
    if (published !== null) return "full";
    return await deps.tx.transaction(async client => {
      const rows = await client.query(`SELECT resource_id FROM gfs_resources WHERE drive = $1 AND resource_id = ANY($2::uuid[])`, [input.drive, reserved.map(node => node.resourceId)]);
      if (rows.rows.length === 0) return "zero";
      return "unsafe";
    }, budget);
  } catch { return "unsafe"; }
}

export async function publishCopy(deps: Dependencies, input: CopyInput): Promise<CopyPublicationResult> {
  capabilities(deps.blobs);
  const blobs = deps.blobs;
  let reserved: ReservedNode[] = [];
  const stagedKeys: string[] = [];
  try {
    deadline(input);
    if (input.plan.totalBytes > await blobs.availableBytes()) throw new GfsError("payload_too_large", "insufficient destination capacity for copy");
    deadline(input);
    reserved = reserve(input.plan, input, deps);
    for (const node of reserved.filter(item => item.kind === "file")) {
      deadline(input);
      const sourceId = dbId(node.source.resourceId);
      let digest = node.source.contentSha256;
      if (node.source.blobKey === null) digest = await hashLegacy(await blobs.read(sourceId, null), input, node.source.bytes);
      if (!digest) throw new GfsError("precondition_failed", "copy source has no committed digest");
      const generationStream = node.source.blobKey === null ? null : await blobs.read(sourceId, node.source.blobKey);
      let staged: { blobKey: string; bytes: number; contentSha256: string };
      try {
        staged = await stageCopiedBlob(deps.manifests, deps.blobs, {
          requestId: input.requestId, destinationResourceId: node.resourceId, generation: node.generation!,
          source: generationStream === null
            ? { kind: "legacy_flat", reopen: () => blobs.read(sourceId, null) }
            : { kind: "generation", stream: generationStream },
          expectedBytes: Number(node.source.bytes), expectedSha256: digest,
          deadlineAtMs: input.deadlineAtMs, signal: input.signal, now: input.now,
        });
      } catch (error) {
        generationStream?.destroy();
        throw error;
      }
      node.blobKey = staged.blobKey;
      node.contentSha256 = staged.contentSha256;
      stagedKeys.push(staged.blobKey);
    }
    const root = reserved[0];
    await deps.tx.transaction(async client => {
      await revalidate(client, input);
      deadline(input);
      const insert = insertSql(reserved);
      try {
        await client.query(insert.sql, insert.values);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new GfsError("already_exists", `a resource named '${input.plan.rootName}' already exists here`);
        }
        throw error;
      }
      await deps.manifests.markCommittedMany(client, input.requestId, stagedKeys);
      await input.audit.record(auditEvent(input, root.resourceId, "succeeded"), client);
      deadline(input);
    }, { deadlineAtMs: input.deadlineAtMs, signal: input.signal, now: input.now });
    await deps.manifests.removeCommittedMany(input.requestId, stagedKeys, {
      deadlineAtMs: input.deadlineAtMs, signal: input.signal, now: input.now,
    }).catch(() => undefined);
    return result(input, root);
  } catch (error) {
    if ((error as Error).name === "CommitOutcomeUnknownError") {
      // COMMIT uncertainty is resolved with a fresh, short budget. The request
      // signal/deadline commonly caused the original uncertainty and therefore
      // cannot safely gate the independent read-back.
      const recoveryBudget = ambiguousCommitBudget();
      const outcome = await inspectAmbiguous(deps, input, reserved, recoveryBudget);
      if (outcome === "full") {
        await deps.manifests.removeCommittedMany(input.requestId, stagedKeys, ambiguousCommitBudget()).catch(() => undefined);
        return result(input, reserved[0]);
      }
      if (outcome === "zero") {
        await cleanup(deps, ambiguousCommitBudget(), stagedKeys);
        await auditFailure(input, error);
      }
      throw error as CommitOutcomeUnknownError;
    }
    await cleanup(deps, inputBudget(input), stagedKeys);
    await auditFailure(input, error);
    throw error;
  }
}

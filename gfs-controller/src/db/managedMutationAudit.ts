import type { AuditSink, Queryable } from "../authz/audit";
import type { GfsResource } from "../api/read";
import { normalizeResourceId } from "../storage/paths";
import type { Transactor } from "./writeStore";

export interface ManagedMutationContext {
  subject: string;
  requestId: string;
  audit: AuditSink;
  actorOnBehalfOf?: string | null;
  desktopUserId?: string;
  authoritySource?: "user-session" | "linked-admin";
}

export async function recordManagedMutation(
  context: ManagedMutationContext | undefined,
  input: { op: "create" | "replace"; resourceId: string; drive: string },
  outcome: "succeeded" | "failed",
  reason?: string,
  queryable?: Queryable
): Promise<void> {
  if (!context) return;
  await context.audit.record({
    recordType: "mutation_outcome", subject: context.subject, op: input.op,
    actorOnBehalfOf: context.actorOnBehalfOf ?? null,
    desktopUserId: context.desktopUserId,
    authoritySource: context.authoritySource,
    resourceId: normalizeResourceId(input.resourceId), drive: input.drive,
    outcome: outcome === "succeeded" ? "allow" : "error", reason,
    requestId: context.requestId, matchedSubject: null, authorizationSource: null,
    cachedAuthorizationSource: null, mutationOutcome: outcome,
  }, queryable);
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function matchesPrevious(row: Record<string, unknown>, previous: GfsResource): boolean {
  return String(row.resource_id) === previous.resourceId
    && String(row.drive) === previous.drive
    && nullable(row.parent_resource_id) === previous.parentResourceId
    && String(row.name) === previous.name
    && String(row.kind) === previous.kind
    && nullable(row.path_cache) === previous.pathCache
    && Number(row.version) === previous.version
    && Number(row.bytes) === previous.bytes
    && nullable(row.blob_key) === previous.blobKey
    && nullable(row.content_sha256) === previous.contentSha256
    && row.deleted_at == null;
}

export async function inspectCreateOutcome(
  tx: Transactor,
  drive: string,
  resourceId: string,
  expected?: GfsResource
): Promise<"full" | "zero" | "unsafe"> {
  try {
    return await tx.transaction(async client => {
      const result = await client.query(
        `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, version,
                bytes, blob_key, content_sha256, deleted_at
           FROM gfs_resources WHERE drive = $1 AND resource_id = $2`,
        [drive, resourceId]
      );
      if (result.rows.length === 0) return "zero";
      return expected && matchesPrevious(result.rows[0], expected) ? "full" : "unsafe";
    });
  } catch { return "unsafe"; }
}

export async function inspectReplaceRollback(
  tx: Transactor,
  previous: GfsResource
): Promise<"old" | "unsafe"> {
  try {
    return await tx.transaction(async client => {
      const result = await client.query(
        `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, version,
                bytes, blob_key, content_sha256, deleted_at
           FROM gfs_resources WHERE drive = $1 AND resource_id = $2`,
        [previous.drive, previous.resourceId]
      );
      return result.rows.length === 1 && matchesPrevious(result.rows[0], previous) ? "old" : "unsafe";
    });
  } catch { return "unsafe"; }
}

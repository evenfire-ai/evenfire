import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuditSink } from "../authz/audit";
import { auditAttribution, type AuthzContext, type AuthzQueryBudget, type PermissionEpoch } from "../authz/permissionClient";
import type { GfsPermission } from "../authz/resolve";
import { checkTokenCeiling } from "../authz/tokenCeiling";
import type { DeadlineBudget } from "../db/deadlineQuery";
import type { CopyQueryBudget, PgResourceStore } from "../db/resourceStore";
import type { GfsWriteService } from "../db/writeStore";
import { normalizeResourceId, PathError } from "../storage/paths";
import { preflightCopy } from "./copy";
import { GfsError } from "./errors";
import { normalizeResourceName, ResourceNameError } from "./resourceName";

export interface CopyRouteDeps {
  authorizeMany: (ctx: AuthzContext, requests: ReadonlyArray<{ resourceId: string; op: GfsPermission }>, budget?: AuthzQueryBudget) => Promise<Array<{ allowed: boolean }>>;
  /** Snapshot the live permission-invalidation epoch (revocation generation + LISTEN health). */
  permissionEpoch: () => PermissionEpoch;
  resources: Pick<PgResourceStore, "loadCopyAdmission" | "loadCopySnapshot" | "loadCopyDestination">;
  writes: Pick<GfsWriteService, "copy">;
  audit: AuditSink;
  maxObjects: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface CopyRouteInput {
  body: Record<string, unknown>;
  claims: GfsVerifiedClaims;
  context: AuthzContext;
  requestId: string;
  admittedAtMs: number;
  signal: AbortSignal;
  now: () => number;
  deps: CopyRouteDeps;
}

const POST_FAILURE_AUDIT_MS = 2_000;

function postFailureAuditBudget(): DeadlineBudget {
  return { deadlineAtMs: Date.now() + POST_FAILURE_AUDIT_MS };
}

function rid(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new GfsError("path_invalid", `'${key}' must be a resource id`);
  try { return normalizeResourceId(value); }
  catch (error) {
    if (error instanceof PathError) throw new GfsError("path_invalid", error.message);
    throw error;
  }
}

function optionalName(body: Record<string, unknown>): string | undefined {
  const value = body.newName;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new GfsError("path_invalid", "'newName' must be a string");
  try { return normalizeResourceName(value); }
  catch (error) {
    if (error instanceof ResourceNameError) throw new GfsError("path_invalid", error.message);
    throw error;
  }
}

function ifMatch(body: Record<string, unknown>): number | undefined {
  const value = body.ifMatch;
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new GfsError("path_invalid", "'ifMatch' must be a non-negative safe integer");
  return Number(value);
}

function ceilingAllowed(claims: GfsVerifiedClaims, op: GfsPermission, path: string | null): boolean {
  return checkTokenCeiling({ scopes: claims.scopes, pathBindings: claims.pathBindings, op, resourcePath: path }).allowed;
}

function checkDeadline(input: CopyRouteInput, deadlineAtMs: number, now: () => number): number {
  input.signal.throwIfAborted();
  const elapsedMs = now();
  if (elapsedMs >= deadlineAtMs) throw new GfsError("precondition_failed", "synchronous copy deadline exceeded");
  return elapsedMs;
}

async function failedAudit(input: CopyRouteInput, sourceResourceId: string, error: unknown): Promise<void> {
  await input.deps.audit.record({
    recordType: "mutation_outcome", subject: input.context.primarySubject, op: "copy",
    ...auditAttribution(input.context),
    resourceId: sourceResourceId, drive: input.claims.drive, outcome: "error",
    reason: error instanceof GfsError ? error.code : "internal_error", requestId: input.requestId,
    matchedSubject: null, authorizationSource: null, cachedAuthorizationSource: null,
    mutationOutcome: "failed",
  }, undefined, postFailureAuditBudget());
}

export async function executeCopyRoute(input: CopyRouteInput): Promise<Record<string, unknown>> {
  const requestedDrive = input.body.drive;
  if (typeof requestedDrive !== "string" || requestedDrive.length === 0) {
    throw new GfsError("path_invalid", "'drive' must be a non-empty string");
  }
  if (requestedDrive !== input.claims.drive) {
    throw new GfsError("cross_boundary", "copy drive does not match the authorized drive");
  }
  const sourceResourceId = rid(input.body, "sourceResourceId");
  const destinationParentId = rid(input.body, "destinationParentId");
  const newName = optionalName(input.body);
  const version = ifMatch(input.body);
  let publicationCalled = false;
  let authorized = false;
  try {
    const relativeNow = () => Math.max(0, input.now() - input.admittedAtMs);
    const deadlineAtMs = input.deps.timeoutMs;
    const budget: CopyQueryBudget = { deadlineAtMs, signal: input.signal, now: relativeNow };
    checkDeadline(input, deadlineAtMs, relativeNow);
    const admission = await input.deps.resources.loadCopyAdmission(
      input.claims.drive, sourceResourceId, destinationParentId, budget
    );
    checkDeadline(input, deadlineAtMs, relativeNow);
    const cheapRequests: Array<{ resourceId: string; op: GfsPermission }> = [
      { resourceId: sourceResourceId, op: "read" },
      { resourceId: destinationParentId, op: "write" },
    ];
    const cheapCeiling = ceilingAllowed(input.claims, "read", admission.sourceRoot?.pathCache ?? null)
      && ceilingAllowed(input.claims, "write", admission.destinationParent?.pathCache ?? null);
    const cheapDecisions = await input.deps.authorizeMany(input.context, cheapRequests, budget);
    checkDeadline(input, deadlineAtMs, relativeNow);
    if (!cheapCeiling || cheapDecisions.length !== cheapRequests.length || cheapDecisions.some(decision => !decision.allowed)) {
      throw new GfsError("forbidden", "copy is not authorized");
    }

    const snapshot = await input.deps.resources.loadCopySnapshot(
      input.claims.drive, sourceResourceId, BigInt(input.deps.maxObjects) + 1n, budget
    );
    checkDeadline(input, deadlineAtMs, relativeNow);
    const observedRoot = snapshot.find(node => normalizeResourceId(node.resourceId) === sourceResourceId && node.depth === 0);
    const collisionName = newName ?? admission.sourceRoot?.name ?? observedRoot?.name ?? "";
    const destination = await input.deps.resources.loadCopyDestination(
      input.claims.drive, destinationParentId, collisionName, budget
    );
    checkDeadline(input, deadlineAtMs, relativeNow);
    const sourcePaths = new Map(snapshot.map(node => [normalizeResourceId(node.resourceId), node.pathCache]));
    const destinationPath = destination.ancestors.find(node =>
      normalizeResourceId(node.resourceId) === destinationParentId && node.depth === 0
    )?.pathCache ?? null;
    const requests: Array<{ resourceId: string; op: GfsPermission }> = snapshot.map(node => ({
      resourceId: normalizeResourceId(node.resourceId), op: "read",
    }));
    if (!sourcePaths.has(sourceResourceId)) requests.push({ resourceId: sourceResourceId, op: "read" });
    requests.push({ resourceId: destinationParentId, op: "write" });

    const ceiling = requests.every(request => ceilingAllowed(
      input.claims,
      request.op,
      request.op === "write" ? destinationPath : sourcePaths.get(request.resourceId) ?? null
    ));
    // Capture the invalidation epoch immediately BEFORE the snapshot is
    // authorized. The writer transaction re-reads it under the advisory lock so a
    // grant revoked between here and the INSERT is caught (TOCTOU close).
    const authzEpochCaptured = input.deps.permissionEpoch();
    const decisions = await input.deps.authorizeMany(input.context, requests, budget);
    if (!ceiling || decisions.length !== requests.length || decisions.some(decision => !decision.allowed)) {
      throw new GfsError("forbidden", "copy is not authorized");
    }
    authorized = true;

    const nowMs = checkDeadline(input, deadlineAtMs, relativeNow);
    const plan = preflightCopy({
      drive: input.claims.drive, sourceResourceId, destinationParentId, newName, ifMatch: version,
      snapshot, destination, maxObjects: input.deps.maxObjects, maxBytes: input.deps.maxBytes,
      deadlineAtMs, nowMs,
    });
    publicationCalled = true;
    const published = await input.deps.writes.copy({
      requestId: input.requestId, subject: input.context.primarySubject, audit: input.deps.audit,
      ...auditAttribution(input.context),
      drive: input.claims.drive, destinationParentId, plan, destination, deadlineAtMs,
      signal: input.signal, now: relativeNow,
      authzEpoch: { captured: authzEpochCaptured, current: input.deps.permissionEpoch },
    });
    const rootRid = normalizeResourceId(published.root.resourceId);
    return {
      requestId: published.requestId,
      resourceId: published.root.resourceId, rid: rootRid,
      gfsUri: `gfs://${published.root.drive}/${rootRid}`,
      name: published.root.name, kind: published.root.kind, version: published.root.version,
      objects: published.objectCount, files: published.fileCount,
      folders: published.folderCount, bytes: Number(published.totalBytes),
    };
  } catch (error) {
    if (authorized && !publicationCalled) {
      // The audit write is best-effort here; its own failure must never
      // replace the original copy error surfaced to the caller.
      try { await failedAudit(input, sourceResourceId, error); }
      catch (auditError) {
        console.error(`[gfsc] copy post-failure audit write failed: ${
          auditError instanceof Error ? auditError.message : String(auditError)}`);
      }
    }
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      throw new GfsError("payload_too_large", "copy cannot fit in the available destination capacity");
    }
    throw error;
  }
}

import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuditSink } from "../authz/audit";
import type { AuthzContext } from "../authz/permissionClient";
import type { GfsWriteService } from "../db/writeStore";
import { GfsError } from "./errors";
import { toView } from "./read";
import { normalizeResourceName, ResourceNameError } from "./resourceName";

export interface RenameRouteInput {
  body: Record<string, unknown>;
  claims: GfsVerifiedClaims;
  context: AuthzContext;
  resourceId: string;
  requestId: string;
  audit: AuditSink;
  authorizeWrite: () => Promise<void>;
  writes: Pick<GfsWriteService, "rename">;
  limits: { maxObjects: number; timeoutMs: number };
}

export async function executeRenameRoute(input: RenameRouteInput): Promise<ReturnType<typeof toView>> {
  if (Object.keys(input.body).sort().join(",") !== "drive,ifMatch,newName") {
    throw new GfsError("path_invalid", "rename body must contain exactly drive, newName and ifMatch");
  }
  const drive = input.body.drive;
  if (typeof drive !== "string" || drive.length === 0) throw new GfsError("path_invalid", "rename drive must be a non-empty string");
  if (drive !== input.claims.drive) throw new GfsError("cross_boundary", "rename drive does not match the authorized drive");
  const rawName = input.body.newName;
  if (typeof rawName !== "string") throw new GfsError("path_invalid", "rename newName must be a string");
  let newName: string;
  try { newName = normalizeResourceName(rawName); }
  catch (error) {
    if (error instanceof ResourceNameError) throw new GfsError("path_invalid", error.message);
    throw error;
  }
  const ifMatch = input.body.ifMatch;
  if (!Number.isSafeInteger(ifMatch) || Number(ifMatch) < 0) {
    throw new GfsError("path_invalid", "rename ifMatch must be a non-negative safe integer");
  }
  try { await input.authorizeWrite(); }
  catch (error) {
    if (error instanceof GfsError && error.code === "forbidden") {
      throw new GfsError("forbidden", "rename is not authorized");
    }
    throw error;
  }
  const updated = await input.writes.rename({
    requestId: input.requestId, subject: input.context.primarySubject, audit: input.audit,
    drive, resourceId: input.resourceId, newName, ifMatch: Number(ifMatch),
    maxObjects: input.limits.maxObjects, deadlineAtMs: Date.now() + input.limits.timeoutMs,
  });
  return toView(updated);
}

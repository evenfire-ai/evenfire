import { GfsPathBinding, GfsScope } from "../auth/verify";
import { GfsPermission } from "./resolve";

/**
 * Token ceiling check (spec community.md §522, normative authorization rule).
 *
 * A verified gfs token is an UPPER BOUND on authority, never a grant. Before gfsc
 * consults the permission store (the source of truth, re-checked on every op), it
 * enforces what the TOKEN itself authorizes:
 *
 *   (a) the op's bit is in `scopes`        — the capability ceiling, AND
 *   (b) some `pathBindings` entry whose `path` is the resource or an ancestor
 *       carries the matching permission     — the path-scoped binding.
 *
 * "Neither alone authorizes." This is a PURE function (no I/O): it only narrows
 * what the store is then asked to confirm. A pass here is necessary, never
 * sufficient — `PermissionClient.authorize()` still decides, and still fails
 * closed if the store is unreachable.
 *
 * Two encodings meet here and must NOT be conflated (verified against
 * control-api/src/auth/gfsToken.ts + spec §511):
 *   - `scopes`              use the `gfs.*` form (`gfs.read`, `gfs.write`, …).
 *   - `pathBindings[].permissions` use the BARE op form (`read`, `write`, …).
 * So (a) maps `op → gfs.<op>` while (b) compares `op` verbatim.
 */

/** op (bare) → scope (gfs.* form). The (a) clause is checked against `scopes`. */
const PERMISSION_TO_SCOPE: Record<GfsPermission, GfsScope> = {
  read: "gfs.read",
  write: "gfs.write",
  delete: "gfs.delete",
  manage_acl: "gfs.manage_acl",
  share: "gfs.share",
};

export type CeilingReason =
  | "ok"
  | "scope_not_in_token"
  | "no_path_binding_covers"
  | "resource_path_unknown";

export interface CeilingResult {
  allowed: boolean;
  reason: CeilingReason;
}

export interface CeilingInput {
  scopes: GfsScope[];
  pathBindings: GfsPathBinding[];
  op: GfsPermission;
  /**
   * The resource's absolute logical path (`gfs_resources.path_cache`); null when
   * not yet computed. Only consulted when `pathBindings` is non-empty.
   */
  resourcePath: string | null;
}

/** Trim a single trailing slash so "/a/" and "/a" compare equal (root "/" kept). */
function canonicalize(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "");
  return path;
}

/**
 * True iff `bindingPath` is `resourcePath` itself or a directory ancestor of it,
 * compared on SEGMENT boundaries so `/doc` does NOT cover `/docs/x`. Root ("/")
 * covers everything.
 */
function pathCovers(bindingPath: string, resourcePath: string): boolean {
  const binding = canonicalize(bindingPath);
  const resource = canonicalize(resourcePath);
  if (binding === resource) return true;
  if (binding === "/") return true;
  return resource.startsWith(`${binding}/`);
}

/**
 * Apply the token ceiling. Returns a structured result (no throw) so the serving
 * handler maps a `false` to `403 forbidden` with the reason, mirroring the pure
 * `resolveDecision` style. DENY BY DEFAULT — any path that does not explicitly
 * return `allowed: true` denies.
 */
export function checkTokenCeiling(input: CeilingInput): CeilingResult {
  // (a) Capability ceiling: the op's scope bit must be present in the token.
  const requiredScope = PERMISSION_TO_SCOPE[input.op];
  if (!input.scopes.includes(requiredScope)) {
    return { allowed: false, reason: "scope_not_in_token" };
  }

  // (b) Path-scoped binding. An EMPTY pathBindings array means the token
  // declares NO path narrowing — the scopes are the ceiling and the store
  // governs. (control-api mints `pathBindings: []` for human/operator tokens in
  // P1 by design — path-scoping is deferred — so empty MUST pass through, else
  // every P1 token would be denied here. Safe because the caller cannot forge
  // pathBindings and the store is always re-checked.)
  if (input.pathBindings.length === 0) {
    return { allowed: true, reason: "ok" };
  }

  // A narrowing token was issued but the resource's path is unknown — we cannot
  // prove a binding covers it, so fail closed.
  if (input.resourcePath === null) {
    return { allowed: false, reason: "resource_path_unknown" };
  }

  for (const binding of input.pathBindings) {
    if (binding.permissions.includes(input.op) && pathCovers(binding.path, input.resourcePath)) {
      return { allowed: true, reason: "ok" };
    }
  }
  return { allowed: false, reason: "no_path_binding_covers" };
}

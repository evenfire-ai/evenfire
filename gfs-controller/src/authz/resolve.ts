/**
 * Pure authorization decision logic — deny-by-default, spec-faithful.
 *
 * Three ways to be allowed (spec §RBAC model / §Inheritance):
 *   1. INTRINSIC operator authority. The cluster operator (control_admin) is the
 *      root of trust — "grant any permission" — so an operator is allowed
 *      without any stored grant. (This is the only non-grant allow.)
 *   2. A folder grant carrying the op bit whose subject ∈ the caller's subject
 *      set, where the grant is ON the resource itself OR on an ancestor AND the
 *      grant's `inherit` flag is true. Per §Inheritance: "No inherit-down unless
 *      inherit: true on the grant."
 *   3. A URI share carrying the op bit whose subject ∈ the caller's subject set,
 *      ON the resource itself OR on an ancestor with `includeDescendants`.
 * Absence of all three → deny.
 *
 * Subjects are compared as canonical `type:id` keys (e.g. `operator:`,
 * `user:<uuid>`, `team:<uuid>`, `host:<binding>`). This module performs NO I/O.
 */
export type GfsPermission = "read" | "write" | "delete" | "manage_acl" | "share";

export interface GrantRow {
  /** Canonical subject key `type:id` (operator → `operator:`). */
  subjectKey: string;
  resourceId: string;
  permissions: string[];
  /** §Inheritance: when false, the grant applies ONLY to its own resource. */
  inherit: boolean;
}

export interface ShareRow {
  subjectKey: string;
  resourceId: string;
  permissions: string[];
  includeDescendants: boolean;
}

export interface DecisionInput {
  /** The resource under check (R), same id form as the rows. */
  resourceId: string;
  /** R plus all ancestors (R included). */
  ancestors: string[];
  /** Canonical subject keys the principal resolves to (self + groups). */
  subjects: Set<string>;
  /** True iff the principal is a cluster operator (intrinsic full authority). */
  isOperator: boolean;
  op: GfsPermission;
  grants: GrantRow[];
  shares: ShareRow[];
}

export interface Decision {
  allowed: boolean;
  /**
   * Why the decision was reached. `resolveDecision` only ever emits
   * `operator` / `grant` / `share` / `null`; `cache` is set EXCLUSIVELY by the
   * caching layer in `PermissionClient` when a decision is served from the
   * short-TTL decision cache (so the audit row records the cache hit honestly).
   */
  via: "operator" | "grant" | "share" | "cache" | null;
}

export function resolveDecision(input: DecisionInput): Decision {
  // 1. Intrinsic operator authority — the root of trust, no grant required.
  if (input.isOperator) {
    return { allowed: true, via: "operator" };
  }

  const ancestorSet = new Set(input.ancestors);

  // 2. Folder grant: on R itself (always), or on an ancestor ONLY if inherit.
  for (const grant of input.grants) {
    if (!input.subjects.has(grant.subjectKey) || !grant.permissions.includes(input.op)) continue;
    if (grant.resourceId === input.resourceId) {
      return { allowed: true, via: "grant" };
    }
    if (grant.inherit && ancestorSet.has(grant.resourceId)) {
      return { allowed: true, via: "grant" };
    }
  }

  // 3. URI share: on R itself, or on an ancestor with includeDescendants.
  for (const share of input.shares) {
    if (!input.subjects.has(share.subjectKey) || !share.permissions.includes(input.op)) continue;
    if (share.resourceId === input.resourceId) {
      return { allowed: true, via: "share" };
    }
    if (share.includeDescendants && ancestorSet.has(share.resourceId)) {
      return { allowed: true, via: "share" };
    }
  }

  return { allowed: false, via: null };
}

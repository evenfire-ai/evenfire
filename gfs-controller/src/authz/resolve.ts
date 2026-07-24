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
  /** Canonical subject key that matched the effective grant/share. */
  matchedSubject: string | null;
  /**
   * Effective authority behind the decision. Cache hits retain this underlying
   * source while `via` reports that the result was served from cache.
   */
  authorizationSource:
    | "operator"
    | "direct_grant"
    | "inherited_grant"
    | "direct_share"
    | "inherited_share"
    | null;
}

export function resolveDecision(input: DecisionInput): Decision {
  // 1. Intrinsic operator authority — the root of trust, no grant required.
  if (input.isOperator) {
    return {
      allowed: true,
      via: "operator",
      matchedSubject: input.subjects.has("operator:") ? "operator:" : null,
      authorizationSource: "operator",
    };
  }

  const ancestorSet = new Set(input.ancestors);
  const matchingGrants = input.grants
    .filter((grant) => input.subjects.has(grant.subjectKey) && grant.permissions.includes(input.op))
    .sort((a, b) => a.subjectKey.localeCompare(b.subjectKey) || a.resourceId.localeCompare(b.resourceId));

  // 2. Folder grant: on R itself (always), or on an ancestor ONLY if inherit.
  const directGrant = matchingGrants.find((grant) => grant.resourceId === input.resourceId);
  if (directGrant) {
    return {
      allowed: true,
      via: "grant",
      matchedSubject: directGrant.subjectKey,
      authorizationSource: "direct_grant",
    };
  }
  for (const grant of matchingGrants) {
    if (grant.inherit && ancestorSet.has(grant.resourceId)) {
      return {
        allowed: true,
        via: "grant",
        matchedSubject: grant.subjectKey,
        authorizationSource: "inherited_grant",
      };
    }
  }

  // 3. URI share: on R itself, or on an ancestor with includeDescendants.
  const matchingShares = input.shares
    .filter((share) => input.subjects.has(share.subjectKey) && share.permissions.includes(input.op))
    .sort((a, b) => a.subjectKey.localeCompare(b.subjectKey) || a.resourceId.localeCompare(b.resourceId));
  const directShare = matchingShares.find((share) => share.resourceId === input.resourceId);
  if (directShare) {
    return {
      allowed: true,
      via: "share",
      matchedSubject: directShare.subjectKey,
      authorizationSource: "direct_share",
    };
  }
  for (const share of matchingShares) {
    if (share.includeDescendants && ancestorSet.has(share.resourceId)) {
      return {
        allowed: true,
        via: "share",
        matchedSubject: share.subjectKey,
        authorizationSource: "inherited_share",
      };
    }
  }

  return { allowed: false, via: null, matchedSubject: null, authorizationSource: null };
}

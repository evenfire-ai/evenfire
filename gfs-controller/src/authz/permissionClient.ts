import { GfsError } from "../api/errors";
import type {
  AuditSink,
  AuthorizationEvidence,
  Queryable,
} from "./audit";
import { DecisionCache, type PermissionEpoch } from "./cache";
import { withDeadlineTransaction, type DeadlineBudget, type DeadlinePool } from "../db/deadlineQuery";
import {
  Decision,
  DENIED,
  GfsPermission,
  GrantRow,
  resolveDecision,
  ShareRow,
} from "./resolve";

export { DbAuditSink } from "./audit";
export type {
  AuditEvent,
  AuditSink,
  AuthorizationEvidence,
  PersistedAuthorizationSource,
  Queryable,
} from "./audit";
export type { PermissionEpoch } from "./cache";

export interface AuthzContext {
  drive: string;
  /** Canonical subject keys (`type:id`) the principal resolves to (self + groups). */
  subjects: string[];
  /** True iff the principal is a cluster operator (intrinsic full authority). */
  isOperator: boolean;
  /** The token's `sub`, recorded verbatim in the audit row. */
  primarySubject: string;
  requestId?: string;
  /** Desktop actor for a user-session or linked-admin broker request. */
  desktopUserId?: string;
  /** Effective linked Control Admin. Absent for ordinary users/direct admins. */
  effectiveControlAdminId?: string;
  /** Broker authority provenance; separate from permission-store evidence. */
  authoritySource?: "user-session" | "linked-admin";
}

export function auditAttribution(ctx: AuthzContext): {
  actorOnBehalfOf: string | null;
  desktopUserId?: string;
  authoritySource?: "user-session" | "linked-admin";
} {
  return {
    actorOnBehalfOf: ctx.authoritySource === "linked-admin"
      ? (ctx.effectiveControlAdminId ?? null)
      : null,
    desktopUserId: ctx.desktopUserId,
    authoritySource: ctx.authoritySource,
  };
}

export interface AuthorizationRequest {
  resourceId: string;
  op: GfsPermission;
}

export type AuthzQueryBudget = DeadlineBudget;

/** A refused in-transaction decision, reported for durable audit after its transaction rolled back. */
export type RefusedWithin =
  | { denied: readonly AuthorizationRequest[] }
  | { failed: readonly AuthorizationRequest[]; error: unknown };

type PermissionDb = Queryable & DeadlinePool;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stable cache key for a resolved subject SET — sorted so member order never
 * produces two keys for the same set. The cache is keyed on the resolved
 * subjects (not the raw `sub`) so a grant to `team:X` is correctly shared by
 * every member resolving to `team:X`.
 */
function subjectsKeyOf(subjects: string[]): string {
  return [...subjects].sort().join(",");
}

/**
 * Intrinsic operator authority: every request is allowed with no store read.
 * Still audited by the caller. Not cached: it is already O(1) from
 * ctx.isOperator with no store round-trip to save.
 */
function operatorDecisions(ctx: AuthzContext, requests: readonly AuthorizationRequest[]): Decision[] {
  return requests.map((): Decision => ({
    allowed: true,
    via: "operator",
    matchedSubject: ctx.subjects.includes("operator:") ? "operator:" : null,
    authorizationSource: "operator",
  }));
}

/** PostgreSQL renders uuid values with hyphens while the HTTP surface uses RID. */
function resourceLookupKey(resourceId: string): string {
  return resourceId.replaceAll("-", "").toLowerCase();
}

/**
 * Permission-store authorization client (read path).
 *
 * FAIL CLOSED: in `authorize` / `authorizeMany` a store error throws
 * GfsError('not_mounted', 503), or `precondition_failed` for a budgeted
 * deadline or abort, and is audited as an error — gfsc NEVER falls back to the
 * token's pathBindings (the store is the source of truth). `authorizeWithin`
 * propagates a store error unchanged. DENY BY DEFAULT: the absence of a matching
 * grant or share denies. The cluster operator is the root of trust and is
 * allowed intrinsically (no stored grant). Every decision — allow, deny, or
 * error — emits an audit row; an audit-write failure propagates (no un-audited
 * op is served). `authorizeWithin` emits its rows in the caller's transaction;
 * they persist only if it commits. A refused in-transaction decision (a deny or
 * a store error) is recorded durably by `auditRefusedWithin` after the rollback.
 */
export class PermissionClient {
  constructor(
    private readonly db: PermissionDb,
    private readonly audit: AuditSink,
    private readonly cache?: DecisionCache
  ) {}

  async authorize(
    ctx: AuthzContext,
    resourceId: string,
    op: GfsPermission
  ): Promise<Decision> {
    const [decision] = await this.authorizeMany(ctx, [{ resourceId, op }]);
    return decision;
  }

  /**
   * Snapshot the invalidation state so a mutation can tell, inside its writer
   * transaction, whether a revocation NOTIFY landed after it authorized. A client
   * with no decision cache cannot hear invalidations at all, so it reports
   * `bypassed: true`. Rather than publishing against an authorization it cannot
   * re-confirm, copy then fails closed, and upload finalization re-decides on its
   * transaction client (`authorizeWithin`).
   */
  permissionEpoch(): PermissionEpoch {
    if (!this.cache) return { generation: 0, bypassed: true };
    return { generation: this.cache.generation, bypassed: this.cache.isBypassed };
  }

  /**
   * Resolve a whole operation snapshot with three permission-store reads,
   * independent of the number of resources: one ancestor forest, one grants
   * query and one shares query. Decisions are returned in request order and do
   * not expose resource paths or names.
   */
  async authorizeMany(
    ctx: AuthzContext,
    requests: readonly AuthorizationRequest[],
    budget?: AuthzQueryBudget
  ): Promise<Decision[]> {
    if (requests.length === 0) return [];

    // Intrinsic operator authority short-circuits the grant/share lookup, but
    // is still audited (and a failing audit still propagates below). Not cached —
    // it is already O(1) from ctx.isOperator with no store round-trip to save.
    if (ctx.isOperator) {
      const decisions = operatorDecisions(ctx, requests);
      await this.auditBatch(ctx, requests, decisions, budget);
      return decisions;
    }

    // Short-TTL decision cache (P2-S03). A HIT skips the store lookup but is
    // STILL audited — the cache short-cuts the SELECTs, never the audit row, so
    // "every op is audited" holds. `get` returns undefined on miss/expiry/bypass
    // (fail-closed: a reader that cannot hear invalidations serves nothing), so
    // a degraded cache simply means every op re-checks the store.
    const subjectKey = subjectsKeyOf(ctx.subjects);
    const decisions: Array<Decision | undefined> = new Array(requests.length);
    const misses: Array<{ index: number; request: AuthorizationRequest }> = [];
    requests.forEach((request, index) => {
      const cached = this.cache?.get({ subjectsKey: subjectKey, ...request });
      if (cached !== undefined) decisions[index] = { ...cached, via: "cache" };
      else misses.push({ index, request });
    });

    try {
      if (misses.length > 0) {
        const missRequests = misses.map(({ request }) => request);
        const decide = (db: Queryable) => this.decideFromStore(db, ctx, missRequests);
        const missDecisions = budget
          ? await withDeadlineTransaction(this.db, budget, true, decide)
          : await decide(this.db);
        misses.forEach(({ index, request }, missIndex) => {
          const decision = missDecisions[missIndex];
          decisions[index] = decision;
          this.cache?.set({ subjectsKey: subjectKey, ...request }, decision);
        });
      }
    } catch (err) {
      // Fail closed. Try to audit the error, but the store failure is what we
      // surface — never a pathBindings fallback, never a silent allow.
      await this.auditStoreError(ctx, requests, err, budget);
      if ((err instanceof GfsError && err.code === "precondition_failed")
        || (budget && ((err as { code?: string }).code === "57014"
          || budget.signal?.aborted
          || (budget.now ?? Date.now)() >= budget.deadlineAtMs))) {
        throw new GfsError("precondition_failed", "synchronous copy deadline exceeded");
      }
      throw new GfsError("not_mounted", `permission store unavailable: ${errMsg(err)}`);
    }

    const complete = decisions as Decision[];
    budget?.signal?.throwIfAborted();
    await this.auditBatch(ctx, requests, complete, budget);
    return complete;
  }

  /**
   * Re-decide `requests` for `ctx` from the permission store on `db`, a writer
   * transaction's client. It reads ancestors, grants and shares on `db`, never on
   * the client's own pool, and neither reads nor fills the decision cache: `db`
   * may see the transaction's own uncommitted rows, so its decisions must not
   * outlive it. Each decision is audited on `db`, so its row commits or rolls back
   * with the publication it authorized. A store error propagates unchanged; the
   * transactor maps deadlines.
   */
  async authorizeWithin(
    db: Queryable,
    ctx: AuthzContext,
    requests: readonly AuthorizationRequest[]
  ): Promise<Decision[]> {
    if (requests.length === 0) {
      throw new GfsError("internal", "authorizeWithin requires at least one request");
    }
    const decisions = ctx.isOperator
      ? operatorDecisions(ctx, requests)
      : await this.decideFromStore(db, ctx, requests);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      await this.auditDecision(ctx, request.resourceId, request.op, decisions[index], db);
    }
    return decisions;
  }

  /**
   * Record durably a decision `authorizeWithin` refused inside a transaction that
   * then rolled back, taking its in-transaction row with it. Call it after the
   * transaction has ended, with no client held: it appends on the pool the rows
   * `authorizeMany` would have written — one deny row per denied request, or one
   * error row per request whose decision failed. A failed deny insert propagates;
   * a failed error insert is logged, as in `authorizeMany`.
   */
  async auditRefusedWithin(ctx: AuthzContext, refusal: RefusedWithin): Promise<void> {
    if ("error" in refusal) {
      await this.auditStoreError(ctx, refusal.failed, refusal.error);
      return;
    }
    for (const request of refusal.denied) {
      await this.auditDecision(ctx, request.resourceId, request.op, DENIED);
    }
  }

  /** Audit a store failure as one error row per request; an audit failure is logged. */
  private async auditStoreError(
    ctx: AuthzContext,
    requests: readonly AuthorizationRequest[],
    err: unknown,
    budget?: AuthzQueryBudget
  ): Promise<void> {
    try {
      const append = async (queryable?: Queryable) => {
        for (const request of requests) await this.audit.record({
          subject: ctx.primarySubject,
          ...auditAttribution(ctx),
          op: request.op,
          resourceId: request.resourceId,
          drive: ctx.drive,
          outcome: "error",
          reason: errMsg(err),
          requestId: ctx.requestId,
          recordType: "authorization_decision",
          matchedSubject: null,
          authorizationSource: null,
          cachedAuthorizationSource: null,
          mutationOutcome: null,
        }, queryable);
      };
      if (budget) await withDeadlineTransaction(this.db, budget, false, append);
      else await append();
    } catch (auditErr) {
      console.error(
        `[gfsc] failed to audit a store-error denial (subject=${ctx.primarySubject}, ` +
          `request=${ctx.requestId ?? "unknown"}): ${errMsg(auditErr)}`
      );
    }
  }

  /** Decide `requests` from the permission store read on `db`, in request order. */
  private async decideFromStore(
    db: Queryable,
    ctx: AuthzContext,
    requests: readonly AuthorizationRequest[]
  ): Promise<Decision[]> {
    const ancestorMap = await this.ancestorsMany(db, ctx.drive, requests.map(request => request.resourceId));
    const allAncestors = [...new Set([...ancestorMap.values()].flat())];
    const grants = await this.grantsFor(db, ctx.drive, allAncestors, ctx.subjects);
    const shares = await this.sharesFor(db, ctx.drive, allAncestors, ctx.subjects);
    return requests.map(request => {
      const ancestors = ancestorMap.get(resourceLookupKey(request.resourceId)) ?? [];
      return ancestors.length === 0
        ? DENIED
        : resolveDecision({
            resourceId: ancestors[0],
            ancestors,
            subjects: new Set(ctx.subjects),
            isOperator: false,
            op: request.op,
            grants,
            shares,
          });
    });
  }

  private async auditBatch(
    ctx: AuthzContext,
    requests: readonly AuthorizationRequest[],
    decisions: readonly Decision[],
    budget?: AuthzQueryBudget
  ): Promise<void> {
    const append = async (queryable?: Queryable) => {
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        await this.auditDecision(ctx, request.resourceId, request.op, decisions[index], queryable);
      }
    };
    if (budget) await withDeadlineTransaction(this.db, budget, false, append);
    else await append();
  }

  /** Audit a decided outcome. Propagates so no un-audited op returns. */
  private async auditDecision(
    ctx: AuthzContext,
    resourceId: string,
    op: GfsPermission,
    decision: Decision,
    queryable?: Queryable
  ): Promise<void> {
    const evidence: AuthorizationEvidence =
      decision.via === "cache" &&
      decision.allowed &&
      decision.authorizationSource !== null
      ? {
          authorizationSource: "cache",
          cachedAuthorizationSource: decision.authorizationSource,
        }
      : {
          authorizationSource: decision.via === "cache" ? null : decision.authorizationSource,
          cachedAuthorizationSource: null,
        };
    await this.audit.record({
      subject: ctx.primarySubject,
      ...auditAttribution(ctx),
      op,
      resourceId,
      drive: ctx.drive,
      outcome: decision.allowed ? "allow" : "deny",
      reason: decision.via ?? undefined,
      requestId: ctx.requestId,
      recordType: "authorization_decision",
      matchedSubject: decision.via === "cache" && !decision.allowed
        ? null
        : decision.matchedSubject,
      ...evidence,
      mutationOutcome: null,
    }, queryable);
  }

  /** Ancestor chain (R first, root last) via a single recursive CTE — not N
   * round-trips. Tombstoned rows are excluded. */
  private async ancestorsMany(
    db: Queryable,
    drive: string,
    resourceIds: readonly string[]
  ): Promise<Map<string, string[]>> {
    const sql = `
      WITH RECURSIVE requested(resource_id) AS (
        SELECT DISTINCT unnest($2::uuid[])
      ), chain AS (
        SELECT requested.resource_id AS requested_resource_id,
               r.resource_id, r.parent_resource_id, 0 AS depth,
               ARRAY[r.resource_id] AS visited
          FROM requested
          JOIN gfs_resources r ON r.resource_id = requested.resource_id
         WHERE r.drive = $1 AND r.deleted_at IS NULL
        UNION ALL
        SELECT c.requested_resource_id,
               r.resource_id, r.parent_resource_id, c.depth + 1,
               c.visited || r.resource_id
          FROM chain c
          JOIN gfs_resources r ON r.resource_id = c.parent_resource_id
         WHERE r.drive = $1 AND r.deleted_at IS NULL
           AND NOT r.resource_id = ANY(c.visited)
      )
      SELECT requested_resource_id, resource_id
        FROM chain
       ORDER BY requested_resource_id, depth ASC`;
    const result = await db.query(sql, [drive, resourceIds]);
    const byResource = new Map<string, string[]>();
    for (const row of result.rows) {
      const requested = resourceLookupKey(String(row.requested_resource_id));
      const chain = byResource.get(requested) ?? [];
      chain.push(String(row.resource_id));
      byResource.set(requested, chain);
    }
    return byResource;
  }

  private async grantsFor(
    db: Queryable,
    drive: string,
    ancestors: string[],
    subjects: string[]
  ): Promise<GrantRow[]> {
    if (ancestors.length === 0) return [];
    const sql = `
      SELECT resource_id, subject_type, subject_id, permissions, inherit
        FROM gfs_grants
       WHERE drive = $1
         AND resource_id = ANY($2::uuid[])
         AND (subject_type || ':' || subject_id) = ANY($3::text[])`;
    const result = await db.query(sql, [drive, ancestors, subjects]);
    return result.rows.map((row) => ({
      subjectKey: `${String(row.subject_type)}:${String(row.subject_id ?? "")}`,
      resourceId: String(row.resource_id),
      permissions: (row.permissions as string[]) ?? [],
      inherit: Boolean(row.inherit),
    }));
  }

  private async sharesFor(
    db: Queryable,
    drive: string,
    ancestors: string[],
    subjects: string[]
  ): Promise<ShareRow[]> {
    if (ancestors.length === 0) return [];
    const sql = `
      SELECT resource_id, subject_type, subject_id, permissions, include_descendants
        FROM gfs_shares
       WHERE drive = $1
         AND resource_id = ANY($2::uuid[])
         AND (subject_type || ':' || subject_id) = ANY($3::text[])`;
    const result = await db.query(sql, [drive, ancestors, subjects]);
    return result.rows.map((row) => ({
      subjectKey: `${String(row.subject_type)}:${String(row.subject_id ?? "")}`,
      resourceId: String(row.resource_id),
      permissions: (row.permissions as string[]) ?? [],
      includeDescendants: Boolean(row.include_descendants),
    }));
  }
}

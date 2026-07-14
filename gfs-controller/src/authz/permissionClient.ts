import { createHash } from "node:crypto";
import { GfsError } from "../api/errors";
import { DecisionCache } from "./cache";
import {
  Decision,
  GfsPermission,
  GrantRow,
  resolveDecision,
  ShareRow,
} from "./resolve";

/** Minimal query surface — a pg Pool satisfies this; tests inject a fake. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AuditEvent {
  subject: string;
  op: string;
  resourceId: string;
  drive: string;
  outcome: "allow" | "deny" | "error";
  reason?: string;
  requestId?: string;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface AuthzContext {
  drive: string;
  /** Canonical subject keys (`type:id`) the principal resolves to (self + groups). */
  subjects: string[];
  /** True iff the principal is a cluster operator (intrinsic full authority). */
  isOperator: boolean;
  /** The token's `sub`, recorded verbatim in the audit row. */
  primarySubject: string;
  requestId?: string;
}

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
 * Permission-store authorization client (read path).
 *
 * FAIL CLOSED: any store error throws GfsError('not_mounted', 503) and is
 * audited as an error — gfsc NEVER falls back to the token's pathBindings (the
 * store is the source of truth). DENY BY DEFAULT: the absence of a matching
 * grant or share denies. The cluster operator is the root of trust and is
 * allowed intrinsically (no stored grant). Every decision — allow, deny, or
 * error — emits an audit row; an audit-write failure propagates (no un-audited
 * op is served).
 */
export class PermissionClient {
  constructor(
    private readonly db: Queryable,
    private readonly audit: AuditSink,
    private readonly cache?: DecisionCache
  ) {}

  async authorize(
    ctx: AuthzContext,
    resourceId: string,
    op: GfsPermission
  ): Promise<Decision> {
    // Intrinsic operator authority short-circuits the grant/share lookup, but
    // is still audited (and a failing audit still propagates below). Not cached —
    // it is already O(1) from ctx.isOperator with no store round-trip to save.
    if (ctx.isOperator) {
      const decision: Decision = { allowed: true, via: "operator" };
      await this.auditDecision(ctx, resourceId, op, decision);
      return decision;
    }

    // Short-TTL decision cache (P2-S03). A HIT skips the store lookup but is
    // STILL audited — the cache short-cuts the SELECTs, never the audit row, so
    // "every op is audited" holds. `get` returns undefined on miss/expiry/bypass
    // (fail-closed: a reader that cannot hear invalidations serves nothing), so
    // a degraded cache simply means every op re-checks the store.
    const cacheKey = this.cache
      ? { subjectsKey: subjectsKeyOf(ctx.subjects), resourceId, op }
      : null;
    if (cacheKey) {
      const cached = this.cache!.get(cacheKey);
      if (cached !== undefined) {
        const decision: Decision = { allowed: cached, via: cached ? "cache" : null };
        await this.auditDecision(ctx, resourceId, op, decision);
        return decision;
      }
    }

    let decision: Decision;
    try {
      const ancestors = await this.ancestors(ctx.drive, resourceId);
      if (ancestors.length === 0) {
        // Resource absent (or fully tombstoned chain) — deny. The read API maps
        // existence (404/410) separately; authorization itself denies.
        decision = { allowed: false, via: null };
      } else {
        const [grants, shares] = await Promise.all([
          this.grantsFor(ctx.drive, ancestors, ctx.subjects),
          this.sharesFor(ctx.drive, ancestors, ctx.subjects),
        ]);
        decision = resolveDecision({
          resourceId: ancestors[0],
          ancestors,
          subjects: new Set(ctx.subjects),
          isOperator: false,
          op,
          grants,
          shares,
        });
      }
    } catch (err) {
      // Fail closed. Try to audit the error, but the store failure is what we
      // surface — never a pathBindings fallback, never a silent allow.
      try {
        await this.audit.record({
          subject: ctx.primarySubject,
          op,
          resourceId,
          drive: ctx.drive,
          outcome: "error",
          reason: errMsg(err),
          requestId: ctx.requestId,
        });
      } catch (auditErr) {
        console.error(
          `[gfsc] failed to audit a store-error denial (subject=${ctx.primarySubject}, ` +
            `resource=${resourceId}): ${errMsg(auditErr)}`
        );
      }
      throw new GfsError("not_mounted", `permission store unavailable: ${errMsg(err)}`);
    }

    // Populate the cache with the freshly-resolved decision (a no-op while the
    // cache is bypassed). A NOTIFY on any grant/share write flushes this, so a
    // cached allow/deny never outlives a revocation by more than `ttlMs`.
    if (cacheKey) this.cache!.set(cacheKey, decision.allowed);

    await this.auditDecision(ctx, resourceId, op, decision);
    return decision;
  }

  /** Audit a decided outcome. Propagates so no un-audited op returns. */
  private async auditDecision(
    ctx: AuthzContext,
    resourceId: string,
    op: GfsPermission,
    decision: Decision
  ): Promise<void> {
    await this.audit.record({
      subject: ctx.primarySubject,
      op,
      resourceId,
      drive: ctx.drive,
      outcome: decision.allowed ? "allow" : "deny",
      reason: decision.via ?? undefined,
      requestId: ctx.requestId,
    });
  }

  /** Ancestor chain (R first, root last) via a single recursive CTE — not N
   * round-trips. Tombstoned rows are excluded. */
  private async ancestors(drive: string, resourceId: string): Promise<string[]> {
    const sql = `
      WITH RECURSIVE chain AS (
        SELECT resource_id, parent_resource_id, 0 AS depth
          FROM gfs_resources
         WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL
        UNION ALL
        SELECT r.resource_id, r.parent_resource_id, c.depth + 1
          FROM gfs_resources r
          JOIN chain c ON r.resource_id = c.parent_resource_id
         WHERE r.drive = $1 AND r.deleted_at IS NULL
      )
      SELECT resource_id FROM chain ORDER BY depth ASC`;
    const result = await this.db.query(sql, [drive, resourceId]);
    return result.rows.map((row) => String(row.resource_id));
  }

  private async grantsFor(
    drive: string,
    ancestors: string[],
    subjects: string[]
  ): Promise<GrantRow[]> {
    const sql = `
      SELECT resource_id, subject_type, subject_id, permissions, inherit
        FROM gfs_grants
       WHERE drive = $1
         AND resource_id = ANY($2::uuid[])
         AND (subject_type || ':' || subject_id) = ANY($3::text[])`;
    const result = await this.db.query(sql, [drive, ancestors, subjects]);
    return result.rows.map((row) => ({
      subjectKey: `${String(row.subject_type)}:${String(row.subject_id ?? "")}`,
      resourceId: String(row.resource_id),
      permissions: (row.permissions as string[]) ?? [],
      inherit: Boolean(row.inherit),
    }));
  }

  private async sharesFor(
    drive: string,
    ancestors: string[],
    subjects: string[]
  ): Promise<ShareRow[]> {
    const sql = `
      SELECT resource_id, subject_type, subject_id, permissions, include_descendants
        FROM gfs_shares
       WHERE drive = $1
         AND resource_id = ANY($2::uuid[])
         AND (subject_type || ':' || subject_id) = ANY($3::text[])`;
    const result = await this.db.query(sql, [drive, ancestors, subjects]);
    return result.rows.map((row) => ({
      subjectKey: `${String(row.subject_type)}:${String(row.subject_id ?? "")}`,
      resourceId: String(row.resource_id),
      permissions: (row.permissions as string[]) ?? [],
      includeDescendants: Boolean(row.include_descendants),
    }));
  }
}

/**
 * Postgres-backed audit sink. Appends one INSERT-only row per authorization
 * decision. Each row carries a content hash (`row_hash`); the full tamper-
 * evident prev_hash -> row_hash chain with a monotonic sequence is completed by
 * the append-only audit writer in P4-S02. gfsc connects as the least-privilege
 * `gfs_controller` role, which holds INSERT-only on gfs_audit.
 */
export class DbAuditSink implements AuditSink {
  constructor(private readonly db: Queryable) {}

  async record(event: AuditEvent): Promise<void> {
    const gfsUri = `gfs://${event.drive}/${event.resourceId}`;
    const rowHash = createHash("sha256")
      .update(
        [event.subject, event.op, gfsUri, event.outcome, event.reason ?? "", event.requestId ?? ""].join(
          " "
        )
      )
      .digest("hex");
    await this.db.query(
      `INSERT INTO gfs_audit (subject, op, gfs_uri, outcome, request_id, row_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.subject, event.op, gfsUri, event.outcome, event.requestId ?? null, rowHash]
    );
  }
}

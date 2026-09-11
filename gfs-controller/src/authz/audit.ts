import { createHash } from "node:crypto";
import {
  withDeadlineTransaction,
  type DeadlineBudget,
  type DeadlinePool,
} from "../db/deadlineQuery";

/** Minimal query surface — a pg Pool satisfies this; tests inject a fake. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type PersistedAuthorizationSource =
  | "direct_grant"
  | "inherited_grant"
  | "direct_share"
  | "inherited_share"
  | "operator";

export type AuthorizationEvidence =
  | {
      authorizationSource: "cache";
      cachedAuthorizationSource: PersistedAuthorizationSource;
    }
  | {
      authorizationSource: PersistedAuthorizationSource | null;
      cachedAuthorizationSource: null;
    };

interface AuditEventBase {
  subject: string;
  /** Effective Control Admin for linked-admin brokerage; null otherwise. */
  actorOnBehalfOf?: string | null;
  /** Authenticated Desktop actor for user-session and linked-admin requests. */
  desktopUserId?: string;
  /** Request authority provenance, distinct from permission-store evidence. */
  authoritySource?: "user-session" | "linked-admin";
  op: string;
  resourceId: string;
  drive: string;
  outcome: "allow" | "deny" | "error";
  reason?: string;
  requestId?: string;
}

export type AuditEvent =
  | (AuditEventBase &
      AuthorizationEvidence & {
        recordType: "authorization_decision";
        matchedSubject: string | null;
        mutationOutcome: null;
      })
  | (AuditEventBase &
      AuthorizationEvidence & {
        recordType: "mutation_outcome";
        matchedSubject: string | null;
        mutationOutcome: "succeeded" | "failed";
      })
  | (AuditEventBase & {
      recordType: "legacy";
      matchedSubject: null;
      authorizationSource: null;
      cachedAuthorizationSource: null;
      mutationOutcome: null;
    });

export interface AuditSink {
  record(event: AuditEvent, queryable?: Queryable, budget?: DeadlineBudget): Promise<void>;
}

const DESKTOP_USER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalDesktopUserId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!DESKTOP_USER_UUID_RE.test(value)) {
    throw new Error("desktop_user_id must be a UUID");
  }
  return value.toLowerCase();
}

/** PostgreSQL-backed, INSERT-only sink for typed GFS audit evidence. */
export class DbAuditSink implements AuditSink {
  constructor(private readonly db: Queryable & DeadlinePool) {}

  async record(event: AuditEvent, queryable?: Queryable, budget?: DeadlineBudget): Promise<void> {
    const desktopUserId = canonicalDesktopUserId(event.desktopUserId);
    const gfsUri = `gfs://${event.drive}/${event.resourceId}`;
    const rowHash = createHash("sha256")
      .update(
        JSON.stringify([
          event.subject,
          event.actorOnBehalfOf ?? null,
          desktopUserId,
          event.authoritySource ?? null,
          event.op,
          gfsUri,
          event.outcome,
          event.reason ?? null,
          event.requestId ?? null,
          event.recordType,
          event.matchedSubject,
          event.authorizationSource,
          event.cachedAuthorizationSource,
          event.mutationOutcome,
        ])
      )
      .digest("hex");

    const append = (target: Queryable) => target.query(
      `INSERT INTO gfs_audit
        (subject, actor_on_behalf_of, op, gfs_uri, outcome, request_id, row_hash, record_type,
         matched_subject, authorization_source, cached_authorization_source,
         mutation_outcome, desktop_user_id, authority_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14)`,
      [
        event.subject,
        event.actorOnBehalfOf ?? null,
        event.op,
        gfsUri,
        event.outcome,
        event.requestId ?? null,
        rowHash,
        event.recordType,
        event.matchedSubject,
        event.authorizationSource,
        event.cachedAuthorizationSource,
        event.mutationOutcome,
        desktopUserId,
        event.authoritySource ?? null,
      ]
    );

    if (queryable) {
      await append(queryable);
      return;
    }
    if (budget) {
      await withDeadlineTransaction(this.db, budget, false, append);
      return;
    }
    await append(this.db);
  }
}

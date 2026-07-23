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

/** PostgreSQL-backed, INSERT-only sink for typed GFS audit evidence. */
export class DbAuditSink implements AuditSink {
  constructor(private readonly db: Queryable & DeadlinePool) {}

  async record(event: AuditEvent, queryable?: Queryable, budget?: DeadlineBudget): Promise<void> {
    const gfsUri = `gfs://${event.drive}/${event.resourceId}`;
    const rowHash = createHash("sha256")
      .update(
        JSON.stringify([
          event.subject,
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
        (subject, op, gfs_uri, outcome, request_id, row_hash, record_type,
         matched_subject, authorization_source, cached_authorization_source,
         mutation_outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.subject,
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

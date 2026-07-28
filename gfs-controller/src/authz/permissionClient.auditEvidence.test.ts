import { describe, expect, it } from "vitest";
import { DecisionCache } from "./cache";
import {
  AuditEvent,
  AuditSink,
  AuthzContext,
  PermissionClient,
  Queryable,
} from "./permissionClient";

class EvidenceDb implements Queryable {
  constructor(private readonly allowed: boolean) {}

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.includes("WITH RECURSIVE")) {
      const resourceId = String((values?.[1] as string[])[0]);
      return {
        rows: [{ requested_resource_id: resourceId, resource_id: resourceId }],
      };
    }
    if (text.includes("FROM gfs_grants")) {
      return {
        rows: this.allowed
          ? [{
              resource_id: "R",
              subject_type: "user",
              subject_id: "user-1",
              permissions: ["read"],
              inherit: false,
            }]
          : [],
      };
    }
    return { rows: [] };
  }
}

class EvidenceSink implements AuditSink {
  events: AuditEvent[] = [];

  async record(event: AuditEvent, _queryable?: Queryable): Promise<void> {
    this.events.push(event);
  }
}

const context: AuthzContext = {
  drive: "main",
  subjects: ["user:user-1"],
  isOperator: false,
  primarySubject: "agent:reader-1",
  requestId: "req-cache",
};

async function recordCacheHit(allowed: boolean): Promise<AuditEvent> {
  const sink = new EvidenceSink();
  const client = new PermissionClient(
    new EvidenceDb(allowed),
    sink,
    new DecisionCache({ ttlMs: 30_000 })
  );
  await client.authorize(context, "R", "read");
  await client.authorize(context, "R", "read");
  return sink.events[1];
}

describe("PermissionClient typed audit evidence", () => {
  it("records cache as the source while retaining an allowed decision's underlying source", async () => {
    await expect(recordCacheHit(true)).resolves.toMatchObject({
      subject: "agent:reader-1",
      op: "read",
      resourceId: "R",
      outcome: "allow",
      requestId: "req-cache",
      recordType: "authorization_decision",
      matchedSubject: "user:user-1",
      authorizationSource: "cache",
      cachedAuthorizationSource: "direct_grant",
      mutationOutcome: null,
    });
  });

  it("keeps cached-deny attribution null without leaking resource metadata", async () => {
    const event = await recordCacheHit(false);
    expect(event).toMatchObject({
      subject: "agent:reader-1",
      op: "read",
      resourceId: "R",
      outcome: "deny",
      requestId: "req-cache",
      recordType: "authorization_decision",
      matchedSubject: null,
      authorizationSource: null,
      cachedAuthorizationSource: null,
      mutationOutcome: null,
    });
    expect(event).not.toHaveProperty("path");
    expect(event).not.toHaveProperty("name");
    expect(event).not.toHaveProperty("blobKey");
  });
});

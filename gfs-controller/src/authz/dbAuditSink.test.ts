import { describe, expect, it, vi } from "vitest";
import { AuditEvent, DbAuditSink, Queryable } from "./audit";

class AuditDb implements Queryable {
  text = "";
  values: unknown[] = [];

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.text = text;
    this.values = values ?? [];
    return { rows: [] };
  }
}

class AuditPool extends AuditDb {
  queries: string[] = [];
  releases = 0;
  connectCalls = 0;

  async connect() {
    this.connectCalls += 1;
    return {
      query: async (text: string, values?: unknown[]) => {
        this.queries.push(text);
        return this.query(text, values);
      },
      release: () => { this.releases += 1; },
    };
  }
}

const directDecision: AuditEvent = {
  subject: "agent:reader-1",
  op: "read",
  resourceId: "resource-id",
  drive: "main",
  outcome: "allow",
  requestId: "req-7",
  recordType: "authorization_decision",
  matchedSubject: "agent:reader-1",
  authorizationSource: "direct_grant",
  cachedAuthorizationSource: null,
  mutationOutcome: null,
};

describe("DbAuditSink", () => {
  it("persists typed authorization attribution in the hashed INSERT-only row", async () => {
    const db = new AuditDb();
    await new DbAuditSink(db).record(directDecision);

    expect(db.text).toContain(
      "record_type,\n         matched_subject, authorization_source, cached_authorization_source"
    );
    expect(db.values).toEqual([
      "agent:reader-1",
      null,
      "read",
      "gfs://main/resource-id",
      "allow",
      "req-7",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "authorization_decision",
      "agent:reader-1",
      "direct_grant",
      null,
      null,
      null,
      null,
    ]);
    expect(db.text).not.toMatch(/\b(path|name|blob_key)\b/);
    expect(String(db.values[6])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists linked Desktop actor and effective Control Admin without overloading store evidence", async () => {
    const db = new AuditDb();
    await new DbAuditSink(db).record({
      ...directDecision,
      subject: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actorOnBehalfOf: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      desktopUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      authoritySource: "linked-admin",
      authorizationSource: "operator",
      matchedSubject: "operator:",
    });

    expect(db.text).toContain("actor_on_behalf_of");
    expect(db.text).toContain("desktop_user_id");
    expect(db.text).toContain("authority_source");
    expect(db.values).toEqual([
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "read",
      "gfs://main/resource-id",
      "allow",
      "req-7",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "authorization_decision",
      "operator:",
      "operator",
      null,
      null,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "linked-admin",
    ]);
  });

  it("rejects a non-UUID Desktop actor before reaching the UUID audit cast", async () => {
    const db = new AuditDb();
    await expect(
      new DbAuditSink(db).record({
        ...directDecision,
        desktopUserId: "host:1st:mcp-host/invalid",
        authoritySource: "user-session",
      })
    ).rejects.toThrow("desktop_user_id must be a UUID");
    expect(db.text).toBe("");
  });

  it("persists cache attribution and includes it in the deterministic hash", async () => {
    const first = new AuditDb();
    const repeated = new AuditDb();
    const direct = new AuditDb();
    const cachedDecision: AuditEvent = {
      ...directDecision,
      authorizationSource: "cache",
      cachedAuthorizationSource: "direct_grant",
    };

    await new DbAuditSink(first).record(cachedDecision);
    await new DbAuditSink(repeated).record(cachedDecision);
    await new DbAuditSink(direct).record(directDecision);

    expect(first.values.slice(7, 12)).toEqual([
      "authorization_decision",
      "agent:reader-1",
      "cache",
      "direct_grant",
      null,
    ]);
    expect(first.values[6]).toBe(repeated.values[6]);
    expect(first.values[6]).not.toBe(direct.values[6]);
  });

  it("uses a supplied transaction client instead of the default pool", async () => {
    const pool = new AuditDb();
    const transaction = new AuditDb();

    await new DbAuditSink(pool).record(directDecision, transaction);

    expect(pool.text).toBe("");
    expect(pool.values).toEqual([]);
    expect(transaction.text).toContain("INSERT INTO gfs_audit");
    expect(transaction.values.slice(0, 5)).toEqual([
      "agent:reader-1",
      null,
      "read",
      "gfs://main/resource-id",
      "allow",
    ]);
  });

  it("supports a separate typed mutation outcome record", async () => {
    const db = new AuditDb();
    await new DbAuditSink(db).record({
      ...directDecision,
      op: "write",
      outcome: "error",
      recordType: "mutation_outcome",
      mutationOutcome: "failed",
    });

    expect(db.values.slice(7, 12)).toEqual([
      "mutation_outcome",
      "agent:reader-1",
      "direct_grant",
      null,
      "failed",
    ]);
  });

  it("uses a checked-out client and statement timeout for a bounded standalone audit", async () => {
    const pool = new AuditPool();

    await new DbAuditSink(pool).record(directDecision, undefined, {
      deadlineAtMs: Date.now() + 1_000,
    });

    expect(pool.connectCalls).toBe(1);
    expect(pool.queries).toEqual([
      "BEGIN",
      expect.stringContaining("set_config('statement_timeout'"),
      expect.stringContaining("INSERT INTO gfs_audit"),
      "COMMIT",
    ]);
    expect(pool.releases).toBe(1);
  });

  it("releases a late audit client without issuing SQL after its acquisition deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveClient!: (client: {
        query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        release(): void;
      }) => void;
      const queries: string[] = [];
      let releases = 0;
      const pool = Object.assign(new AuditDb(), {
        connect: () => new Promise<Parameters<typeof resolveClient>[0]>(resolve => { resolveClient = resolve; }),
      });
      const sink = new DbAuditSink(pool);
      const recording = sink.record(directDecision, undefined, {
        deadlineAtMs: Date.now() + 10,
      });
      const rejected = expect(recording).rejects.toMatchObject({ code: "precondition_failed" });

      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      resolveClient({
        query: async text => { queries.push(text); return { rows: [] }; },
        release: () => { releases += 1; },
      });
      await Promise.resolve();

      expect(queries).toEqual([]);
      expect(releases).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

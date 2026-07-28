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
    ]);
    expect(db.text).not.toMatch(/\b(path|name|blob_key)\b/);
    expect(String(db.values[5])).toMatch(/^[0-9a-f]{64}$/);
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

    expect(first.values.slice(6, 11)).toEqual([
      "authorization_decision",
      "agent:reader-1",
      "cache",
      "direct_grant",
      null,
    ]);
    expect(first.values[5]).toBe(repeated.values[5]);
    expect(first.values[5]).not.toBe(direct.values[5]);
  });

  it("uses a supplied transaction client instead of the default pool", async () => {
    const pool = new AuditDb();
    const transaction = new AuditDb();

    await new DbAuditSink(pool).record(directDecision, transaction);

    expect(pool.text).toBe("");
    expect(pool.values).toEqual([]);
    expect(transaction.text).toContain("INSERT INTO gfs_audit");
    expect(transaction.values.slice(0, 4)).toEqual([
      "agent:reader-1",
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

    expect(db.values.slice(6, 11)).toEqual([
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

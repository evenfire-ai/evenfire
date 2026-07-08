import { describe, expect, it } from "vitest";
import { DecisionCache } from "./cache";
import {
  AuditEvent,
  AuditSink,
  AuthzContext,
  DbAuditSink,
  PermissionClient,
  Queryable,
} from "./permissionClient";
import { resolveDecision } from "./resolve";

describe("resolveDecision (deny-by-default, spec-faithful)", () => {
  const base = {
    resourceId: "R",
    ancestors: ["R", "P", "ROOT"],
    subjects: new Set(["user:user-1"]),
    isOperator: false,
    op: "read" as const,
    grants: [],
    shares: [],
  };

  it("allows the operator intrinsically (no grant required)", () => {
    expect(resolveDecision({ ...base, isOperator: true })).toEqual({
      allowed: true,
      via: "operator",
    });
  });

  it("denies a non-operator with no grants or shares", () => {
    expect(resolveDecision(base).allowed).toBe(false);
  });

  it("allows a direct grant on the resource itself regardless of inherit", () => {
    const d = resolveDecision({
      ...base,
      grants: [{ subjectKey: "user:user-1", resourceId: "R", permissions: ["read"], inherit: false }],
    });
    expect(d).toEqual({ allowed: true, via: "grant" });
  });

  it("inherits an ancestor grant ONLY when inherit = true (§Inheritance)", () => {
    const inheriting = resolveDecision({
      ...base,
      grants: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], inherit: true }],
    });
    expect(inheriting.allowed).toBe(true);

    const notInheriting = resolveDecision({
      ...base,
      grants: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], inherit: false }],
    });
    expect(notInheriting.allowed).toBe(false);
  });

  it("denies a grant that lacks the op bit or belongs to a different subject", () => {
    expect(
      resolveDecision({
        ...base,
        grants: [{ subjectKey: "user:user-1", resourceId: "R", permissions: ["write"], inherit: true }],
      }).allowed
    ).toBe(false);
    expect(
      resolveDecision({
        ...base,
        grants: [{ subjectKey: "user:someone-else", resourceId: "R", permissions: ["read"], inherit: true }],
      }).allowed
    ).toBe(false);
  });

  it("matches an operator-group grant via the operator: subject key", () => {
    const d = resolveDecision({
      ...base,
      subjects: new Set(["operator:"]),
      grants: [{ subjectKey: "operator:", resourceId: "R", permissions: ["read"], inherit: false }],
    });
    expect(d.allowed).toBe(true);
  });

  it("allows an exact-resource share; an ancestor share only with includeDescendants", () => {
    expect(
      resolveDecision({
        ...base,
        shares: [{ subjectKey: "user:user-1", resourceId: "R", permissions: ["read"], includeDescendants: false }],
      })
    ).toEqual({ allowed: true, via: "share" });

    expect(
      resolveDecision({
        ...base,
        shares: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], includeDescendants: true }],
      }).allowed
    ).toBe(true);

    expect(
      resolveDecision({
        ...base,
        shares: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], includeDescendants: false }],
      }).allowed
    ).toBe(false);
  });
});

class FakeDb implements Queryable {
  ancestors: string[] = [];
  grants: Record<string, unknown>[] = [];
  shares: Record<string, unknown>[] = [];
  failOn: "ancestors" | "grants" | "shares" | "audit" | null = null;
  audits: unknown[][] = [];
  cteQueries = 0;

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.includes("INSERT INTO gfs_audit")) {
      if (this.failOn === "audit") throw new Error("audit table unavailable");
      this.audits.push(values ?? []);
      return { rows: [] };
    }
    if (text.includes("WITH RECURSIVE")) {
      this.cteQueries++;
      if (this.failOn === "ancestors") throw new Error("permission store down");
      return { rows: this.ancestors.map((id) => ({ resource_id: id })) };
    }
    if (text.includes("FROM gfs_grants")) {
      if (this.failOn === "grants") throw new Error("permission store down");
      return { rows: this.grants };
    }
    if (text.includes("FROM gfs_shares")) {
      if (this.failOn === "shares") throw new Error("permission store down");
      return { rows: this.shares };
    }
    return { rows: [] };
  }
}

class RecordingSink implements AuditSink {
  events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const userCtx: AuthzContext = {
  drive: "main",
  subjects: ["user:user-1"],
  isOperator: false,
  primarySubject: "user-1",
  requestId: "req-7",
};
const operatorCtx: AuthzContext = {
  drive: "main",
  subjects: ["operator:"],
  isOperator: true,
  primarySubject: "admin-9",
  requestId: "req-op",
};

describe("PermissionClient (fail-closed, deny-by-default, audited)", () => {
  it("allows the operator intrinsically without touching grant tables, and audits it", async () => {
    const db = new FakeDb();
    const sink = new RecordingSink();
    const decision = await new PermissionClient(db, sink).authorize(operatorCtx, "R", "read");
    expect(decision).toEqual({ allowed: true, via: "operator" });
    expect(db.cteQueries).toBe(0); // intrinsic — no ancestor lookup needed
    expect(sink.events[0]).toMatchObject({ outcome: "allow", reason: "operator", subject: "admin-9" });
  });

  it("allows a granted non-operator and audits the allow", async () => {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"];
    db.grants = [
      { resource_id: "R", subject_type: "user", subject_id: "user-1", permissions: ["read"], inherit: false },
    ];
    const sink = new RecordingSink();
    const decision = await new PermissionClient(db, sink).authorize(userCtx, "R", "read");
    expect(decision.allowed).toBe(true);
    expect(sink.events[0]).toMatchObject({ outcome: "allow" });
  });

  it("denies an ungranted non-operator and audits the deny", async () => {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"];
    const sink = new RecordingSink();
    const decision = await new PermissionClient(db, sink).authorize(userCtx, "R", "read");
    expect(decision.allowed).toBe(false);
    expect(sink.events[0]).toMatchObject({ outcome: "deny" });
  });

  it("denies when the resource is absent (empty ancestor chain)", async () => {
    const db = new FakeDb();
    db.ancestors = [];
    const sink = new RecordingSink();
    const decision = await new PermissionClient(db, sink).authorize(userCtx, "missing", "read");
    expect(decision.allowed).toBe(false);
  });

  it("FAILS CLOSED with not_mounted (503) when the store is down — never a pathBindings fallback", async () => {
    const db = new FakeDb();
    db.failOn = "ancestors";
    const sink = new RecordingSink();
    await expect(new PermissionClient(db, sink).authorize(userCtx, "R", "read")).rejects.toMatchObject({
      code: "not_mounted",
    });
    expect(sink.events[0]).toMatchObject({ outcome: "error" });
  });

  it("propagates an audit-write failure (no un-audited op is served)", async () => {
    const db = new FakeDb();
    db.ancestors = ["R"];
    db.grants = [
      { resource_id: "R", subject_type: "user", subject_id: "user-1", permissions: ["read"], inherit: false },
    ];
    db.failOn = "audit";
    const client = new PermissionClient(db, new DbAuditSink(db));
    await expect(client.authorize(userCtx, "R", "read")).rejects.toThrow();
  });
});

describe("PermissionClient + DecisionCache (cache→store, fail-closed)", () => {
  function grantedDb(): FakeDb {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"];
    db.grants = [
      { resource_id: "R", subject_type: "user", subject_id: "user-1", permissions: ["read"], inherit: false },
    ];
    return db;
  }

  it("serves a second identical op from cache WITHOUT a second store lookup, but still audits", async () => {
    const db = grantedDb();
    const sink = new RecordingSink();
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    const client = new PermissionClient(db, sink, cache);

    const first = await client.authorize(userCtx, "R", "read");
    const second = await client.authorize(userCtx, "R", "read");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(db.cteQueries).toBe(1); // store hit once; the 2nd op was a cache hit
    expect(sink.events).toHaveLength(2); // BOTH ops audited — cache never skips audit
    expect(sink.events[1]).toMatchObject({ outcome: "allow", reason: "cache" });
  });

  it("caches a DENY too (a later grant fires a NOTIFY→flush, so it never goes stale silently)", async () => {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"]; // resource exists, but no grant → deny
    const sink = new RecordingSink();
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    const client = new PermissionClient(db, sink, cache);

    await client.authorize(userCtx, "R", "read");
    await client.authorize(userCtx, "R", "read");

    expect(db.cteQueries).toBe(1);
    expect(sink.events.every((e) => e.outcome === "deny")).toBe(true);
  });

  it("flushAll (the action a NOTIFY triggers) forces the next op to re-check the store", async () => {
    const db = grantedDb();
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    const client = new PermissionClient(db, new RecordingSink(), cache);

    await client.authorize(userCtx, "R", "read");
    cache.flushAll(); // immediate revocation path
    await client.authorize(userCtx, "R", "read");

    expect(db.cteQueries).toBe(2); // re-checked after the flush
  });

  it("a BYPASSED cache (degraded invalidation) re-checks the store on every op", async () => {
    const db = grantedDb();
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    cache.setBypassed(true); // invalidation fan-out unhealthy → serve nothing
    const client = new PermissionClient(db, new RecordingSink(), cache);

    await client.authorize(userCtx, "R", "read");
    await client.authorize(userCtx, "R", "read");

    expect(db.cteQueries).toBe(2); // no caching while bypassed — fail closed
  });

  it("keys on (subjects, resource, op) — a different op is a separate lookup", async () => {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"];
    db.grants = [
      { resource_id: "R", subject_type: "user", subject_id: "user-1", permissions: ["read", "write"], inherit: false },
    ];
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    const client = new PermissionClient(db, new RecordingSink(), cache);

    await client.authorize(userCtx, "R", "read");
    await client.authorize(userCtx, "R", "write"); // different op → not the cached entry

    expect(db.cteQueries).toBe(2);
  });

  it("never consults the cache for an operator (intrinsic, no store round-trip to save)", async () => {
    const db = new FakeDb();
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    const client = new PermissionClient(db, new RecordingSink(), cache);

    await client.authorize(operatorCtx, "R", "read");
    expect(cache.size).toBe(0); // operator decisions are not cached
    expect(db.cteQueries).toBe(0);
  });
});

describe("DbAuditSink", () => {
  it("appends an INSERT-only row with a content hash", async () => {
    const db = new FakeDb();
    await new DbAuditSink(db).record({
      subject: "user-1",
      op: "read",
      resourceId: "R",
      drive: "main",
      outcome: "allow",
      requestId: "req-7",
    });
    expect(db.audits).toHaveLength(1);
    const values = db.audits[0];
    expect(values[0]).toBe("user-1");
    expect(values[1]).toBe("read");
    expect(values[2]).toBe("gfs://main/R");
    expect(values[3]).toBe("allow");
    expect(String(values[5])).toMatch(/^[0-9a-f]{64}$/);
  });
});

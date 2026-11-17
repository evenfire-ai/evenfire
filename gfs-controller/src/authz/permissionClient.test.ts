import { describe, expect, it, vi } from "vitest";
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
      matchedSubject: null,
      authorizationSource: "operator",
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
    expect(d).toMatchObject({ allowed: true, via: "grant", authorizationSource: "direct_grant" });
  });

  it("inherits an ancestor grant ONLY when inherit = true (§Inheritance)", () => {
    const inheriting = resolveDecision({
      ...base,
      grants: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], inherit: true }],
    });
    expect(inheriting).toMatchObject({
      allowed: true,
      matchedSubject: "user:user-1",
      authorizationSource: "inherited_grant",
    });

    const notInheriting = resolveDecision({
      ...base,
      grants: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], inherit: false }],
    });
    expect(notInheriting.allowed).toBe(false);
  });

  it("attributes a direct grant before an inherited grant regardless of row order", () => {
    const decision = resolveDecision({
      ...base,
      subjects: new Set(["user:user-1", "team:team-1"]),
      grants: [
        { subjectKey: "team:team-1", resourceId: "ROOT", permissions: ["read"], inherit: true },
        { subjectKey: "user:user-1", resourceId: "R", permissions: ["read"], inherit: false },
      ],
    });
    expect(decision).toMatchObject({
      matchedSubject: "user:user-1",
      authorizationSource: "direct_grant",
    });
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
    ).toMatchObject({ allowed: true, via: "share", authorizationSource: "direct_share" });

    const inheritedShare = resolveDecision({
        ...base,
        shares: [{ subjectKey: "user:user-1", resourceId: "ROOT", permissions: ["read"], includeDescendants: true }],
      });
    expect(inheritedShare).toMatchObject({
      allowed: true,
      matchedSubject: "user:user-1",
      authorizationSource: "inherited_share",
    });

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
      const requested = (values?.[1] as string[]) ?? [];
      return {
        rows: requested.flatMap((resourceId) =>
          this.ancestors.map((id) => ({
            requested_resource_id: resourceId,
            resource_id: id,
          }))
        ),
      };
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
  async record(event: AuditEvent, _queryable?: Queryable): Promise<void> {
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
    expect(decision).toMatchObject({ allowed: true, via: "operator", authorizationSource: "operator" });
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
    expect(second).toMatchObject({ via: "cache", authorizationSource: "direct_grant" });
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

describe("PermissionClient.authorizeWithin (re-decision on a writer transaction's client)", () => {
  /** The writer transaction's client: records every statement it receives. */
  class TxDb extends FakeDb {
    statements: string[] = [];
    override async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
      this.statements.push(text);
      return super.query(text, values);
    }
  }

  /** The client's own constructor pool: must never be reached. */
  function untouchedPool() {
    return {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => {
        throw new Error("authorizeWithin must not check out a pool client");
      }),
    };
  }

  function spiedCache(): DecisionCache {
    const cache = new DecisionCache({ ttlMs: 30_000, now: () => 1_000 });
    vi.spyOn(cache, "get");
    vi.spyOn(cache, "set");
    return cache;
  }

  const kinds = (statements: string[]) => statements.map(text =>
    text.includes("INSERT INTO gfs_audit") ? "audit"
      : text.includes("WITH RECURSIVE") ? "ancestors"
        : text.includes("FROM gfs_grants") ? "grants"
          : text.includes("FROM gfs_shares") ? "shares" : text);

  it("W1: reads and audits only on the given client and never touches the pool or the cache", async () => {
    const pool = untouchedPool();
    const cache = spiedCache();
    const tx = new TxDb();
    tx.ancestors = ["R", "ROOT"];
    tx.grants = [
      { resource_id: "ROOT", subject_type: "user", subject_id: "user-1", permissions: ["write"], inherit: true },
    ];
    const client = new PermissionClient(pool as never, new DbAuditSink(pool as never), cache);

    const decisions = await client.authorizeWithin(tx, userCtx, [{ resourceId: "R", op: "write" }]);

    expect(decisions).toEqual([expect.objectContaining({ allowed: true, matchedSubject: "user:user-1" })]);
    expect(kinds(tx.statements)).toEqual(["ancestors", "grants", "shares", "audit"]);
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0][4]).toBe("allow");
    expect(tx.audits[0][8]).toBe("user:user-1");
    expect(tx.audits[0][7]).toBe("authorization_decision");
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("W2: audits a deny on the given client", async () => {
    const pool = untouchedPool();
    const tx = new TxDb();
    tx.ancestors = ["R", "ROOT"];
    const client = new PermissionClient(pool as never, new DbAuditSink(pool as never));

    const decisions = await client.authorizeWithin(tx, userCtx, [{ resourceId: "R", op: "write" }]);

    expect(decisions[0].allowed).toBe(false);
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0][4]).toBe("deny");
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("W3: allows an operator with no store read and audits it on the given client", async () => {
    const pool = untouchedPool();
    const tx = new TxDb();
    const client = new PermissionClient(pool as never, new DbAuditSink(pool as never));

    const decisions = await client.authorizeWithin(tx, operatorCtx, [
      { resourceId: "R", op: "write" },
      { resourceId: "S", op: "read" },
    ]);

    expect(decisions.map(decision => decision.via)).toEqual(["operator", "operator"]);
    expect(kinds(tx.statements)).toEqual(["audit", "audit"]);
    expect(tx.cteQueries).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("W4: propagates a store error unchanged, with no not_mounted mapping and no audit", async () => {
    const pool = untouchedPool();
    const tx = new TxDb();
    tx.ancestors = ["R"];
    tx.failOn = "grants";
    const client = new PermissionClient(pool as never, new DbAuditSink(pool as never));

    await expect(client.authorizeWithin(tx, userCtx, [{ resourceId: "R", op: "write" }]))
      .rejects.toThrow("permission store down");
    await expect(client.authorizeWithin(tx, userCtx, [{ resourceId: "R", op: "write" }]))
      .rejects.not.toMatchObject({ code: "not_mounted" });
    expect(kinds(tx.statements)).toContain("ancestors");
    expect(tx.audits).toHaveLength(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an empty request list instead of returning a vacuous result", async () => {
    const pool = untouchedPool();
    const tx = new TxDb();
    const client = new PermissionClient(pool as never, new DbAuditSink(pool as never));

    await expect(client.authorizeWithin(tx, userCtx, [])).rejects.toMatchObject({ code: "internal" });
    expect(tx.statements).toHaveLength(0);
  });
});

describe("PermissionClient.auditRefusedWithin (durable row after a rolled-back re-decision)", () => {
  /** Records each event with whether a queryable (a transaction client) was passed. */
  class QueryableAwareSink implements AuditSink {
    calls: Array<{ event: AuditEvent; queryable: Queryable | undefined }> = [];
    fail: "deny" | "error" | null = null;
    async record(event: AuditEvent, queryable?: Queryable): Promise<void> {
      this.calls.push({ event, queryable });
      if (this.fail !== null && event.outcome === this.fail) throw new Error(`audit ${this.fail} insert failed`);
    }
  }
  const R1 = { resourceId: "R", op: "write" as const };
  const R2 = { resourceId: "S", op: "read" as const };

  it("P-F1a: a refused deny writes the row a store deny writes, on the pool", async () => {
    const db = new FakeDb();
    db.ancestors = ["R", "ROOT"];
    const viaAuthorize = new QueryableAwareSink();
    await new PermissionClient(db, viaAuthorize).authorize(userCtx, R1.resourceId, R1.op);
    const viaRefusal = new QueryableAwareSink();

    await new PermissionClient(db, viaRefusal).auditRefusedWithin(userCtx, { denied: [R1] });

    expect(viaAuthorize.calls).toHaveLength(1);
    expect(viaAuthorize.calls[0].event).toMatchObject({ outcome: "deny" });
    expect(viaRefusal.calls).toHaveLength(1);
    expect(viaRefusal.calls[0].queryable).toBeUndefined();
    expect(viaRefusal.calls[0].event).toEqual(viaAuthorize.calls[0].event);
  });

  it("P-F1b: a refused store error writes the rows authorizeMany writes for the same error, on the pool", async () => {
    const db = new FakeDb();
    db.failOn = "ancestors";
    const viaAuthorize = new QueryableAwareSink();
    await expect(
      new PermissionClient(db, viaAuthorize).authorizeMany(userCtx, [R1, R2])
    ).rejects.toMatchObject({ code: "not_mounted" });
    const viaRefusal = new QueryableAwareSink();

    await new PermissionClient(db, viaRefusal).auditRefusedWithin(userCtx, {
      failed: [R1, R2],
      error: new Error("permission store down"),
    });

    expect(viaAuthorize.calls.map(call => call.event.outcome)).toEqual(["error", "error"]);
    expect(viaRefusal.calls.map(call => call.queryable)).toEqual([undefined, undefined]);
    expect(viaRefusal.calls.map(call => call.event)).toEqual(viaAuthorize.calls.map(call => call.event));
  });

  it("P-F1c: a failed deny insert propagates; a failed error insert is logged", async () => {
    const denySink = new QueryableAwareSink();
    denySink.fail = "deny";
    await expect(
      new PermissionClient(new FakeDb(), denySink).auditRefusedWithin(userCtx, { denied: [R1] })
    ).rejects.toThrow("audit deny insert failed");
    expect(denySink.calls).toHaveLength(1);

    const errorSink = new QueryableAwareSink();
    errorSink.fail = "error";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        new PermissionClient(new FakeDb(), errorSink).auditRefusedWithin(userCtx, {
          failed: [R1],
          error: new Error("permission store down"),
        })
      ).resolves.toBeUndefined();
      expect(errorSink.calls).toHaveLength(1);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

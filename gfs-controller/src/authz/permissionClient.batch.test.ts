import { describe, expect, it } from "vitest";
import { DecisionCache } from "./cache";
import { AuditEvent, AuditSink, AuthzContext, PermissionClient, Queryable } from "./permissionClient";

class BatchDb implements Queryable {
  ancestorChains: Record<string, string[]> = {};
  grants: Record<string, unknown>[] = [];
  shares: Record<string, unknown>[] = [];
  requestedRowIds: Record<string, string> = {};
  counts = { ancestors: 0, grants: 0, shares: 0 };
  calls: Array<{ text: string; values: unknown[] }> = [];
  failAncestors = false;

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values: values ?? [] });
    if (text.includes("WITH RECURSIVE")) {
      this.counts.ancestors++;
      if (this.failAncestors) throw new Error("store unavailable");
      const requested = (values?.[1] as string[]) ?? [];
      return { rows: requested.flatMap((resourceId) =>
        (this.ancestorChains[resourceId] ?? []).map((ancestorId) => ({
          requested_resource_id: this.requestedRowIds[resourceId] ?? resourceId,
          resource_id: ancestorId,
        }))
      ) };
    }
    if (text.includes("FROM gfs_grants")) {
      this.counts.grants++;
      return { rows: this.grants };
    }
    if (text.includes("FROM gfs_shares")) {
      this.counts.shares++;
      return { rows: this.shares };
    }
    return { rows: [] };
  }

  async connect() {
    return {
      query: async (text: string, values: unknown[] = []) => {
        if (text === "BEGIN READ ONLY" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('statement_timeout'")) {
          this.calls.push({ text, values });
          return { rows: [] };
        }
        return this.query(text, values);
      },
      release: () => undefined,
    };
  }
}

class BatchAudit implements AuditSink {
  events: AuditEvent[] = [];
  async record(event: AuditEvent, _queryable?: Queryable): Promise<void> {
    this.events.push(event);
  }
}

const context: AuthzContext = {
  drive: "main",
  subjects: ["user:u1"],
  isOperator: false,
  primarySubject: "u1",
  requestId: "req-batch",
};

describe("PermissionClient.authorizeMany", () => {
  it("returns immediately for an empty batch", async () => {
    const db = new BatchDb();
    await expect(new PermissionClient(db, new BatchAudit()).authorizeMany(context, [])).resolves.toEqual([]);
    expect(db.counts).toEqual({ ancestors: 0, grants: 0, shares: 0 });
  });

  it("uses a bounded three-query permission snapshot for any batch size", async () => {
    const db = new BatchDb();
    db.ancestorChains = {
      f1: ["f1", "folder", "root"],
      f2: ["f2", "folder", "root"],
      f3: ["f3", "folder", "root"],
    };
    db.grants = [{
      resource_id: "folder",
      subject_type: "user",
      subject_id: "u1",
      permissions: ["read"],
      inherit: true,
    }];
    const audit = new BatchAudit();
    const decisions = await new PermissionClient(db, audit).authorizeMany(context, [
      { resourceId: "f1", op: "read" },
      { resourceId: "f2", op: "read" },
      { resourceId: "f3", op: "write" },
    ]);

    expect(db.counts).toEqual({ ancestors: 1, grants: 1, shares: 1 });
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, false]);
    expect(decisions[0]).toMatchObject({
      matchedSubject: "user:u1",
      authorizationSource: "inherited_grant",
    });
    expect(audit.events.map((event) => event.requestId)).toEqual([
      "req-batch",
      "req-batch",
      "req-batch",
    ]);
  });

  it("applies the remaining Copy deadline to every permission-store query", async () => {
    const db = new BatchDb();
    db.ancestorChains = { file: ["file"] };
    await new PermissionClient(db, new BatchAudit()).authorizeMany(context, [
      { resourceId: "file", op: "read" },
    ], { deadlineAtMs: 10_000, now: () => 7_500 });
    expect(db.calls.map(call => call.text)).toEqual([
      "BEGIN READ ONLY", "SELECT set_config('statement_timeout', $1, true)",
      expect.stringContaining("WITH RECURSIVE requested"), expect.stringContaining("FROM gfs_grants"),
      expect.stringContaining("FROM gfs_shares"), "COMMIT",
      "BEGIN", "SELECT set_config('statement_timeout', $1, true)", "COMMIT",
    ]);
    expect(db.calls[1].values).toEqual(["2500"]);
    expect(db.calls[7].values).toEqual(["2500"]);
  });

  it("does not query after an exhausted Copy authorization budget", async () => {
    const db = new BatchDb();
    await expect(new PermissionClient(db, new BatchAudit()).authorizeMany(context, [
      { resourceId: "file", op: "read" },
    ], { deadlineAtMs: 100, now: () => 100 })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(db.calls).toEqual([]);
  });

  it("matches compact request RIDs to PostgreSQL UUID rows and direct grants", async () => {
    const rid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const db = new BatchDb();
    db.ancestorChains = { [rid]: [uuid] };
    db.requestedRowIds = { [rid]: uuid };
    db.grants = [{
      resource_id: uuid,
      subject_type: "user",
      subject_id: "u1",
      permissions: ["read"],
      inherit: false,
    }];

    const [decision] = await new PermissionClient(db, new BatchAudit()).authorizeMany(context, [
      { resourceId: rid, op: "read" },
    ]);
    expect(decision).toMatchObject({
      allowed: true,
      matchedSubject: "user:u1",
      authorizationSource: "direct_grant",
    });
    expect(db.counts).toEqual({ ancestors: 1, grants: 1, shares: 1 });
  });

  it("audits every node even when an intermediate child denies", async () => {
    const db = new BatchDb();
    db.ancestorChains = {
      parent: ["parent"],
      denied: ["denied", "parent"],
      allowed: ["allowed", "parent"],
    };
    db.grants = [
      { resource_id: "parent", subject_type: "user", subject_id: "u1", permissions: ["read"], inherit: false },
      { resource_id: "allowed", subject_type: "user", subject_id: "u1", permissions: ["read"], inherit: false },
    ];
    const audit = new BatchAudit();
    const decisions = await new PermissionClient(db, audit).authorizeMany(context, [
      { resourceId: "parent", op: "read" },
      { resourceId: "denied", op: "read" },
      { resourceId: "allowed", op: "read" },
    ]);

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, false, true]);
    expect(decisions[1]).toEqual({
      allowed: false,
      via: null,
      matchedSubject: null,
      authorizationSource: null,
    });
    for (const decision of decisions) {
      expect(Object.keys(decision)).not.toContain("path");
      expect(Object.keys(decision)).not.toContain("name");
    }
    expect(audit.events.map((event) => event.resourceId)).toEqual(["parent", "denied", "allowed"]);
  });

  it("retains underlying attribution on cache hits and flush forces fresh reads", async () => {
    const db = new BatchDb();
    db.ancestorChains = { file: ["file", "root"] };
    db.shares = [{
      resource_id: "file",
      subject_type: "user",
      subject_id: "u1",
      permissions: ["read"],
      include_descendants: false,
    }];
    const cache = new DecisionCache({ ttlMs: 30_000 });
    const client = new PermissionClient(db, new BatchAudit(), cache);
    const request = [{ resourceId: "file", op: "read" as const }];

    const first = await client.authorizeMany(context, request);
    const second = await client.authorizeMany(context, request);
    expect(first[0]).toMatchObject({ via: "share", authorizationSource: "direct_share" });
    expect(second[0]).toMatchObject({
      via: "cache",
      matchedSubject: "user:u1",
      authorizationSource: "direct_share",
    });
    expect(db.counts.ancestors).toBe(1);

    cache.flushAll();
    await client.authorizeMany(context, request);
    expect(db.counts.ancestors).toBe(2);
  });

  it("audits every requested node as an error when the batch snapshot fails", async () => {
    const db = new BatchDb();
    db.failAncestors = true;
    const audit = new BatchAudit();
    const operation = new PermissionClient(db, audit).authorizeMany(context, [
      { resourceId: "one", op: "read" },
      { resourceId: "two", op: "read" },
    ]);

    await expect(operation).rejects.toMatchObject({ code: "not_mounted" });
    expect(audit.events.map((event) => [event.resourceId, event.outcome, event.requestId])).toEqual([
      ["one", "error", "req-batch"],
      ["two", "error", "req-batch"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditSink, Queryable } from "../authz/audit";
import type { DeadlineBudget } from "./deadlineQuery";
import { CommitOutcomeUnknownError, GfsWriteService, type BlobWriter, type Transactor, type TxClient } from "./writeStore";
import { PgBlobStagingStore } from "./blobStaging";

const PARENT = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const CHILD = "00000000-0000-4000-8000-000000000003";
const REQUEST = "00000000-0000-4000-8000-000000000004";
const TOMBSTONE = "00000000-0000-4000-8000-000000000005";
const HIDDEN_LIVE = "00000000-0000-4000-8000-000000000006";

function record(over: Record<string, unknown> = {}) {
  return { resource_id: TARGET, drive: "main", parent_resource_id: PARENT, name: "old", kind: "directory",
    path_cache: "/docs/old", version: 4, bytes: 0, blob_key: null, content_sha256: null,
    deleted_at: null, updated_at: "2026-07-17T00:00:00.000Z", depth: 0, cycle: false,
    under_tombstone: false, ...over };
}

class Db implements TxClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  tree = [record(), record({ resource_id: CHILD, parent_resource_id: TARGET, name: "file.txt", kind: "file",
    path_cache: "/docs/old/file.txt", version: 7, bytes: 5, blob_key: "blob/key", content_sha256: "a".repeat(64), depth: 1 })];
  collision = false;
  mutateSecondLoad = false;
  loads = 0;
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock") || sql.includes("FOR UPDATE")) return { rows: [] };
    if (sql.includes("WITH RECURSIVE rename_tree")) {
      this.loads += 1;
      if (this.loads === 2 && this.mutateSecondLoad) this.tree[1] = { ...this.tree[1], version: 8 };
      return { rows: this.tree.filter(item => item.depth === 0 || item.deleted_at == null).map(item => ({ ...item })) };
    }
    if (sql.includes("SELECT path_cache, deleted_at")) return { rows: [{ path_cache: "/docs", deleted_at: null }] };
    if (sql.includes("SELECT 1 FROM gfs_resources")) return { rows: this.collision ? [{ "?column?": 1 }] : [] };
    if (sql.includes("UPDATE gfs_resources")) {
      const [rootId, newName, encodedPaths] = values as [string, string, string];
      const paths = new Map((JSON.parse(encodedPaths) as Array<{ resource_id: string; path_cache: string }>).map(item => [item.resource_id, item.path_cache]));
      this.tree = this.tree.map(item => {
        const path = paths.get(String(item.resource_id));
        if (path === undefined) return item;
        return item.resource_id === rootId
          ? { ...item, name: newName, path_cache: path, version: Number(item.version) + 1,
            updated_at: "2026-07-17T00:00:01.000Z" }
          : { ...item, path_cache: path, updated_at: "2026-07-17T00:00:01.000Z" };
      });
      return { rows: this.tree.filter(item => paths.has(String(item.resource_id))).map(item => ({ ...item })) };
    }
    if (sql.includes("gfs_audit")) return { rows: [] };
    if (sql.includes("gfs_blob_manifests")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }
}

class Audit implements AuditSink {
  calls: Array<{ event: AuditEvent; transactional: boolean; budget?: DeadlineBudget }> = [];
  async record(event: AuditEvent, queryable?: Queryable, budget?: DeadlineBudget): Promise<void> {
    this.calls.push({ event, transactional: queryable !== undefined, budget });
    if (queryable) await queryable.query("INSERT INTO gfs_audit DEFAULT VALUES");
  }
}

const blobs: BlobWriter = {
  writeImmutable: async () => ({ blobKey: "unused", bytes: 0, contentSha256: "" }),
  verify: async () => undefined, deleteByKey: async () => undefined, deleteLegacyFlat: async () => undefined,
};

function fixture(options: { ambiguity?: "full" | "zero" | "partial"; inspectUnavailable?: boolean } = {}) {
  const db = new Db(); const audit = new Audit();
  const snapshot = () => db.tree.map(item => ({ ...item }));
  let ambiguityThrown = false;
  const recoveryBudgets: Array<DeadlineBudget | undefined> = [];
  const tx: Transactor = { transaction: async (fn, budget) => {
    if (ambiguityThrown) recoveryBudgets.push(budget);
    if (ambiguityThrown && options.inspectUnavailable) throw new Error("inspection unavailable");
    const before = snapshot(); const value = await fn(db);
    if (options.ambiguity && !ambiguityThrown) {
      ambiguityThrown = true;
      if (options.ambiguity === "zero") db.tree = before;
      if (options.ambiguity === "partial") db.tree[1] = before[1];
      throw new CommitOutcomeUnknownError(new Error("commit response unavailable"));
    }
    return value;
  } };
  const writes = new GfsWriteService(tx, blobs, new PgBlobStagingStore(db));
  const input = { requestId: REQUEST, subject: "agent:test", audit, drive: "main",
    resourceId: TARGET, newName: "new", ifMatch: 4,
    maxObjects: 1000, deadlineAtMs: Date.now() + 30_000 };
  return { db, audit, tx, writes, input, recoveryBudgets };
}

describe("transactional rename publication", () => {
  it("renames root and subtree paths while preserving identity, parent, drive and blob", async () => {
    const f = fixture(); const beforeChild = { ...f.db.tree[1] };
    const renamed = await f.writes.rename(f.input);
    expect(renamed).toMatchObject({ resourceId: TARGET, parentResourceId: PARENT, drive: "main", name: "new", pathCache: "/docs/new", version: 5, updatedAt: "2026-07-17T00:00:01.000Z" });
    expect(f.db.tree[1]).toMatchObject({ resource_id: CHILD, parent_resource_id: TARGET, path_cache: "/docs/new/file.txt",
      version: beforeChild.version, blob_key: beforeChild.blob_key, content_sha256: beforeChild.content_sha256 });
    expect(f.audit.calls).toHaveLength(1);
    expect(f.audit.calls[0]).toMatchObject({ transactional: true, event: { op: "rename", mutationOutcome: "succeeded", resourceId: TARGET.replaceAll("-", "") } });
    const update = f.db.calls.findIndex(call => call.sql.includes("UPDATE gfs_resources"));
    const audit = f.db.calls.findIndex(call => call.sql.includes("gfs_audit"));
    expect(update).toBeLessThan(audit);
  });

  it("rejects a subtree above maxObjects with payload_too_large before any UPDATE", async () => {
    const f = fixture(); f.input.maxObjects = 1;
    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(f.db.calls.some(call => call.sql.includes("UPDATE gfs_resources"))).toBe(false);
    const load = f.db.calls.find(call => call.sql.includes("WITH RECURSIVE rename_tree"))!;
    expect(load.sql).toContain("LIMIT $3");
    expect(load.values[2]).toBe(2);
  });

  it("arms the publication transaction with the rename deadline", async () => {
    const budgets: Array<{ deadlineAtMs: number } | undefined> = [];
    const f = fixture();
    const spyTx: Transactor = { transaction: async (fn, budget) => {
      budgets.push(budget as { deadlineAtMs: number } | undefined);
      return f.tx.transaction(fn, budget);
    } };
    const writes = new GfsWriteService(spyTx, blobs, new PgBlobStagingStore(f.db));
    await expect(writes.rename(f.input)).resolves.toMatchObject({ name: "new" });
    expect(budgets[0]).toMatchObject({ deadlineAtMs: f.input.deadlineAtMs });
  });

  it("rejects collision and stale If-Match with definitive failed audit", async () => {
    const collision = fixture(); collision.db.collision = true;
    await expect(collision.writes.rename(collision.input)).rejects.toMatchObject({ code: "already_exists" });
    expect(collision.audit.calls.at(-1)).toMatchObject({ transactional: false, event: { mutationOutcome: "failed" } });
    const stale = fixture(); stale.input.ifMatch = 3;
    await expect(stale.writes.rename(stale.input)).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("rejects a concurrent subtree mutation after deterministic row locking", async () => {
    const f = fixture(); f.db.mutateSecondLoad = true;
    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(f.db.calls.find(call => call.sql.includes("FOR UPDATE"))?.values[0]).toEqual([PARENT, TARGET, CHILD].sort());
  });

  it("rejects a corrupt descendant path instead of propagating its prefix", async () => {
    const f = fixture(); f.db.tree[1].path_cache = "/docs/old/wrong/file.txt";
    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(f.db.calls.some(call => call.sql.includes("UPDATE gfs_resources"))).toBe(false);
  });

  it("renames the live tree without rewriting historical tombstoned descendants", async () => {
    const f = fixture();
    const deletedAt = new Date("2026-01-01T00:00:00.000Z");
    f.db.tree.push(record({ resource_id: TOMBSTONE, parent_resource_id: TARGET, name: "old.txt", kind: "file",
      path_cache: "/docs/old/old.txt", version: 2, deleted_at: deletedAt, depth: 1 }));

    await expect(f.writes.rename(f.input)).resolves.toMatchObject({ name: "new", pathCache: "/docs/new" });

    expect(f.db.tree.find(item => item.resource_id === TOMBSTONE)).toMatchObject({
      path_cache: "/docs/old/old.txt", version: 2, deleted_at: deletedAt,
    });
    const update = f.db.calls.find(call => call.sql.includes("UPDATE gfs_resources"))!;
    expect(JSON.parse(String(update.values[2]))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_id: TOMBSTONE }),
    ]));
    const load = f.db.calls.find(call => call.sql.includes("WITH RECURSIVE rename_tree"))!;
    expect(load.sql).toContain("WHERE depth = 0 OR deleted_at IS NULL");
  });

  it("rejects a corrupt live descendant reached through a tombstoned ancestor", async () => {
    const f = fixture();
    f.db.tree.push(
      record({ resource_id: TOMBSTONE, parent_resource_id: TARGET, name: "old", kind: "directory",
        path_cache: "/docs/old/old", deleted_at: new Date("2026-01-01T00:00:00.000Z"), depth: 1,
        under_tombstone: true }),
      record({ resource_id: HIDDEN_LIVE, parent_resource_id: TOMBSTONE, name: "live.txt", kind: "file",
        path_cache: "/docs/old/old/live.txt", depth: 2, under_tombstone: true }),
    );

    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(f.db.calls.some(call => call.sql.includes("UPDATE gfs_resources"))).toBe(false);
  });

  it("returns success when a fresh bounded read proves the full rename committed", async () => {
    const f = fixture({ ambiguity: "full" });
    await expect(f.writes.rename(f.input)).resolves.toMatchObject({ name: "new", pathCache: "/docs/new", version: 5 });
    expect(f.audit.calls).toHaveLength(1);
    expect(f.audit.calls[0]).toMatchObject({ transactional: true, event: { mutationOutcome: "succeeded" } });
    expect(f.recoveryBudgets).toHaveLength(1);
    expect(f.recoveryBudgets[0]).toMatchObject({ deadlineAtMs: expect.any(Number) });
    expect(f.recoveryBudgets[0]?.signal).toBeUndefined();
  });

  it("records a bounded failed outcome only when a fresh read proves zero mutation", async () => {
    const f = fixture({ ambiguity: "zero" });
    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(f.audit.calls.map(call => call.event.mutationOutcome)).toEqual(["succeeded", "failed"]);
    expect(f.audit.calls[1]).toMatchObject({ transactional: false, budget: { deadlineAtMs: expect.any(Number) } });
    expect(f.recoveryBudgets).toHaveLength(1);
  });

  it.each([
    { name: "partial state", options: { ambiguity: "partial" as const } },
    { name: "unqueryable state", options: { ambiguity: "full" as const, inspectUnavailable: true } },
  ])("keeps $name unknown without a fabricated failed outcome", async ({ options }) => {
    const f = fixture(options);
    await expect(f.writes.rename(f.input)).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(f.audit.calls).toHaveLength(1);
    expect(f.audit.calls[0]).toMatchObject({ transactional: true, event: { mutationOutcome: "succeeded" } });
    expect(f.recoveryBudgets).toHaveLength(1);
  });
});

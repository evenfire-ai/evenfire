import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditSink, Queryable } from "../authz/audit";
import { PgBlobStagingStore, type ManifestQueryable } from "./blobStaging";
import {
  GfsWriteService,
  PgTransactor,
  RollbackOutcomeUnknownError,
  type BlobWriter,
  type PoolLike,
  type Transactor,
  type TxClient,
} from "./writeStore";

const RESOURCE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARENT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROOT = "00000000-0000-0000-0000-000000000001";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource_id: RESOURCE,
    drive: "main",
    parent_resource_id: PARENT,
    name: "report.pdf",
    kind: "file",
    path_cache: "/docs/report.pdf",
    version: 1,
    bytes: 5,
    blob_key: null,
    content_sha256: null,
    deleted_at: null,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

class FakeClient implements TxClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  constructor(
    private readonly handlers: {
      parent?: () => Record<string, unknown>[];
      lock?: () => Record<string, unknown>[];
      insert?: (values: unknown[]) => Record<string, unknown>[];
      update?: (values: unknown[]) => Record<string, unknown>[];
      children?: () => Record<string, unknown>[];
      ancestors?: () => Record<string, unknown>[];
    }
  ) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("UPDATE gfs_blob_manifests") && sql.includes("'committed'")) {
      return { rows: [{ blob_key: values[0] }] };
    }
    if (sql.includes("INSERT INTO gfs_blob_manifests") || sql.includes("DELETE FROM gfs_blob_manifests")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO gfs_resources")) {
      return { rows: (this.handlers.insert ?? (() => []))(values) };
    }
    if (sql.includes("parent_resource_id = $2") && sql.includes("LIMIT 1")) {
      return { rows: (this.handlers.children ?? (() => []))() };
    }
    if (sql.includes("WITH RECURSIVE ancestor_chain")) {
      return { rows: (this.handlers.ancestors ?? this.handlers.parent ?? (() => []))() };
    }
    if (sql.includes("resource_id = ANY($1::uuid[])")) {
      return { rows: (values[0] as string[]).map(resource_id => ({ resource_id })) };
    }
    if (sql.includes("deleted_at IS NULL FOR UPDATE")) {
      return { rows: (this.handlers.parent ?? (() => []))() };
    }
    if (sql.includes("FOR UPDATE")) return { rows: (this.handlers.lock ?? (() => []))() };
    if (sql.includes("UPDATE gfs_resources")) {
      return { rows: (this.handlers.update ?? (() => []))(values) };
    }
    if (sql.includes("SELECT") && sql.includes("blob_key = $3")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }
}

class ManifestDb implements ManifestQueryable {
  calls: string[] = [];
  async query(sql: string) {
    this.calls.push(sql);
    return { rows: [] };
  }
}

class RecordingBlobs implements BlobWriter {
  writes: Array<{ resourceId: string; bytes: number }> = [];
  deletes: string[] = [];
  async writeImmutable(resourceId: string, generation: string, data: Buffer) {
    this.writes.push({ resourceId, bytes: data.length });
    return {
      blobKey: `${resourceId.replaceAll("-", "")}/${generation}`,
      bytes: data.length,
      contentSha256: createHash("sha256").update(data).digest("hex"),
    };
  }
  async verify(): Promise<void> {}
  async deleteByKey(blobKey: string): Promise<void> {
    this.deletes.push(blobKey);
  }
  async deleteLegacyFlat(resourceId: string): Promise<void> {
    this.deletes.push(resourceId);
  }
}

function service(client: FakeClient, blobs = new RecordingBlobs()): GfsWriteService {
  const tx: Transactor = { transaction: fn => fn(client) };
  return new GfsWriteService(tx, blobs, new PgBlobStagingStore(new ManifestDb()), {
    resourceId: () => RESOURCE,
    generation: () => GENERATION,
    requestId: () => REQUEST,
  });
}

class RecordingAudit implements AuditSink {
  calls: Array<{ event: AuditEvent; transactional: boolean }> = [];
  async record(event: AuditEvent, queryable?: Queryable): Promise<void> {
    this.calls.push({ event, transactional: queryable !== undefined });
  }
}

function parent(over: Record<string, unknown> = {}) {
  return row({ resource_id: PARENT, parent_resource_id: ROOT, name: "docs", kind: "directory", path_cache: "/docs", ...over });
}

function root(over: Record<string, unknown> = {}) {
  return row({ resource_id: ROOT, parent_resource_id: null, name: "", kind: "directory", path_cache: "/", ...over });
}

function parentChain(parentOver: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) {
  return [parent(parentOver), root(rootOver)];
}

describe("GfsWriteService.create legacy contract", () => {
  it("creates a file with stable path, bytes, generation and structure lock", async () => {
    const client = new FakeClient({
      ancestors: () => parentChain(),
      insert: values => [row({ name: values[3], path_cache: values[5], bytes: values[6], blob_key: values[7], content_sha256: values[8], version: 0 })],
    });
    const blobs = new RecordingBlobs();
    const created = await service(client, blobs).create({ drive: "main", parentId: PARENT, name: "new.txt", content: Buffer.from("hello") });
    expect(created).toMatchObject({ name: "new.txt", pathCache: "/docs/new.txt", version: 0, bytes: 5, updatedAt: "2026-01-01T00:00:00.000Z" });
    const insert = client.calls.find(call => call.sql.includes("INSERT INTO gfs_resources"))!;
    expect(insert.sql).toContain("updated_at");
    expect(insert.values.slice(1, 7)).toEqual(["main", PARENT, "new.txt", "file", "/docs/new.txt", 5]);
    expect(blobs.writes).toEqual([{ resourceId: RESOURCE, bytes: 5 }]);
    expect(client.calls[0].sql).toContain("hashtext('gfs:structure:' || $1)::bigint");
    const chainReads = client.calls.filter(call => call.sql.includes("WITH RECURSIVE ancestor_chain"));
    const rowLock = client.calls.find(call => call.sql.includes("resource_id = ANY($1::uuid[])"));
    expect(chainReads).toHaveLength(2);
    expect(rowLock?.values[0]).toEqual([ROOT, PARENT].sort());
  });

  it("creates a directory without a blob", async () => {
    const client = new FakeClient({ ancestors: () => parentChain(), insert: values => [row({ kind: "directory", name: values[3], bytes: 0, blob_key: null, content_sha256: null })] });
    const blobs = new RecordingBlobs();
    expect((await service(client, blobs).create({ drive: "main", parentId: PARENT, name: "nested", kind: "directory" })).kind).toBe("directory");
    expect(blobs.writes).toEqual([]);
  });

  it("rejects an absent parent", async () => {
    await expect(service(new FakeClient({ ancestors: () => [] })).create({ drive: "main", parentId: PARENT, name: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a file parent", async () => {
    await expect(service(new FakeClient({ ancestors: () => parentChain({ kind: "file" }) })).create({ drive: "main", parentId: PARENT, name: "x" })).rejects.toMatchObject({ code: "not_a_directory" });
  });

  it("normalizes a parent rid to UUID", async () => {
    const client = new FakeClient({ ancestors: () => parentChain(), insert: () => [row()] });
    await service(client).create({ drive: "main", parentId: PARENT.replaceAll("-", ""), name: "x" });
    expect(client.calls.find(call => call.sql.includes("INSERT INTO gfs_resources"))?.values[2]).toBe(PARENT);
  });

  it("maps duplicate siblings and cleans the unpublished generation", async () => {
    const client = new FakeClient({ ancestors: () => parentChain(), insert: () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); } });
    const blobs = new RecordingBlobs();
    await expect(service(client, blobs).create({ drive: "main", parentId: PARENT, name: "dupe", content: Buffer.from("x") })).rejects.toMatchObject({ code: "already_exists" });
    expect(blobs.deletes).toHaveLength(1);
  });

  it("rejects a tombstoned ancestor", async () => {
    const client = new FakeClient({ ancestors: () => parentChain({}, { deleted_at: new Date() }) });
    await expect(
      service(client).create({ drive: "main", parentId: PARENT, name: "x" })
    ).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("rejects a cyclic ancestor chain", async () => {
    const cycle = [
      parent(),
      root({ parent_resource_id: PARENT }),
      parent({ cycle: true }),
    ];
    const client = new FakeClient({ ancestors: () => cycle });
    await expect(
      service(client).create({ drive: "main", parentId: PARENT, name: "x" })
    ).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it.each([
    ["cross-drive", parentChain({}, { drive: "archive" })],
    ["missing", [parent()]],
    ["noncanonical-root", parentChain({}, { name: "orphan-root" })],
  ])("rejects a %s ancestor", async (_case, ancestors) => {
    const client = new FakeClient({ ancestors: () => ancestors });
    await expect(
      service(client).create({ drive: "main", parentId: PARENT, name: "x" })
    ).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("derives the child path from ancestor names, not a stale parent path cache", async () => {
    const client = new FakeClient({
      ancestors: () => parentChain({ path_cache: "/stale/location" }),
      insert: values => [row({ name: values[3], path_cache: values[5], version: 0 })],
    });
    const created = await service(client).create({ drive: "main", parentId: PARENT, name: "new.txt" });
    expect(created.pathCache).toBe("/docs/new.txt");
  });

  it("fails when the ancestor chain changes while its rows are being locked", async () => {
    let reads = 0;
    const client = new FakeClient({
      ancestors: () => (reads++ === 0 ? parentChain() : parentChain({ name: "renamed" })),
    });
    await expect(
      service(client).create({ drive: "main", parentId: PARENT, name: "x" })
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(client.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(false);
  });
});

describe("GfsWriteService.replace legacy contract", () => {
  it("bumps version and bytes under a resource row lock", async () => {
    const client = new FakeClient({ lock: () => [row({ version: 3 })], update: values => [row({ version: 4, bytes: values[2], blob_key: values[3], content_sha256: values[4] })] });
    const updated = await service(client).replace({ drive: "main", resourceId: RESOURCE, ifMatch: 3, content: Buffer.from("howdy") });
    expect(updated).toMatchObject({ resourceId: RESOURCE, version: 4, bytes: 5, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(client.calls.find(call => call.sql.includes("UPDATE gfs_resources"))?.sql).toContain("updated_at");
    expect(client.calls.some(call => call.sql.includes("'legacy_flat'"))).toBe(true);
  });

  it("rejects stale If-Match and cleans the staged generation", async () => {
    const blobs = new RecordingBlobs();
    await expect(service(new FakeClient({ lock: () => [row({ version: 7 })] }), blobs).replace({ drive: "main", resourceId: RESOURCE, ifMatch: 3, content: Buffer.from("x") })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(blobs.deletes).toHaveLength(1);
  });

  it.each([
    ["gone", [row({ deleted_at: new Date() })], "gone"],
    ["directory", [row({ kind: "directory" })], "is_a_directory"],
    ["missing", [], "not_found"],
  ])("maps %s targets", async (_name, rows, code) => {
    await expect(service(new FakeClient({ lock: () => rows as Record<string, unknown>[] })).replace({ drive: "main", resourceId: RESOURCE, ifMatch: 1, content: Buffer.alloc(0) })).rejects.toMatchObject({ code });
  });

  it("normalizes a target rid to UUID", async () => {
    const client = new FakeClient({ lock: () => [row()], update: values => [row({ version: 2, blob_key: values[3], content_sha256: values[4] })] });
    await service(client).replace({ drive: "main", resourceId: RESOURCE.replaceAll("-", ""), ifMatch: 1, content: Buffer.from("x") });
    expect(client.calls.find(call => call.sql.includes("FOR UPDATE"))?.values[1]).toBe(RESOURCE);
  });
});

describe("managed create and replace mutation outcomes", () => {
  const mutation = (audit: RecordingAudit) => ({ subject: "agent:test", requestId: REQUEST, audit });

  it("records create success inside the metadata transaction and a definitive failure afterwards", async () => {
    const successAudit = new RecordingAudit();
    const success = new FakeClient({ ancestors: () => parentChain(), insert: () => [row({ version: 0 })] });
    await service(success).create({ drive: "main", parentId: PARENT, name: "x", kind: "directory", mutation: mutation(successAudit) });
    expect(successAudit.calls).toEqual([expect.objectContaining({ transactional: true, event: expect.objectContaining({ op: "create", mutationOutcome: "succeeded" }) })]);

    const failureAudit = new RecordingAudit();
    await expect(service(new FakeClient({ ancestors: () => [] })).create({
      drive: "main", parentId: PARENT, name: "x", kind: "directory", mutation: mutation(failureAudit),
    })).rejects.toMatchObject({ code: "not_found" });
    expect(failureAudit.calls).toEqual([expect.objectContaining({ transactional: false, event: expect.objectContaining({ op: "create", mutationOutcome: "failed", outcome: "error" }) })]);
  });

  it("records replace success transactionally and stale-version failure only after rollback", async () => {
    const successAudit = new RecordingAudit();
    await service(new FakeClient({ lock: () => [row()], update: values => [row({ version: 2, bytes: values[2], blob_key: values[3], content_sha256: values[4] })] }))
      .replace({ drive: "main", resourceId: RESOURCE, ifMatch: 1, content: Buffer.from("x"), mutation: mutation(successAudit) });
    expect(successAudit.calls[0]).toMatchObject({ transactional: true, event: { op: "replace", mutationOutcome: "succeeded" } });

    const failureAudit = new RecordingAudit();
    await expect(service(new FakeClient({ lock: () => [row({ version: 9 })] })).replace({
      drive: "main", resourceId: RESOURCE, ifMatch: 1, content: Buffer.from("x"), mutation: mutation(failureAudit),
    })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(failureAudit.calls[0]).toMatchObject({ transactional: false, event: { op: "replace", mutationOutcome: "failed" } });
  });
});

describe("GfsWriteService.delete legacy contract", () => {
  it("soft-deletes a file without deleting bytes", async () => {
    const client = new FakeClient({ lock: () => [row({ version: 2 })], update: () => [] });
    const blobs = new RecordingBlobs();
    await service(client, blobs).delete({ drive: "main", resourceId: RESOURCE, ifMatch: 2 });
    expect(client.calls.find(call => call.sql.includes("UPDATE gfs_resources"))?.sql).toContain("deleted_at = now()");
    expect(blobs.deletes).toEqual([]);
  });

  it("refuses a non-empty directory", async () => {
    const client = new FakeClient({ lock: () => [row({ kind: "directory" })], children: () => [{ present: 1 }] });
    await expect(service(client).delete({ drive: "main", resourceId: RESOURCE, ifMatch: 1 })).rejects.toMatchObject({ code: "not_empty" });
  });

  it("rejects stale If-Match", async () => {
    await expect(service(new FakeClient({ lock: () => [row({ version: 9 })] })).delete({ drive: "main", resourceId: RESOURCE, ifMatch: 1 })).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("normalizes a target rid and shares the exact structure lock", async () => {
    const client = new FakeClient({ lock: () => [row({ version: 2 })], update: () => [] });
    await service(client).delete({ drive: "main", resourceId: RESOURCE.replaceAll("-", ""), ifMatch: 2 });
    expect(client.calls[0]).toMatchObject({ values: ["main"] });
    expect(client.calls.find(call => call.sql.includes("FOR UPDATE"))?.values[1]).toBe(RESOURCE);
  });
});

describe("PgTransactor legacy contract", () => {
  class FakePool implements PoolLike {
    queries: string[] = [];
    released = false;
    releaseError: Error | boolean | undefined;
    constructor(private readonly failAt?: string) {}
    async query() { return { rows: [] }; }
    async connect() {
      return {
        query: async (text: string) => { this.queries.push(text); if (this.failAt && text.includes(this.failAt)) throw new Error(`fail at ${text}`); return { rows: [] }; },
        release: (error?: Error | boolean) => { this.released = true; this.releaseError = error; },
      };
    }
  }

  it("runs BEGIN, callback, COMMIT and releases", async () => {
    const pool = new FakePool();
    expect(await new PgTransactor(pool).transaction(async client => { await client.query("SELECT 1"); return "done"; })).toBe("done");
    expect(pool.queries).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(pool.released).toBe(true);
  });

  it("rolls back and rethrows a callback failure", async () => {
    const pool = new FakePool();
    await expect(new PgTransactor(pool).transaction(async () => { throw new Error("write blew up"); })).rejects.toThrow("write blew up");
    expect(pool.queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(pool.released).toBe(true);
    expect(pool.releaseError).toBeUndefined();
  });

  it("destroys rather than reuses a client after COMMIT uncertainty", async () => {
    const pool = new FakePool("COMMIT");
    await expect(new PgTransactor(pool).transaction(async () => "done")).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(pool.releaseError).toBeInstanceOf(Error);
  });

  it("destroys rather than reuses a client when rollback itself fails", async () => {
    const pool = new FakePool("ROLLBACK");
    await expect(new PgTransactor(pool).transaction(async () => { throw new Error("write failed"); })).rejects.toBeInstanceOf(RollbackOutcomeUnknownError);
    expect(pool.releaseError).toBeInstanceOf(Error);
  });
});

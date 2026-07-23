import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore, BlobVerificationError, BlobWriteCleanupError } from "../storage/blobStore";
import { resolveBlobKeyPath } from "../storage/paths";
import { PgBlobStagingStore, type ManifestQueryable, type PublishedTreeRef } from "./blobStaging";
import { stageCopiedBlob } from "./copyBlobStaging";

const REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RID1 = "11111111-1111-4111-8111-111111111111";
const RID2 = "22222222-2222-4222-8222-222222222222";
const GEN1 = "33333333-3333-4333-8333-333333333333";
const GEN2 = "44444444-4444-4444-8444-444444444444";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const key = (rid: string, gen: string) => `${rid.replaceAll("-", "")}/${gen}`;
const published = (
  resourceId: string,
  blobKey: string | null,
  overrides: Partial<PublishedTreeRef> = {}
): PublishedTreeRef => ({
  resourceId,
  parentResourceId: null,
  name: "copied",
  kind: blobKey === null ? "directory" : "file",
  pathCache: "/copied",
  version: 1,
  bytes: blobKey === null ? 0n : 3n,
  blobKey,
  contentSha256: blobKey === null ? null : "a".repeat(64),
  ...overrides,
});
const dbRow = (item: PublishedTreeRef, overrides: Record<string, unknown> = {}) => ({
  resource_id: item.resourceId,
  drive: "main",
  parent_resource_id: item.parentResourceId,
  name: item.name,
  kind: item.kind,
  path_cache: item.pathCache,
  version: item.version,
  bytes: item.bytes.toString(),
  blob_key: item.blobKey,
  content_sha256: item.contentSha256,
  deleted_at: null,
  ...overrides,
});

class FakeDb implements ManifestQueryable {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  responses: Record<string, unknown>[][] = [];
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: this.responses.shift() ?? [] };
  }
  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "BEGIN READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config('statement_timeout'")) {
          this.calls.push({ sql, values });
          return { rows: [] };
        }
        return this.query(sql, values);
      },
      release: () => undefined,
    };
  }
}

describe("recursive copy blob staging", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gfs-copy-stage-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("stages every file under the caller's one common request id", async () => {
    const db = new FakeDb();
    const manifests = new PgBlobStagingStore(db);
    const blobs = new BlobStore(dir, "writer");
    for (const [destinationResourceId, generation, bytes] of [
      [RID1, GEN1, Buffer.from("one")],
      [RID2, GEN2, Buffer.from("two")],
    ] as const) {
      await stageCopiedBlob(manifests, blobs, {
        requestId: REQUEST,
        destinationResourceId,
        generation,
        source: { kind: "generation", stream: Readable.from(bytes) },
        expectedBytes: bytes.length,
        expectedSha256: digest(bytes),
        deadlineAtMs: Date.now() + 10_000,
      });
    }
    const inserts = db.calls.filter(call => call.sql.includes("INSERT INTO gfs_blob_manifests"));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(call => call.values[1])).toEqual([REQUEST, REQUEST]);
  });

  it("requires legacy preflight to reopen a fresh stream", async () => {
    const bytes = Buffer.from("legacy bytes");
    let reopens = 0;
    const result = await stageCopiedBlob(new PgBlobStagingStore(new FakeDb()), new BlobStore(dir, "writer"), {
      requestId: REQUEST,
      destinationResourceId: RID1,
      generation: GEN1,
      source: { kind: "legacy_flat", reopen: async () => { reopens += 1; return Readable.from(bytes); } },
      expectedBytes: bytes.length,
      expectedSha256: digest(bytes),
      deadlineAtMs: Date.now() + 10_000,
    });
    expect(reopens).toBe(1);
    expect(result.contentSha256).toBe(digest(bytes));
  });

  it.each([
    { expectedBytes: 99, expectedSha256: digest(Buffer.from("actual")) },
    { expectedBytes: 6, expectedSha256: "0".repeat(64) },
  ])("rejects source size/digest drift and durably cleans the candidate", async expected => {
    const db = new FakeDb();
    const physical = resolveBlobKeyPath(dir, key(RID1, GEN1));
    await expect(stageCopiedBlob(new PgBlobStagingStore(db), new BlobStore(dir, "writer"), {
      requestId: REQUEST,
      destinationResourceId: RID1,
      generation: GEN1,
      source: { kind: "generation", stream: Readable.from(Buffer.from("actual")) },
      ...expected,
      deadlineAtMs: Date.now() + 10_000,
    })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(existsSync(physical)).toBe(false);
    expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(true);
    expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(true);
  });

  it("retains the staged manifest when the physical write fails before returning", async () => {
    const db = new FakeDb();
    const blobs = new BlobStore(dir, "writer", async () => { throw new Error("sync failed"); });
    await expect(stageCopiedBlob(new PgBlobStagingStore(db), blobs, {
      requestId: REQUEST,
      destinationResourceId: RID1,
      generation: GEN1,
      source: { kind: "generation", stream: Readable.from(Buffer.from("actual")) },
      expectedBytes: 6,
      expectedSha256: digest(Buffer.from("actual")),
      deadlineAtMs: Date.now() + 10_000,
    })).rejects.toBeInstanceOf(BlobWriteCleanupError);
    expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(false);
    expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(false);
  });

  it.each(["generation write", "legacy reopen"] as const)(
    "never deletes a pre-existing recursive copy key after %s EIO",
    async failurePoint => {
      const bytes = Buffer.from("existing");
      const physicalStore = new BlobStore(dir, "writer");
      await physicalStore.writeImmutable(RID1, GEN1, bytes);
      const db = new FakeDb();
      let deletes = 0;
      let writes = 0;
      const eio = Object.assign(new Error("open failed"), { code: "EIO" });
      const blobs = {
        writeImmutable: async () => {
          writes += 1;
          throw eio;
        },
        verify: async () => undefined,
        deleteByKey: async (blobKey: string) => {
          deletes += 1;
          await physicalStore.deleteByKey(blobKey);
        },
        deleteLegacyFlat: async () => undefined,
      };
      const source = failurePoint === "generation write"
        ? { kind: "generation" as const, stream: Readable.from(bytes) }
        : { kind: "legacy_flat" as const, reopen: async () => { throw eio; } };

      await expect(stageCopiedBlob(new PgBlobStagingStore(db), blobs, {
        requestId: REQUEST,
        destinationResourceId: RID1,
        generation: GEN1,
        source,
        expectedBytes: bytes.length,
        expectedSha256: digest(bytes),
        deadlineAtMs: Date.now() + 10_000,
      })).rejects.toMatchObject({ code: "EIO" });
      expect(writes).toBe(failurePoint === "generation write" ? 1 : 0);
      expect(deletes).toBe(0);
      expect(existsSync(resolveBlobKeyPath(dir, key(RID1, GEN1)))).toBe(true);
      expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(false);
      expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(false);
    }
  );

  it.each([false, true])(
    "durably handles an owned recursive copy candidate when cleanup failure is %s",
    async cleanupFails => {
      const bytes = Buffer.from("actual");
      const db = new FakeDb();
      let deletes = 0;
      await expect(stageCopiedBlob(new PgBlobStagingStore(db), {
        writeImmutable: async () => ({ blobKey: key(RID1, GEN1), bytes: bytes.length, contentSha256: digest(bytes) }),
        verify: async () => { throw new BlobVerificationError(); },
        deleteByKey: async () => {
          deletes += 1;
          if (cleanupFails) throw new Error("cleanup failed");
        },
        deleteLegacyFlat: async () => undefined,
      }, {
        requestId: REQUEST,
        destinationResourceId: RID1,
        generation: GEN1,
        source: { kind: "generation", stream: Readable.from(bytes) },
        expectedBytes: bytes.length,
        expectedSha256: digest(bytes),
        deadlineAtMs: Date.now() + 10_000,
      })).rejects.toMatchObject({ code: "precondition_failed" });
      expect(deletes).toBe(1);
      expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(true);
      expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(!cleanupFails);
    }
  );

  it("propagates abort without an unmanifested or partial destination", async () => {
    const db = new FakeDb();
    const controller = new AbortController();
    const stream = Readable.from((async function* () {
      yield Buffer.from("a");
      controller.abort();
      yield Buffer.from("b");
    })());
    await expect(stageCopiedBlob(new PgBlobStagingStore(db), new BlobStore(dir, "writer"), {
      requestId: REQUEST,
      destinationResourceId: RID1,
      generation: GEN1,
      source: { kind: "generation", stream },
      expectedBytes: 2,
      expectedSha256: digest(Buffer.from("ab")),
      deadlineAtMs: Date.now() + 10_000,
      signal: controller.signal,
    })).rejects.toThrow();
    expect(db.calls.some(call => call.sql.includes("INSERT INTO gfs_blob_manifests"))).toBe(true);
    expect(existsSync(resolveBlobKeyPath(dir, key(RID1, GEN1)))).toBe(false);
  });

  it("fails an expired operation before reserving a manifest", async () => {
    const db = new FakeDb();
    await expect(stageCopiedBlob(new PgBlobStagingStore(db), new BlobStore(dir, "writer"), {
      requestId: REQUEST,
      destinationResourceId: RID1,
      generation: GEN1,
      source: { kind: "generation", stream: Readable.from(Buffer.from("x")) },
      expectedBytes: 1,
      expectedSha256: digest(Buffer.from("x")),
      deadlineAtMs: 10,
      now: () => 10,
    })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(db.calls).toEqual([]);
  });
});

describe("tree manifest publication", () => {
  it("marks and removes the exact complete candidate set", async () => {
    const db = new FakeDb();
    const keys = [key(RID1, GEN1), key(RID2, GEN2)];
    db.responses.push(keys.map(blob_key => ({ blob_key })), keys.map(blob_key => ({ blob_key })));
    const store = new PgBlobStagingStore(db);
    await store.markCommittedMany(db, REQUEST, keys);
    await store.removeCommittedMany(REQUEST, keys);
    expect(db.calls[0].values).toEqual([REQUEST, keys]);
    expect(db.calls[1].values).toEqual([REQUEST, keys]);
    expect(db.calls[0].sql).toContain("request_id = $1");
    expect(db.calls[1].sql).toContain("request_id = $1");
  });

  it("rejects a missing second/last file instead of accepting partial publication", async () => {
    const db = new FakeDb();
    const first = published(RID1, key(RID1, GEN1));
    const second = published(RID2, key(RID2, GEN2));
    db.responses.push([dbRow(first)]);
    const result = await new PgBlobStagingStore(db).resolvePublishedTree("main", [
      first,
      second,
    ]);
    expect(result).toBeNull();
  });

  it("requires directories as well as files for an exact published tree", async () => {
    const db = new FakeDb();
    const directory = published(RID1, null);
    const file = published(RID2, key(RID2, GEN2), { parentResourceId: RID1, pathCache: "/copied/file", name: "file" });
    db.responses.push([dbRow(directory), dbRow(file)]);
    const result = await new PgBlobStagingStore(db).resolvePublishedTree("main", [directory, file]);
    expect(result).toHaveLength(2);
    expect(db.calls[0].values).toEqual(["main", [RID1, RID2]]);
  });

  it.each([
    ["resourceId", { resource_id: RID2 }],
    ["parentResourceId", { parent_resource_id: RID2 }],
    ["name", { name: "wrong" }],
    ["kind", { kind: "directory" }],
    ["pathCache", { path_cache: "/wrong" }],
    ["version", { version: 2 }],
    ["bytes", { bytes: "4" }],
    ["blobKey", { blob_key: key(RID2, GEN2) }],
    ["contentSha256", { content_sha256: "b".repeat(64) }],
  ])("rejects ambiguous publication when %s differs", async (_field, mismatch) => {
    const db = new FakeDb();
    const expected = published(RID1, key(RID1, GEN1));
    db.responses.push([dbRow(expected, mismatch)]);
    await expect(new PgBlobStagingStore(db).resolvePublishedTree("main", [expected])).resolves.toBeNull();
  });

  it("does not mark a same-key manifest belonging to another request", async () => {
    const db = new FakeDb();
    const keys = [key(RID1, GEN1), key(RID2, GEN2)];
    db.responses.push([{ blob_key: keys[0] }]);
    await expect(new PgBlobStagingStore(db).markCommittedMany(db, REQUEST, keys))
      .rejects.toThrow("manifest set is incomplete");
    expect(db.calls[0].values).toEqual([REQUEST, keys]);
  });

  it("does not silently remove only part of a committed manifest set", async () => {
    const db = new FakeDb();
    db.responses.push([{ blob_key: key(RID1, GEN1) }]);
    await expect(new PgBlobStagingStore(db).removeCommittedMany(REQUEST, [
      key(RID1, GEN1), key(RID2, GEN2),
    ])).rejects.toThrow("manifest set is incomplete");
    expect(db.calls[0].values[0]).toBe(REQUEST);
  });
});

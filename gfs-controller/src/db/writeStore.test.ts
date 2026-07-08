import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BlobWriter,
  GfsWriteService,
  PgTransactor,
  PoolLike,
  Transactor,
  TxClient,
} from "./writeStore";

/** A pg row as returned for a gfs_resources SELECT/RETURNING. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    drive: "main",
    parent_resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "report.pdf",
    kind: "file",
    path_cache: "/docs/report.pdf",
    version: 1,
    bytes: 5,
    deleted_at: null,
    ...over,
  };
}

/**
 * A fake TxClient routed by SQL shape. Each handler returns the rows for that
 * query; an unhandled query throws (a write that issues an unexpected query
 * fails loud). `calls` records every (sql, values) for order assertions.
 */
class FakeClient implements TxClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  constructor(
    private readonly handlers: {
      select?: () => Record<string, unknown>[]; // liveResource (no FOR UPDATE)
      lock?: () => Record<string, unknown>[]; // SELECT … FOR UPDATE
      insert?: () => Record<string, unknown>[]; // INSERT … RETURNING (may throw)
      update?: () => Record<string, unknown>[]; // UPDATE … version / deleted_at
      children?: () => Record<string, unknown>[]; // child existence probe
    }
  ) {}
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO gfs_resources")) return { rows: (this.handlers.insert ?? (() => []))() };
    if (sql.includes("FOR UPDATE")) return { rows: (this.handlers.lock ?? (() => []))() };
    if (sql.includes("parent_resource_id = $2 AND deleted_at IS NULL LIMIT 1"))
      return { rows: (this.handlers.children ?? (() => []))() };
    if (sql.includes("UPDATE gfs_resources")) return { rows: (this.handlers.update ?? (() => []))() };
    if (sql.includes("SELECT")) return { rows: (this.handlers.select ?? (() => []))() };
    throw new Error(`unexpected query: ${sql}`);
  }
}

function fakeTx(client: TxClient): Transactor {
  return { transaction: (fn) => fn(client) };
}

class RecordingBlobs implements BlobWriter {
  writes: Array<{ resourceId: string; bytes: number }> = [];
  shouldThrow = false;
  async write(resourceId: string, data: Readable | Buffer): Promise<{ bytes: number }> {
    if (this.shouldThrow) throw new Error("blob write failed");
    const bytes = Buffer.isBuffer(data) ? data.length : 0;
    this.writes.push({ resourceId, bytes });
    return { bytes };
  }
}

describe("GfsWriteService.create", () => {
  it("inserts a file under a live directory parent and writes its blob", async () => {
    const client = new FakeClient({
      select: () => [row({ kind: "directory", path_cache: "/docs", resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })],
      insert: () => [row({ name: "new.txt", path_cache: "/docs/new.txt", version: 0, bytes: 5 })],
    });
    const blobs = new RecordingBlobs();
    const svc = new GfsWriteService(fakeTx(client), blobs);

    const created = await svc.create({
      drive: "main",
      parentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "new.txt",
      content: Buffer.from("hello"),
    });

    expect(created.name).toBe("new.txt");
    expect(created.version).toBe(0);
    // path_cache computed from the parent, and the INSERT carried the byte count.
    const insert = client.calls.find((c) => c.sql.includes("INSERT"))!;
    expect(insert.values).toEqual(["main", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "new.txt", "file", "/docs/new.txt", 5]);
    // Blob written for the RETURNED resource id.
    expect(blobs.writes).toEqual([{ resourceId: created.resourceId, bytes: 5 }]);
  });

  it("inserts a directory without writing a blob", async () => {
    const client = new FakeClient({
      select: () => [row({ kind: "directory", path_cache: "/docs", resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })],
      insert: () => [row({ name: "nested", kind: "directory", path_cache: "/docs/nested", version: 0, bytes: 0 })],
    });
    const blobs = new RecordingBlobs();
    const svc = new GfsWriteService(fakeTx(client), blobs);

    const created = await svc.create({
      drive: "main",
      parentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "nested",
      kind: "directory",
    });

    expect(created.kind).toBe("directory");
    const insert = client.calls.find((c) => c.sql.includes("INSERT"))!;
    expect(insert.values).toEqual(["main", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "nested", "directory", "/docs/nested", 0]);
    expect(blobs.writes).toEqual([]);
  });

  it("rejects a create whose parent does not exist (not_found)", async () => {
    const svc = new GfsWriteService(fakeTx(new FakeClient({ select: () => [] })), new RecordingBlobs());
    await expect(
      svc.create({
        drive: "main",
        parentId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        name: "x",
        content: Buffer.alloc(0),
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a create under a FILE parent (not_a_directory)", async () => {
    const client = new FakeClient({ select: () => [row({ kind: "file" })] });
    const svc = new GfsWriteService(fakeTx(client), new RecordingBlobs());
    await expect(
      svc.create({
        drive: "main",
        parentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "y",
        content: Buffer.alloc(0),
      })
    ).rejects.toMatchObject({ code: "not_a_directory" });
  });

  it("accepts a parent rid and inserts with the UUID parent id", async () => {
    const client = new FakeClient({
      select: () => [
        row({ kind: "directory", path_cache: "/docs", resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
      ],
      insert: () => [row({ name: "new.txt", path_cache: "/docs/new.txt", version: 0, bytes: 5 })],
    });
    const svc = new GfsWriteService(fakeTx(client), new RecordingBlobs());

    await svc.create({
      drive: "main",
      parentId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "new.txt",
      content: Buffer.from("hello"),
    });

    const insert = client.calls.find((c) => c.sql.includes("INSERT"))!;
    expect(insert.values[1]).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("maps a duplicate sibling name (unique_violation 23505) to already_exists", async () => {
    const client = new FakeClient({
      select: () => [row({ kind: "directory", path_cache: "/docs" })],
      insert: () => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      },
    });
    const svc = new GfsWriteService(fakeTx(client), new RecordingBlobs());
    await expect(
      svc.create({
        drive: "main",
        parentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "dupe",
        content: Buffer.alloc(0),
      })
    ).rejects.toMatchObject({ code: "already_exists" });
  });

  it("does NOT write a blob when the INSERT fails (no orphan on a rejected create)", async () => {
    const client = new FakeClient({
      select: () => [row({ kind: "directory" })],
      insert: () => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      },
    });
    const blobs = new RecordingBlobs();
    await expect(
      new GfsWriteService(fakeTx(client), blobs).create({
        drive: "main",
        parentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "dupe",
        content: Buffer.from("data"),
      })
    ).rejects.toThrow();
    expect(blobs.writes).toEqual([]); // insert threw before the blob write
  });
});

describe("GfsWriteService.replace", () => {
  it("bumps version and bytes, overwriting the blob under the row lock", async () => {
    const client = new FakeClient({
      lock: () => [row({ version: 3, kind: "file" })],
      update: () => [row({ version: 4, bytes: 5 })],
    });
    const blobs = new RecordingBlobs();
    const svc = new GfsWriteService(fakeTx(client), blobs);

    const updated = await svc.replace({
      drive: "main",
      resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ifMatch: 3,
      content: Buffer.from("howdy"),
    });

    expect(updated.version).toBe(4);
    expect(blobs.writes).toHaveLength(1);
    // Blob write precedes the metadata UPDATE (ordering under the lock).
    const blobIdx = client.calls.findIndex((c) => c.sql.includes("FOR UPDATE"));
    const updateIdx = client.calls.findIndex((c) => c.sql.includes("UPDATE gfs_resources"));
    expect(blobIdx).toBeLessThan(updateIdx);
  });

  it("rejects a stale If-Match (precondition_failed) and writes NO blob", async () => {
    const client = new FakeClient({ lock: () => [row({ version: 7, kind: "file" })] });
    const blobs = new RecordingBlobs();
    await expect(
      new GfsWriteService(fakeTx(client), blobs).replace({
        drive: "main",
        resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        ifMatch: 3, // != 7
        content: Buffer.from("x"),
      })
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(blobs.writes).toEqual([]);
  });

  it("maps a tombstoned target to gone, a directory to is_a_directory, a miss to not_found", async () => {
    const gone = new GfsWriteService(
      fakeTx(new FakeClient({ lock: () => [row({ deleted_at: new Date() })] })),
      new RecordingBlobs()
    );
    await expect(gone.replace({ drive: "main", resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ifMatch: 1, content: Buffer.alloc(0) })).rejects.toMatchObject({
      code: "gone",
    });

    const dir = new GfsWriteService(
      fakeTx(new FakeClient({ lock: () => [row({ kind: "directory" })] })),
      new RecordingBlobs()
    );
    await expect(dir.replace({ drive: "main", resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ifMatch: 1, content: Buffer.alloc(0) })).rejects.toMatchObject({
      code: "is_a_directory",
    });

    const miss = new GfsWriteService(fakeTx(new FakeClient({ lock: () => [] })), new RecordingBlobs());
    await expect(miss.replace({ drive: "main", resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ifMatch: 1, content: Buffer.alloc(0) })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("accepts a target rid and locks/updates with the UUID resource id", async () => {
    const client = new FakeClient({
      lock: () => [row({ version: 3, kind: "file" })],
      update: () => [row({ version: 4, bytes: 5 })],
    });
    const svc = new GfsWriteService(fakeTx(client), new RecordingBlobs());

    await svc.replace({
      drive: "main",
      resourceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ifMatch: 3,
      content: Buffer.from("howdy"),
    });

    expect(client.calls.find((c) => c.sql.includes("FOR UPDATE"))?.values[1]).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
    expect(client.calls.find((c) => c.sql.includes("UPDATE gfs_resources"))?.values[1]).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
  });
});

describe("GfsWriteService.delete", () => {
  it("soft-deletes a file (sets deleted_at) without removing the blob", async () => {
    const client = new FakeClient({
      lock: () => [row({ version: 2, kind: "file" })],
      update: () => [],
    });
    const blobs = new RecordingBlobs();
    await new GfsWriteService(fakeTx(client), blobs).delete({
      drive: "main",
      resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ifMatch: 2,
    });

    const update = client.calls.find((c) => c.sql.includes("UPDATE gfs_resources"))!;
    expect(update.sql).toContain("deleted_at = now()");
    expect(blobs.writes).toEqual([]); // soft delete retains bytes
  });

  it("refuses to delete a non-empty directory (not_empty)", async () => {
    const client = new FakeClient({
      lock: () => [row({ kind: "directory" })],
      children: () => [{ "?column?": 1 }], // a live child exists
    });
    await expect(
      new GfsWriteService(fakeTx(client), new RecordingBlobs()).delete({
        drive: "main",
        resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        ifMatch: 1,
      })
    ).rejects.toMatchObject({ code: "not_empty" });
  });

  it("rejects a stale If-Match (precondition_failed)", async () => {
    const client = new FakeClient({ lock: () => [row({ version: 9, kind: "file" })] });
    await expect(
      new GfsWriteService(fakeTx(client), new RecordingBlobs()).delete({
        drive: "main",
        resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        ifMatch: 1,
      })
    ).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("accepts a target rid and deletes with the UUID resource id", async () => {
    const client = new FakeClient({
      lock: () => [row({ version: 2, kind: "file" })],
      update: () => [],
    });

    await new GfsWriteService(fakeTx(client), new RecordingBlobs()).delete({
      drive: "main",
      resourceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ifMatch: 2,
    });

    expect(client.calls.find((c) => c.sql.includes("FOR UPDATE"))?.values[1]).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
    expect(client.calls.find((c) => c.sql.includes("UPDATE gfs_resources"))?.values[1]).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
  });
});

describe("PgTransactor", () => {
  class FakePool implements PoolLike {
    queries: string[] = [];
    released = false;
    constructor(private readonly behavior: { failAt?: string } = {}) {}
    async connect() {
      const queries = this.queries;
      const behavior = this.behavior;
      const self = this;
      return {
        async query(text: string) {
          queries.push(text);
          if (behavior.failAt && text.includes(behavior.failAt)) throw new Error(`fail at ${text}`);
          return { rows: [] };
        },
        release() {
          self.released = true;
        },
      };
    }
  }

  it("BEGIN → fn → COMMIT and releases the client", async () => {
    const pool = new FakePool();
    const out = await new PgTransactor(pool).transaction(async (c) => {
      await c.query("SELECT 1");
      return "done";
    });
    expect(out).toBe("done");
    expect(pool.queries[0]).toBe("BEGIN");
    expect(pool.queries.at(-1)).toBe("COMMIT");
    expect(pool.released).toBe(true);
  });

  it("ROLLBACKs and rethrows when fn throws — never a silent COMMIT", async () => {
    const pool = new FakePool();
    await expect(
      new PgTransactor(pool).transaction(async () => {
        throw new Error("write blew up");
      })
    ).rejects.toThrow("write blew up");
    expect(pool.queries).toContain("ROLLBACK");
    expect(pool.queries).not.toContain("COMMIT");
    expect(pool.released).toBe(true);
  });
});

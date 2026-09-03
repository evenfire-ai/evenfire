import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBlobStagingStore } from "./blobStaging";
import {
  CommitOutcomeUnknownError,
  GfsWriteService,
  PgTransactor,
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

class FakeDb implements TxClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  manifests = new Map<string, "staged" | "committed" | "deleting">();
  removedCommitted: string[] = [];
  current = row();
  published: Record<string, unknown> | null = null;
  exposePublished = false;
  parent = row({ resource_id: PARENT, parent_resource_id: ROOT, name: "docs", kind: "directory", path_cache: "/docs" });
  root = row({ resource_id: ROOT, parent_resource_id: null, name: "", kind: "directory", path_cache: "/" });
  children: Record<string, unknown>[] = [];
  duplicate = false;
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO gfs_blob_manifests") && sql.includes("'staged'")) {
      this.manifests.set(String(values[0]), "staged");
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO gfs_blob_manifests") && sql.includes("'deleting'")) {
      this.manifests.set(String(values[0]), "deleting");
      return { rows: [] };
    }
    if (sql.includes("UPDATE gfs_blob_manifests") && sql.includes("'committed'")) {
      this.manifests.set(String(values[0]), "committed");
      return { rows: [{ blob_key: values[0] }] };
    }
    if (sql.includes("DELETE FROM gfs_blob_manifests") && sql.includes("state = 'committed'")) {
      const blobKey = String(values[0]);
      this.manifests.delete(blobKey);
      this.removedCommitted.push(blobKey);
      return { rows: [] };
    }
    if (sql.includes("UPDATE gfs_blob_manifests") || sql.includes("DELETE FROM gfs_blob_manifests")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT resource_id") && sql.includes("blob_key = $3")) {
      const published = this.published;
      const rows: Record<string, unknown>[] = [];
      if (this.exposePublished && published && published.blob_key === values[2]) {
        rows.push(published);
      }
      return { rows };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("parent_resource_id = $2") && sql.includes("LIMIT 1")) {
      return { rows: this.children };
    }
    if (sql.includes("WITH RECURSIVE ancestor_chain")) {
      return { rows: [this.parent, this.root] };
    }
    if (sql.includes("resource_id = ANY($1::uuid[])")) {
      return { rows: (values[0] as string[]).map(resource_id => ({ resource_id })) };
    }
    if (sql.includes("SELECT") && sql.includes("FOR UPDATE")) return { rows: [this.current] };
    if (sql.includes("INSERT INTO gfs_resources")) {
      if (this.duplicate) throw Object.assign(new Error("duplicate"), { code: "23505" });
      this.published = row({
        resource_id: values[0],
        name: values[3],
        kind: values[4],
        path_cache: values[5],
        bytes: values[6],
        blob_key: values[7],
        content_sha256: values[8],
        version: 0,
      });
      return { rows: [this.published] };
    }
    if (sql.includes("UPDATE gfs_resources") && sql.includes("version = version + 1")) {
      this.current = row({
        ...this.current,
        version: Number(this.current.version) + 1,
        bytes: values[2],
        blob_key: values[3],
        content_sha256: values[4],
      });
      this.published = this.current;
      return { rows: [this.current] };
    }
    if (sql.includes("UPDATE gfs_resources")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }

  snapshot() {
    return {
      current: { ...this.current },
      published: this.published && { ...this.published },
      manifests: new Map(this.manifests),
    };
  }

  restore(snapshot: ReturnType<FakeDb["snapshot"]>): void {
    this.current = snapshot.current;
    this.published = snapshot.published;
    this.manifests = snapshot.manifests;
  }
}

class RecordingBlobs implements BlobWriter {
  writes: string[] = [];
  deletes: string[] = [];
  async writeImmutable(resourceId: string, generation: string, data: Buffer) {
    const blobKey = `${resourceId.replaceAll("-", "")}/${generation}`;
    this.writes.push(blobKey);
    return {
      blobKey,
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

function service(
  db: FakeDb,
  blobs = new RecordingBlobs(),
  tx: Transactor = { transaction: fn => fn(db) }
): GfsWriteService {
  return new GfsWriteService(tx, blobs, new PgBlobStagingStore(db), {
    resourceId: () => RESOURCE,
    generation: () => GENERATION,
    requestId: () => REQUEST,
  });
}

function unknownCommitService(
  db: FakeDb,
  blobs: RecordingBlobs,
  commitBecameVisible: boolean
): { writes: GfsWriteService; outcome: CommitOutcomeUnknownError } {
  const outcome = new CommitOutcomeUnknownError(new Error("COMMIT response lost"));
  const tx: Transactor = {
    transaction: async fn => {
      const snapshot = db.snapshot();
      await fn(db);
      if (!commitBecameVisible) db.restore(snapshot);
      db.exposePublished = commitBecameVisible;
      throw outcome;
    },
  };
  return { writes: service(db, blobs, tx), outcome };
}

describe("generation-backed create", () => {
  it("reserves a manifest before writing and publishes pointer+digest atomically", async () => {
    const db = new FakeDb();
    const blobs = new RecordingBlobs();
    const created = await service(db, blobs).create({
      drive: "main",
      parentId: PARENT,
      name: "new.txt",
      content: Buffer.from("hello"),
    });
    expect(created.blobKey).toBe(`${RESOURCE.replaceAll("-", "")}/${GENERATION}`);
    const manifest = db.calls.findIndex(call => call.sql.includes("INSERT INTO gfs_blob_manifests"));
    const publish = db.calls.findIndex(call => call.sql.includes("INSERT INTO gfs_resources"));
    expect(manifest).toBeLessThan(publish);
    expect(
      db.calls.some(
        call =>
          call.sql.includes("hashtext('gfs:structure:' || $1)::bigint") &&
          call.values[0] === "main"
      )
    ).toBe(true);
    expect(blobs.writes).toHaveLength(1);
  });

  it("uses the same structure lock as directory deletion", async () => {
    const db = new FakeDb();
    await service(db).delete({ drive: "main", resourceId: RESOURCE, ifMatch: 1 });
    expect(db.calls[0]).toMatchObject({ values: ["main"] });
    expect(db.calls[0].sql).toContain("hashtext('gfs:structure:' || $1)::bigint");
    expect(db.calls.find(call => call.sql.includes("FOR UPDATE"))).toBeDefined();
  });
});

describe("generation-backed replace", () => {
  it("keeps external identity, increments version, and selects only the verified generation", async () => {
    const db = new FakeDb();
    const updated = await service(db).replace({
      drive: "main",
      resourceId: RESOURCE,
      ifMatch: 1,
      content: Buffer.from("new bytes"),
    });
    expect(updated.resourceId).toBe(RESOURCE);
    expect(updated.version).toBe(2);
    expect(updated.blobKey).toContain(GENERATION);
    const update = db.calls.find(call => call.sql.includes("UPDATE gfs_resources"))!;
    expect(update.sql).toContain("content_sha256 = $5");
  });

  it("cleans a staged generation after a definite stale-version rollback", async () => {
    const db = new FakeDb();
    db.current = row({ version: 9 });
    const blobs = new RecordingBlobs();
    await expect(
      service(db, blobs).replace({
        drive: "main",
        resourceId: RESOURCE,
        ifMatch: 1,
        content: Buffer.from("x"),
      })
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(blobs.deletes).toHaveLength(1);
  });

  it("lazily replaces a legacy flat blob and schedules it for verified cleanup", async () => {
    const db = new FakeDb();
    db.current = row({ blob_key: null, content_sha256: null, bytes: 5 });
    const blobs = new RecordingBlobs();

    const updated = await service(db, blobs).replace({
      drive: "main",
      resourceId: RESOURCE,
      ifMatch: 1,
      content: Buffer.from("new bytes"),
    });

    expect(updated.blobKey).toBe(`${RESOURCE.replaceAll("-", "")}/${GENERATION}`);
    const legacyCleanup = db.calls.find(
      call => call.sql.includes("INSERT INTO gfs_blob_manifests") && call.sql.includes("'legacy_flat'")
    );
    expect(legacyCleanup?.values).toEqual([RESOURCE.replaceAll("-", ""), RESOURCE, 5]);
    expect(blobs.deletes).toEqual([]);
  });
});

describe.each([
  {
    operation: "create",
    invoke: (writes: GfsWriteService) =>
      writes.create({
        drive: "main",
        parentId: PARENT,
        name: "new.txt",
        content: Buffer.from("new"),
      }),
    committedVersion: 0,
  },
  {
    operation: "replace",
    invoke: (writes: GfsWriteService) =>
      writes.replace({
        drive: "main",
        resourceId: RESOURCE,
        ifMatch: 1,
        content: Buffer.from("new"),
      }),
    committedVersion: 2,
  },
])("ambiguous COMMIT recovery for $operation", ({ invoke, committedVersion }) => {
  const candidate = `${RESOURCE.replaceAll("-", "")}/${GENERATION}`;

  it("returns the committed row and removes only its committed manifest after response loss", async () => {
    const db = new FakeDb();
    const blobs = new RecordingBlobs();
    const { writes } = unknownCommitService(db, blobs, true);

    const committed = await invoke(writes);

    expect(committed).toMatchObject({ blobKey: candidate, version: committedVersion });
    expect(db.removedCommitted).toContain(candidate);
    expect(db.manifests.has(candidate)).toBe(false);
    expect(blobs.deletes).toEqual([]);
  });

  it("rethrows and retains the staged candidate when rollback remains the observable outcome", async () => {
    const db = new FakeDb();
    const blobs = new RecordingBlobs();
    const { writes, outcome } = unknownCommitService(db, blobs, false);

    await expect(invoke(writes)).rejects.toBe(outcome);

    expect(db.removedCommitted).not.toContain(candidate);
    expect(db.manifests.get(candidate)).toBe("staged");
    expect(blobs.writes).toContain(candidate);
    expect(blobs.deletes).toEqual([]);
  });
});

describe("PgTransactor", () => {
  class FakePool implements PoolLike {
    queries: string[] = [];
    async query() {
      return { rows: [] };
    }
    async connect() {
      return {
        query: async (text: string) => {
          this.queries.push(text);
          if (text === "COMMIT") throw new Error("connection lost after commit send");
          return { rows: [] };
        },
        release: () => undefined,
      };
    }
  }

  it("classifies a lost COMMIT response as unknown instead of a definite rollback", async () => {
    const pool = new FakePool();
    await expect(new PgTransactor(pool).transaction(async () => "done")).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError
    );
    expect(pool.queries).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });
});

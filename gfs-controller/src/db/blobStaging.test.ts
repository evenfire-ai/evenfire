import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GfsMetrics } from "../metrics";
import {
  PgBlobStagingStore,
  reconcileExpiredBlobs,
  stageVerifiedBlob,
  type ManifestQueryable,
} from "./blobStaging";

class FakeDb implements ManifestQueryable {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  responses: Record<string, unknown>[][] = [];
  failReferenceProbe = false;
  failOrphanResample = false;
  orphanSamples = 0;
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("count(*)::bigint")) {
      this.orphanSamples += 1;
      if (this.failOrphanResample && this.orphanSamples > 1) {
        throw new Error("resample unavailable");
      }
    }
    if (this.failReferenceProbe && sql.includes("UPDATE gfs_blob_manifests AS manifest")) {
      throw new Error("db unavailable");
    }
    return { rows: this.responses.shift() ?? [] };
  }
}

const CANDIDATE = {
  blob_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/11111111-1111-4111-8111-111111111111",
  request_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  candidate_kind: "generation",
  content_sha256: "a".repeat(64),
  bytes: "7",
  state: "staged",
};

describe("PgBlobStagingStore", () => {
  it("records candidates as staged and commits them only in the caller transaction", async () => {
    const db = new FakeDb();
    const store = new PgBlobStagingStore(db);
    await store.recordStaged({
      blobKey: String(CANDIDATE.blob_key),
      requestId: String(CANDIDATE.request_id),
      resourceId: String(CANDIDATE.resource_id),
      candidateKind: "generation",
      contentSha256: String(CANDIDATE.content_sha256),
      bytes: 7,
    });
    db.responses.push([{ blob_key: CANDIDATE.blob_key }]);
    await store.markCommitted(db, String(CANDIDATE.blob_key));
    expect(db.calls[0].sql).toContain("'staged'");
    expect(db.calls[1].sql).toContain("state = 'committed'");
  });

  it("never writes physical bytes when durable manifest reservation fails", async () => {
    const db: ManifestQueryable = {
      query: async () => {
        throw new Error("manifest unavailable");
      },
    };
    let writes = 0;
    await expect(
      stageVerifiedBlob(
        new PgBlobStagingStore(db),
        {
          writeImmutable: async () => {
            writes += 1;
            throw new Error("must not run");
          },
          verify: async () => undefined,
          deleteByKey: async () => undefined,
          deleteLegacyFlat: async () => undefined,
        },
        { generation: () => "11111111-1111-4111-8111-111111111111", requestId: () => String(CANDIDATE.request_id) },
        String(CANDIDATE.resource_id),
        Buffer.from("content")
      )
    ).rejects.toThrow("manifest unavailable");
    expect(writes).toBe(0);
  });

  it("rejects invalid generated keys before manifest SQL", async () => {
    const db = new FakeDb();
    await expect(
      stageVerifiedBlob(
        new PgBlobStagingStore(db),
        {
          writeImmutable: async () => { throw new Error("must not write"); },
          verify: async () => undefined,
          deleteByKey: async () => undefined,
          deleteLegacyFlat: async () => undefined,
        },
        { generation: () => "../escape", requestId: () => String(CANDIDATE.request_id) },
        String(CANDIDATE.resource_id),
        Buffer.from("content")
      )
    ).rejects.toMatchObject({ code: "path_invalid" });
    expect(db.calls).toEqual([]);
  });

  it("retains the create/replace manifest and never deletes after pre-return EIO", async () => {
    const db = new FakeDb();
    let deletes = 0;
    await expect(
      stageVerifiedBlob(
        new PgBlobStagingStore(db),
        {
          writeImmutable: async () => {
            throw Object.assign(new Error("disk write failed"), { code: "EIO" });
          },
          verify: async () => undefined,
          deleteByKey: async () => {
            deletes += 1;
          },
          deleteLegacyFlat: async () => undefined,
        },
        { generation: () => "11111111-1111-4111-8111-111111111111", requestId: () => String(CANDIDATE.request_id) },
        String(CANDIDATE.resource_id),
        Buffer.from("content")
      )
    ).rejects.toMatchObject({ code: "EIO" });
    expect(deletes).toBe(0);
    expect(db.calls[0].sql).toContain("'staged'");
    expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(false);
    expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(false);
  });

  it.each([false, true])(
    "durably handles an owned create/replace candidate when cleanup failure is %s",
    async cleanupFails => {
      const db = new FakeDb();
      let deletes = 0;
      await expect(
        stageVerifiedBlob(
          new PgBlobStagingStore(db),
          {
            writeImmutable: async () => ({
              blobKey: String(CANDIDATE.blob_key),
              bytes: 7,
              contentSha256: createHash("sha256").update("content").digest("hex"),
            }),
            verify: async () => { throw new Error("verification failed"); },
            deleteByKey: async () => {
              deletes += 1;
              if (cleanupFails) throw new Error("cleanup failed");
            },
            deleteLegacyFlat: async () => undefined,
          },
          { generation: () => "11111111-1111-4111-8111-111111111111", requestId: () => String(CANDIDATE.request_id) },
          String(CANDIDATE.resource_id),
          Buffer.from("content")
        )
      ).rejects.toThrow("verification failed");
      expect(deletes).toBe(1);
      expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(true);
      expect(db.calls.some(call => call.sql.includes("DELETE FROM gfs_blob_manifests"))).toBe(!cleanupFails);
    }
  );

  it("never deletes a generation that writeImmutable reports as EEXIST", async () => {
    const db = new FakeDb();
    let deletes = 0;
    await expect(
      stageVerifiedBlob(
        new PgBlobStagingStore(db),
        {
          writeImmutable: async () => {
            throw Object.assign(new Error("generation exists"), { code: "EEXIST" });
          },
          verify: async () => undefined,
          deleteByKey: async () => {
            deletes += 1;
          },
          deleteLegacyFlat: async () => undefined,
        },
        { generation: () => "11111111-1111-4111-8111-111111111111", requestId: () => String(CANDIDATE.request_id) },
        String(CANDIDATE.resource_id),
        Buffer.from("content")
      )
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(deletes).toBe(0);
    expect(db.calls.some(call => call.sql.includes("state = 'deleting'"))).toBe(false);
  });

  it("resolves an ambiguous publication only from the committed resource pointer", async () => {
    const db = new FakeDb();
    db.responses.push([{ resource_id: CANDIDATE.resource_id, blob_key: CANDIDATE.blob_key }]);
    const row = await new PgBlobStagingStore(db).resolvePublished(
      "main",
      String(CANDIDATE.resource_id),
      String(CANDIDATE.blob_key)
    );
    expect(row?.blob_key).toBe(CANDIDATE.blob_key);
    expect(db.calls[0].sql).toContain("blob_key = $3");
  });
});

describe("reconcileExpiredBlobs", () => {
  it("deletes only an expired candidate freshly proven unreferenced", async () => {
    const db = new FakeDb();
    db.responses.push(
      [{ count: "1", bytes: "7" }],
      [CANDIDATE],
      [{ referenced: false }],
      [],
      [],
      [],
      [{ count: "0", bytes: "0" }]
    );
    const deleted: string[] = [];
    const metrics = new GfsMetrics();
    const result = await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async key => void deleted.push(key), deleteLegacyFlat: async () => undefined },
      metrics,
      { olderThanMs: 60_000, limit: 10 }
    );
    expect(result).toMatchObject({ candidates: 1, deleted: 1, failures: 0 });
    expect(deleted).toEqual([CANDIDATE.blob_key]);
    expect(metrics.snapshot()).toMatchObject({ orphanCandidates: 0, orphanBytes: 0 });
  });

  it("retains a referenced candidate", async () => {
    const db = new FakeDb();
    db.responses.push(
      [{ count: "1", bytes: "7" }],
      [CANDIDATE],
      [{ referenced: true }],
      [],
      [],
      [],
      [{ count: "0", bytes: "0" }]
    );
    const deleted: string[] = [];
    const result = await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async key => void deleted.push(key), deleteLegacyFlat: async () => undefined },
      new GfsMetrics(),
      { olderThanMs: 1, limit: 10 }
    );
    expect(result).toMatchObject({ deleted: 0, retained: 1 });
    expect(deleted).toEqual([]);
  });

  it("retains and reports a candidate when the fresh DB proof is unavailable", async () => {
    const db = new FakeDb();
    db.responses.push([{ count: "1", bytes: "7" }], [{ count: "1", bytes: "7" }]);
    db.failReferenceProbe = true;
    const metrics = new GfsMetrics();
    const result = await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async () => undefined, deleteLegacyFlat: async () => undefined },
      metrics,
      { olderThanMs: 1, limit: 10 }
    );
    expect(result).toMatchObject({ deleted: 0, retained: 1, failures: 1 });
    expect(metrics.snapshot().blobCleanupFailures).toBe(1);
    expect(metrics.snapshot()).toMatchObject({ orphanCandidates: 1, orphanBytes: 7 });
  });

  it("reports aggregate orphan count and bytes independently of the cleanup batch", async () => {
    const db = new FakeDb();
    db.responses.push(
      [{ count: "5", bytes: "35" }],
      [CANDIDATE],
      [{ referenced: false }],
      [],
      [],
      [{ count: "4", bytes: "28" }]
    );
    const metrics = new GfsMetrics();
    const result = await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async () => undefined, deleteLegacyFlat: async () => undefined },
      metrics,
      { olderThanMs: 1, limit: 1 }
    );
    expect(result).toMatchObject({ candidates: 5, candidateBytes: 35, deleted: 1, retained: 4 });
    expect(metrics.snapshot()).toMatchObject({ orphanCandidates: 4, orphanBytes: 28 });
    expect(db.calls[0].sql).toContain("count(*)::bigint");
    expect(db.calls[0].sql).not.toContain("LIMIT");
  });

  it("retains the last confirmed gauges and records failure when post-pass resampling fails", async () => {
    const db = new FakeDb();
    db.failOrphanResample = true;
    db.responses.push([{ count: "3", bytes: "21" }], [], []);
    const metrics = new GfsMetrics();
    const result = await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async () => undefined, deleteLegacyFlat: async () => undefined },
      metrics,
      { olderThanMs: 1, limit: 1 }
    );
    expect(result.failures).toBe(1);
    expect(metrics.snapshot()).toMatchObject({
      orphanCandidates: 3,
      orphanBytes: 21,
      blobCleanupFailures: 1,
    });
  });

  it("deletes a legacy flat blob only from an explicit unreferenced ledger row", async () => {
    const legacy = { ...CANDIDATE, blob_key: "a".repeat(32), candidate_kind: "legacy_flat", content_sha256: null };
    const db = new FakeDb();
    db.responses.push([{ count: "1", bytes: "7" }], [legacy], [{ referenced: false }], [], [], []);
    const deleted: string[] = [];
    await reconcileExpiredBlobs(
      new PgBlobStagingStore(db),
      { deleteByKey: async () => { throw new Error("generation delete must not run"); }, deleteLegacyFlat: async id => void deleted.push(id) },
      new GfsMetrics(),
      { olderThanMs: 1, limit: 1 }
    );
    expect(deleted).toEqual([CANDIDATE.resource_id]);
    expect(db.calls[1].sql).toContain("candidate.candidate_kind = 'legacy_flat'");
  });

  it("claims with one locked unreferenced transition so publication cannot race deletion", async () => {
    const db = new FakeDb();
    db.responses.push([CANDIDATE]);
    await new PgBlobStagingStore(db).claimExpiredCandidate(60_000);
    const sql = db.calls[0].sql;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("state = 'deleting'");
  });

  it("reconciles committed and collision-staged manifests only when metadata references them", async () => {
    const db = new FakeDb();
    await new PgBlobStagingStore(db).removeCommittedMetadata(10);
    expect(db.calls[0].sql).toContain("state IN ('committed', 'staged')");
    expect(db.calls[0].sql).toContain("EXISTS");
  });
});

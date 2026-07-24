import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobStore, BlobWriteCleanupError } from "../storage/blobStore";
import { resolveBlobKeyPath } from "../storage/paths";
import {
  PgBlobStagingStore,
  stageVerifiedBlob,
  type ManifestQueryable,
} from "./blobStaging";

describe("failed blob staging cleanup", () => {
  it("retains the staged manifest when write durability fails before ownership returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gfs-staging-cleanup-"));
    const generation = "11111111-1111-4111-8111-111111111111";
    const resourceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const rid = resourceId.replaceAll("-", "");
    const events: string[] = [];
    let failFirstBlobSync = true;
    const cleanupSyncFailure = new Error("cleanup directory fsync failed");
    const db: ManifestQueryable = {
      query: async sql => {
        if (sql.includes("INSERT INTO gfs_blob_manifests")) events.push("manifest:staged");
        if (sql.includes("state = 'deleting'")) events.push("manifest:deleting");
        if (sql.includes("DELETE FROM gfs_blob_manifests")) events.push("manifest:removed");
        return { rows: [] };
      },
    };
    const blobs = new BlobStore(dir, "writer", async path => {
      events.push(`sync:${path}`);
      if (path.endsWith(generation) && failFirstBlobSync) {
        failFirstBlobSync = false;
        throw new Error("blob fsync failed");
      }
      if (path.endsWith(rid)) throw cleanupSyncFailure;
    });

    try {
      await expect(
        stageVerifiedBlob(
          new PgBlobStagingStore(db),
          blobs,
          {
            generation: () => generation,
            requestId: () => "22222222-2222-4222-8222-222222222222",
          },
          resourceId,
          Buffer.from("content")
        )
      ).rejects.toMatchObject({
        name: BlobWriteCleanupError.name,
        cleanupErrors: expect.arrayContaining([cleanupSyncFailure]),
      });

      expect(events).toContain("manifest:staged");
      expect(events).not.toContain("manifest:deleting");
      expect(events).not.toContain("manifest:removed");
      expect(existsSync(resolveBlobKeyPath(dir, `${rid}/${generation}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

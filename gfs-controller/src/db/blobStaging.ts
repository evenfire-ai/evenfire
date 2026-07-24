import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ImmutableWriteOptions } from "../storage/blobStore";
import { generationBlobKey } from "../storage/paths";
import { withDeadlineTransaction, type DeadlineBudget, type DeadlineClient } from "./deadlineQuery";
import { matchesPublishedTree, type PublishedTreeRef } from "./publishedTree";
export { reconcileExpiredBlobs, type ReconcileResult } from "./blobReconciliation";
export { stageCopiedBlob, type CopyBlobSource, type StageCopiedBlobInput } from "./copyBlobStaging";
export type { PublishedTreeRef } from "./publishedTree";

export type BlobManifestState = "staged" | "committed" | "deleting";

export interface ManifestRow {
  blobKey: string;
  requestId: string;
  resourceId: string;
  candidateKind: "generation" | "legacy_flat";
  contentSha256: string | null;
  bytes: number;
  state: BlobManifestState;
}

export interface ManifestQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect?: () => Promise<DeadlineClient>;
}

export type ManifestQueryBudget = DeadlineBudget;

async function manifestQuery(
  db: ManifestQueryable,
  text: string,
  values: unknown[],
  budget?: ManifestQueryBudget,
  readOnly = false
): Promise<{ rows: Record<string, unknown>[] }> {
  if (!budget) return db.query(text, values);
  return withDeadlineTransaction(db, budget, readOnly, client => client.query(text, values));
}

export interface CleanupBlobStore {
  deleteByKey(blobKey: string): Promise<void>;
  deleteLegacyFlat(resourceId: string): Promise<void>;
}

export interface StagingBlobStore extends CleanupBlobStore {
  writeImmutable(
    resourceId: string,
    generation: string,
    data: Readable | Buffer,
    options?: ImmutableWriteOptions
  ): Promise<{ blobKey: string; bytes: number; contentSha256: string }>;
  verify(blobKey: string, expectedBytes: number, expectedSha256: string, options?: ImmutableWriteOptions): Promise<void>;
}

function mapManifest(row: Record<string, unknown>): ManifestRow {
  return {
    blobKey: String(row.blob_key),
    requestId: String(row.request_id),
    resourceId: String(row.resource_id),
    candidateKind: String(row.candidate_kind) === "legacy_flat" ? "legacy_flat" : "generation",
    contentSha256: row.content_sha256 == null ? null : String(row.content_sha256),
    bytes: Number(row.bytes),
    state: String(row.state) as BlobManifestState,
  };
}

export class PgBlobStagingStore {
  constructor(private readonly db: ManifestQueryable) {}

  async recordStaged(manifest: Omit<ManifestRow, "state">, budget?: ManifestQueryBudget): Promise<void> {
    await manifestQuery(this.db,
      `INSERT INTO gfs_blob_manifests
         (blob_key, request_id, resource_id, candidate_kind, content_sha256, bytes, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'staged')`,
      [
        manifest.blobKey,
        manifest.requestId,
        manifest.resourceId,
        manifest.candidateKind,
        manifest.contentSha256,
        manifest.bytes,
      ],
      budget
    );
    budget?.signal?.throwIfAborted();
  }

  async markCommitted(client: ManifestQueryable, blobKey: string): Promise<void> {
    const result = await client.query(
      `UPDATE gfs_blob_manifests
          SET state = 'committed', updated_at = now()
        WHERE blob_key = $1 AND state = 'staged'
        RETURNING blob_key`,
      [blobKey]
    );
    if (result.rows.length !== 1) throw new Error("staged blob manifest missing");
  }

  async markCommittedMany(client: ManifestQueryable, requestId: string, blobKeys: readonly string[]): Promise<void> {
    if (blobKeys.length === 0) return;
    const unique = [...new Set(blobKeys)];
    if (unique.length !== blobKeys.length) throw new Error("duplicate staged blob key");
    const result = await client.query(
      `UPDATE gfs_blob_manifests
          SET state = 'committed', updated_at = now()
        WHERE request_id = $1 AND blob_key = ANY($2::text[]) AND state = 'staged'
        RETURNING blob_key`,
      [requestId, unique]
    );
    const changed = new Set(result.rows.map(row => String(row.blob_key)));
    if (changed.size !== unique.length || unique.some(key => !changed.has(key))) {
      throw new Error("staged blob manifest set is incomplete");
    }
  }

  async removeCommitted(blobKey: string): Promise<void> {
    await this.db.query(
      `DELETE FROM gfs_blob_manifests WHERE blob_key = $1 AND state = 'committed'`,
      [blobKey]
    );
  }

  async removeCommittedMany(requestId: string, blobKeys: readonly string[], budget?: ManifestQueryBudget): Promise<void> {
    if (blobKeys.length === 0) return;
    const unique = [...new Set(blobKeys)];
    if (unique.length !== blobKeys.length) throw new Error("duplicate committed blob key");
    const result = await manifestQuery(this.db,
      `DELETE FROM gfs_blob_manifests
        WHERE request_id = $1 AND blob_key = ANY($2::text[]) AND state = 'committed'
        RETURNING blob_key`,
      [requestId, unique],
      budget
    );
    const removed = new Set(result.rows.map(row => String(row.blob_key)));
    if (removed.size !== unique.length || unique.some(key => !removed.has(key))) {
      throw new Error("committed blob manifest set is incomplete");
    }
  }

  async markSuperseded(
    client: ManifestQueryable,
    manifest: Omit<ManifestRow, "requestId" | "state" | "candidateKind">
  ): Promise<void> {
    await client.query(
      `INSERT INTO gfs_blob_manifests
         (blob_key, request_id, resource_id, candidate_kind, content_sha256, bytes, state)
       VALUES ($1, gen_random_uuid(), $2, 'generation', $3, $4, 'deleting')
       ON CONFLICT (blob_key) DO UPDATE
         SET state = 'deleting', updated_at = now()`,
      [manifest.blobKey, manifest.resourceId, manifest.contentSha256, manifest.bytes]
    );
  }

  async markLegacySuperseded(
    client: ManifestQueryable,
    resourceId: string,
    bytes: number
  ): Promise<void> {
    const blobKey = resourceId.replaceAll("-", "").toLowerCase();
    await client.query(
      `INSERT INTO gfs_blob_manifests
         (blob_key, request_id, resource_id, candidate_kind, content_sha256, bytes, state)
       VALUES ($1, gen_random_uuid(), $2, 'legacy_flat', NULL, $3, 'deleting')
       ON CONFLICT (blob_key) DO UPDATE
         SET state = 'deleting', updated_at = now()`,
      [blobKey, resourceId, bytes]
    );
  }

  async markDeleting(blobKey: string, budget?: ManifestQueryBudget): Promise<void> {
    await manifestQuery(this.db,
      `UPDATE gfs_blob_manifests SET state = 'deleting', updated_at = now() WHERE blob_key = $1`,
      [blobKey],
      budget
    );
  }

  async restoreCommitted(blobKey: string): Promise<void> {
    await this.db.query(
      `UPDATE gfs_blob_manifests SET state = 'committed', updated_at = now()
        WHERE blob_key = $1 AND state = 'deleting'`,
      [blobKey]
    );
  }

  async remove(blobKey: string, budget?: ManifestQueryBudget): Promise<void> {
    await manifestQuery(this.db,
      `DELETE FROM gfs_blob_manifests WHERE blob_key = $1`,
      [blobKey],
      budget
    );
  }

  async resolvePublished(
    drive: string,
    resourceId: string,
    blobKey: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db.query(
      `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache,
              version, bytes, blob_key, content_sha256, deleted_at
         FROM gfs_resources
        WHERE drive = $1 AND resource_id = $2 AND blob_key = $3`,
      [drive, resourceId, blobKey]
    );
    return result.rows[0] ?? null;
  }

  async resolvePublishedTree(drive: string, expected: readonly PublishedTreeRef[], budget?: ManifestQueryBudget): Promise<Record<string, unknown>[] | null> {
    if (expected.length === 0) return [];
    const ids = expected.map(item => item.resourceId);
    const keys = expected.flatMap(item => item.blobKey === null ? [] : [item.blobKey]);
    if (new Set(ids).size !== ids.length || new Set(keys).size !== keys.length) {
      throw new Error("duplicate expected published resource");
    }
    const result = await manifestQuery(this.db,
      `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache,
              version, bytes, blob_key, content_sha256, deleted_at
         FROM gfs_resources
        WHERE drive = $1 AND resource_id = ANY($2::uuid[])`,
      [drive, ids],
      budget,
      true
    );
    return matchesPublishedTree(drive, expected, result.rows) ? result.rows : null;
  }

  async orphanTotals(olderThanMs: number): Promise<{ count: number; bytes: number }> {
    const result = await this.db.query(
      `SELECT count(*)::bigint AS count, coalesce(sum(candidate.bytes), 0)::bigint AS bytes
         FROM gfs_blob_manifests AS candidate
        WHERE candidate.state IN ('staged', 'deleting')
          AND candidate.updated_at < now() - ($1::bigint * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM gfs_resources AS resource
             WHERE (candidate.candidate_kind = 'generation' AND resource.blob_key = candidate.blob_key)
                OR (candidate.candidate_kind = 'legacy_flat'
                    AND resource.resource_id = candidate.resource_id AND resource.blob_key IS NULL)
          )`,
      [olderThanMs]
    );
    return { count: Number(result.rows[0]?.count ?? 0), bytes: Number(result.rows[0]?.bytes ?? 0) };
  }

  async claimExpiredCandidate(olderThanMs: number): Promise<ManifestRow | null> {
    const result = await this.db.query(
      `UPDATE gfs_blob_manifests AS manifest
          SET state = 'deleting', updated_at = now()
        WHERE manifest.blob_key = (
          SELECT candidate.blob_key
            FROM gfs_blob_manifests AS candidate
           WHERE candidate.state IN ('staged', 'deleting')
             AND candidate.updated_at < now() - ($1::bigint * interval '1 millisecond')
             AND NOT EXISTS (
               SELECT 1 FROM gfs_resources AS resource
                WHERE (candidate.candidate_kind = 'generation' AND resource.blob_key = candidate.blob_key)
                   OR (candidate.candidate_kind = 'legacy_flat'
                       AND resource.resource_id = candidate.resource_id AND resource.blob_key IS NULL)
             )
           ORDER BY candidate.updated_at, candidate.blob_key
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING manifest.blob_key, manifest.request_id, manifest.resource_id,
                  manifest.candidate_kind, manifest.content_sha256, manifest.bytes, manifest.state`,
      [olderThanMs]
    );
    return result.rows[0] ? mapManifest(result.rows[0]) : null;
  }

  async referenced(candidate: ManifestRow): Promise<boolean> {
    const result = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM gfs_resources
          WHERE ($2 = 'generation' AND blob_key = $1)
             OR ($2 = 'legacy_flat' AND resource_id = $3 AND blob_key IS NULL)
       ) AS referenced`,
      [candidate.blobKey, candidate.candidateKind, candidate.resourceId]
    );
    return result.rows[0]?.referenced === true;
  }

  async removeCommittedMetadata(limit: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM gfs_blob_manifests AS manifest
        WHERE manifest.blob_key IN (
          SELECT candidate.blob_key
            FROM gfs_blob_manifests AS candidate
           WHERE candidate.state IN ('committed', 'staged')
             AND EXISTS (SELECT 1 FROM gfs_resources r WHERE r.blob_key = candidate.blob_key)
           ORDER BY candidate.updated_at, candidate.blob_key
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING manifest.blob_key`,
      [limit]
    );
    return result.rows.length;
  }
}

export async function discardCandidate(
  manifests: PgBlobStagingStore,
  blobs: CleanupBlobStore,
  blobKey: string,
  budget?: ManifestQueryBudget
): Promise<void> {
  await manifests.markDeleting(blobKey, budget);
  try {
    await blobs.deleteByKey(blobKey);
  } catch (err) {
    if ((err as { code?: string }).code !== "not_found") throw err;
  }
  await manifests.remove(blobKey, budget);
}

export async function stageVerifiedBlob(
  manifests: PgBlobStagingStore,
  blobs: StagingBlobStore,
  ids: { generation: () => string; requestId: () => string },
  resourceId: string,
  content: Buffer
): Promise<{ blobKey: string; bytes: number; contentSha256: string }> {
  const generation = ids.generation();
  const blobKey = generationBlobKey(resourceId, generation);
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  await manifests.recordStaged({
    blobKey,
    requestId: ids.requestId(),
    resourceId,
    candidateKind: "generation",
    contentSha256,
    bytes: content.length,
  });
  let physicalCandidateOwned = false;
  try {
    const written = await blobs.writeImmutable(resourceId, generation, content);
    physicalCandidateOwned = true;
    if (
      written.blobKey !== blobKey ||
      written.bytes !== content.length ||
      written.contentSha256 !== contentSha256
    ) {
      throw new Error("staged blob verification mismatch");
    }
    await blobs.verify(blobKey, content.length, contentSha256);
    return written;
  } catch (err) {
    // A failure before writeImmutable returns does not prove that this request
    // owns the physical key. Keep the staged manifest so reconciliation can
    // make a fresh durable reference check without risking pre-existing bytes.
    if (physicalCandidateOwned) {
      await discardCandidate(manifests, blobs, blobKey).catch(() => undefined);
    }
    throw err;
  }
}

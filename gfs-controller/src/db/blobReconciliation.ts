import type { GfsMetrics } from "../metrics";
import type { CleanupBlobStore, PgBlobStagingStore } from "./blobStaging";

export interface ReconcileResult {
  candidates: number;
  candidateBytes: number;
  deleted: number;
  retained: number;
  failures: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function reconcileExpiredBlobs(
  manifests: PgBlobStagingStore,
  blobs: CleanupBlobStore,
  metrics: GfsMetrics,
  options: { olderThanMs: number; limit: number }
): Promise<ReconcileResult> {
  const totals = await manifests.orphanTotals(options.olderThanMs);
  const result: ReconcileResult = { candidates: totals.count, candidateBytes: totals.bytes, deleted: 0, retained: 0, failures: 0 };
  metrics.setOrphanCandidates(result.candidates, result.candidateBytes);
  for (let index = 0; index < options.limit; index += 1) {
    try {
      const candidate = await manifests.claimExpiredCandidate(options.olderThanMs);
      if (!candidate) break;
      if (await manifests.referenced(candidate)) {
        await manifests.restoreCommitted(candidate.blobKey);
        result.retained += 1;
        continue;
      }
      try {
        if (candidate.candidateKind === "legacy_flat") await blobs.deleteLegacyFlat(candidate.resourceId);
        else await blobs.deleteByKey(candidate.blobKey);
      } catch (err) {
        if ((err as { code?: string }).code !== "not_found") throw err;
      }
      await manifests.remove(candidate.blobKey);
      result.deleted += 1;
    } catch (err) {
      // The failure counter alone cannot be diagnosed: log WHY this candidate
      // failed before deferring the remainder to the next reconciliation run.
      console.error(`[gfsc] blob cleanup candidate failed: ${errText(err)}`);
      result.failures += 1;
      result.retained += 1;
      metrics.recordBlobCleanupFailure();
      break;
    }
  }
  if (result.failures === 0) {
    await manifests.removeCommittedMetadata(options.limit).catch((err: unknown) => {
      console.error(`[gfsc] committed-manifest metadata cleanup failed: ${errText(err)}`);
      result.failures += 1;
      metrics.recordBlobCleanupFailure();
    });
  }
  try {
    const remaining = await manifests.orphanTotals(options.olderThanMs);
    metrics.setOrphanCandidates(remaining.count, remaining.bytes);
  } catch (err) {
    console.error(`[gfsc] orphan-candidate recount failed: ${errText(err)}`);
    result.failures += 1;
    metrics.recordBlobCleanupFailure();
  }
  result.retained = Math.max(result.retained, result.candidates - result.deleted);
  return result;
}

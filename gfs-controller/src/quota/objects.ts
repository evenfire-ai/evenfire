import { QuotaError } from "./bytes.js";

/**
 * gfs per-folder object-count quota (spec §gfs-controller Quotas; plan P4-S03).
 * Caps the number of resources in a folder/drive to blunt a small-file flood
 * from a compromised agent. Re-checked on move. Negative limit = unlimited.
 */
export function assertObjectQuota(currentCount: number, addCount: number, limit: number): void {
  if (limit >= 0 && currentCount + addCount > limit) {
    throw new QuotaError(
      "object_quota_exceeded",
      `object quota exceeded: ${currentCount}+${addCount} > ${limit}`,
    );
  }
}

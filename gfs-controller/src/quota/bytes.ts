/**
 * gfs byte quota (spec community.md §gfs-controller Quotas; plan P4-S03). A
 * per-folder/per-drive byte ceiling, checked as a transactional counter on write
 * and RE-checked on move. Exceeding → quota_exceeded. A negative limit means
 * unlimited.
 */

export type QuotaCode = "byte_quota_exceeded" | "object_quota_exceeded" | "rate_limited";

export class QuotaError extends Error {
  constructor(
    readonly code: QuotaCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "QuotaError";
  }
}

/** Throw byte_quota_exceeded if adding `delta` bytes would exceed `limit`. */
export function assertByteQuota(currentBytes: number, delta: number, limit: number): void {
  if (limit >= 0 && currentBytes + delta > limit) {
    throw new QuotaError(
      "byte_quota_exceeded",
      `byte quota exceeded: ${currentBytes}+${delta} > ${limit}`,
    );
  }
}

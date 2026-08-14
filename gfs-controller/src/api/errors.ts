/**
 * gfsc error-code table. The CODE is the spec's contract (clients key off it);
 * the HTTP status is the transport mapping. The spec pins these numbers
 * explicitly: gone=410, precondition_failed=412, payload_too_large=413,
 * not_mounted=503, internal=500. The remaining statuses are conventional
 * mappings (the spec names the code, not a number) — kept here as the single
 * source so the read/write layers never hard-code a status.
 */
export type GfsErrorCode =
  | "path_invalid"
  | "not_found"
  | "gone"
  | "already_exists"
  | "not_a_directory"
  | "is_a_directory"
  | "not_empty"
  | "precondition_failed"
  | "payload_too_large"
  | "quota_exceeded"
  | "conflict"
  | "idempotency_conflict"
  | "upload_incomplete"
  | "upload_finalizing"
  | "upload_completed"
  | "upload_aborted"
  | "upload_expired"
  | "checksum_mismatch"
  | "insufficient_storage"
  | "cross_boundary"
  | "forbidden"
  | "unauthorized"
  | "not_mounted"
  | "internal";

export const HTTP_STATUS: Record<GfsErrorCode, number> = {
  path_invalid: 400,
  not_found: 404,
  gone: 410, // spec-pinned
  already_exists: 409,
  not_a_directory: 409,
  is_a_directory: 409,
  not_empty: 409,
  precondition_failed: 412, // spec-pinned
  payload_too_large: 413, // spec-pinned
  quota_exceeded: 429,
  conflict: 409,
  idempotency_conflict: 409,
  upload_incomplete: 409,
  upload_finalizing: 409,
  upload_completed: 409,
  upload_aborted: 410,
  upload_expired: 410,
  checksum_mismatch: 422,
  insufficient_storage: 507,
  cross_boundary: 409,
  forbidden: 403,
  unauthorized: 401,
  not_mounted: 503, // spec-pinned
  internal: 500, // spec-pinned
};

/** Reason discriminator for a `gone` (410): a tombstoned resource vs. an
 * expired published artifact reference. */
export type GoneReason = "resource_deleted" | "artifact_expired";

export class GfsError extends Error {
  readonly code: GfsErrorCode;
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
  readonly limit?: string;

  constructor(
    code: GfsErrorCode,
    message: string,
    reason?: string,
    details?: { retryAfterSeconds?: number; limit?: string },
  ) {
    super(message);
    this.name = "GfsError";
    this.code = code;
    this.reason = reason;
    this.retryAfterSeconds = details?.retryAfterSeconds;
    this.limit = details?.limit;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  static gone(message: string, reason: GoneReason): GfsError {
    return new GfsError("gone", message, reason);
  }
}

/**
 * Delivered-on-read stamping for the in-RAM result stores (D8 `pendingResults`
 * refinement — the same class as the C3 `deliveredInline` exception).
 *
 * The spec's D8 condition 4 hard-blocks suspension while either in-RAM result
 * store is non-empty because the stores have no durable backing — suspending
 * would LOSE undelivered results. That rationale ends at delivery: once the
 * owning caller has FETCHED a result (poll read on
 * GET /v1/runtime/tasks/:id/result, or a cron read on GET /cron/results), the
 * entry is a recoverability cache for repeat readers, not pending work — the
 * same class as the C3 inline-delivered sync entry the gauge already excludes.
 * Marking is a stamp, NOT a delete: repeat polls still return the entry for
 * the full TTL (multi-reader idempotency), and the explicit cron ACK delete
 * remains the strong consumption signal.
 */

/**
 * Structural shape shared by `PendingTaskEntry` and `PendingCronResult` for
 * the stateless idle gauge. Cron entries never carry `deliveredInline`, so the
 * one predicate serves both stores.
 */
export interface DeliverableResultEntry {
  /** C3 — sync results already answered inline on the caller's own socket. */
  deliveredInline?: boolean
  /** Epoch ms of the FIRST successful owner read (poll / cron fetch). */
  deliveredAt?: number
}

/**
 * Stamp an entry as delivered on a successful owner read. Idempotent — the
 * first read's timestamp wins; the entry itself stays in its store untouched
 * so repeat readers keep getting it until TTL (or the explicit cron ACK).
 */
export function markResultDelivered(entry: DeliverableResultEntry, now: number = Date.now()): void {
  if (entry.deliveredAt === undefined) {
    entry.deliveredAt = now
  }
}

/**
 * The D8 `pendingResults` gauge predicate: an entry pins the idle gauge only
 * while it is genuinely UNDELIVERED — never answered inline (C3) and never
 * fetched by its owner (delivered-on-read). Undelivered entries keep the
 * spec's hard suspend block until TTL: suspending would lose them.
 */
export function isUndeliveredResult(entry: DeliverableResultEntry): boolean {
  return !entry.deliveredInline && entry.deliveredAt === undefined
}

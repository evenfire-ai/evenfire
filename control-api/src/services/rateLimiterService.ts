import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'

/**
 * PG-backed sliding-window-ish rate limiter.
 *
 * Bucket strategy: fixed 60s windows keyed by (bucketKey, floor(nowMs / 60000) * 60000).
 * An INSERT ... ON CONFLICT DO UPDATE atomically increments the counter and
 * returns the new count, making the check race-free across replicas.
 *
 * This is intentionally NOT a true sliding window — fixed windows are cheaper
 * and precise enough for our abuse-prevention goals (CPU/DB protection, not
 * financial metering). A burst at the boundary can get 2x the limit in 60s,
 * which we tolerate.
 *
 * Schema: see `rate_limit_buckets` in db.ts.
 */

const WINDOW_MS = 60_000

export type RateLimitCheck = {
  allowed: boolean
  remaining: number
  resetMs: number
  windowStartMs: number
  count: number
}

export function currentWindowStartMs(nowMs = Date.now()): number {
  return Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
}

/**
 * Atomically increment the (bucketKey, windowStart) counter, return the new
 * count plus whether it's still under `maxPerMinute`.
 *
 * We always increment — even if the request will be denied — because the caller
 * wants to see sustained abuse climbing; the alternative (conditional update)
 * requires two round-trips. The counter is bounded by maxPerMinute * burst
 * factor in practice because callers stop retrying when they see 429.
 */
export async function checkAndIncrement(
  bucketKey: string,
  maxPerMinute: number,
  nowMs = Date.now()
): Promise<RateLimitCheck> {
  const windowStartMs = currentWindowStartMs(nowMs)
  const resetMs = windowStartMs + WINDOW_MS

  let result: { rows: unknown[] } | null | undefined
  try {
    result = await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start_ms, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key, window_start_ms) DO UPDATE
         SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [bucketKey, windowStartMs]
    )
  } catch (err) {
    // Fail-open on DB errors — the limiter is an abuse gate, not a security
    // boundary. Log and let the request through so a DB blip cannot take
    // down all traffic.
    rootLogger.warn(
      {
        event: 'rate_limit_db_error',
        bucketKey,
        err: err instanceof Error ? err.message : String(err),
      },
      'rate limiter DB error, failing open'
    )
    return {
      allowed: true,
      remaining: maxPerMinute,
      resetMs,
      windowStartMs,
      count: 0,
    }
  }
  // Fail-open if the DB returns no row (e.g. test harness mocking pool.query
  // with empty rows). Same rationale as the DB-error branch.
  const rows = result && Array.isArray(result.rows) ? result.rows : []
  const row = (rows[0] ?? null) as { count: number | string } | null
  if (!row) {
    return {
      allowed: true,
      remaining: maxPerMinute,
      resetMs,
      windowStartMs,
      count: 0,
    }
  }
  const count = Number(row.count)
  const allowed = count <= maxPerMinute
  const remaining = Math.max(0, maxPerMinute - count)

  return { allowed, remaining, resetMs, windowStartMs, count }
}

/**
 * Housekeeping: drop rows older than 5 minutes (no active window references
 * them). Safe to run at any cadence — delete is idempotent.
 */
export async function cleanupExpiredBuckets(nowMs = Date.now()): Promise<number> {
  const cutoff = nowMs - 5 * 60_000
  const result = await pool.query(`DELETE FROM rate_limit_buckets WHERE window_start_ms < $1`, [
    cutoff,
  ])
  return result.rowCount ?? 0
}

let cleanupHandle: ReturnType<typeof setInterval> | null = null

export function startRateLimiterCleanup(intervalMs: number): void {
  if (cleanupHandle) return
  cleanupHandle = setInterval(() => {
    cleanupExpiredBuckets().catch(err => {
      rootLogger.warn(
        {
          event: 'rate_limit_cleanup_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'rate limiter cleanup failed'
      )
    })
  }, intervalMs)
  cleanupHandle.unref()
}

export function stopRateLimiterCleanup(): void {
  if (cleanupHandle) {
    clearInterval(cleanupHandle)
    cleanupHandle = null
  }
}

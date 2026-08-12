import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
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
  backendAvailable: boolean
}

export function currentWindowStartMs(nowMs = Date.now()): number {
  return Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
}

type RateLimitQuery = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>

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
  nowMs = Date.now(),
  cost = 1
): Promise<RateLimitCheck> {
  return checkAndIncrementWithQuery(
    (text, values) => pool.query(text, values),
    bucketKey,
    maxPerMinute,
    nowMs,
    cost
  )
}

/**
 * Same atomic limiter operation against an explicitly supplied query
 * function. Production callers use the process-wide pool above; the narrow
 * seam lets the real-Postgres integration suite exercise this exact SQL
 * against an isolated database without changing runtime ownership.
 */
export async function checkAndIncrementWithQuery(
  query: RateLimitQuery,
  bucketKey: string,
  maxPerMinute: number,
  nowMs = Date.now(),
  cost = 1
): Promise<RateLimitCheck> {
  if (!Number.isSafeInteger(cost) || cost < 1) throw new Error('rate limit cost must be positive')
  const windowStartMs = currentWindowStartMs(nowMs)
  const resetMs = windowStartMs + WINDOW_MS

  let result: { rows: unknown[] } | null | undefined
  try {
    result = await query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start_ms, count)
       VALUES ($1, $2, $3)
       ON CONFLICT (bucket_key, window_start_ms) DO UPDATE
         SET count = rate_limit_buckets.count + EXCLUDED.count
       RETURNING count`,
      [bucketKey, windowStartMs, cost]
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
      backendAvailable: false,
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
      backendAvailable: false,
    }
  }
  const count = Number(row.count)
  const allowed = count <= maxPerMinute
  const remaining = Math.max(0, maxPerMinute - count)

  return { allowed, remaining, resetMs, windowStartMs, count, backendAvailable: true }
}

export type RateLimitConcurrencyRequirement = {
  bucketKey: string
  maxConcurrent: number
}

export type RateLimitConcurrencyLease = {
  allowed: boolean
  backendAvailable: boolean
  release: () => Promise<void>
}

export type RateLimitConcurrencyLeaseOptions = {
  /** Test/integration seam; production callers use the dedicated pool client. */
  client?: PoolClient
}

let concurrencyClient: PoolClient | null = null
let concurrencyClientPromise: Promise<PoolClient> | null = null
// Session-scoped advisory locks are re-entrant only on the same PostgreSQL
// connection. Keep the local guard per client so an integration test (and any
// future multi-pool caller) still exercises the database lock across sessions.
const heldConcurrencySlotsByClient = new WeakMap<object, Set<string>>()
let concurrencyOperation = Promise.resolve()

function heldSlotsFor(client: PoolClient): Set<string> {
  const key = client as unknown as object
  let slots = heldConcurrencySlotsByClient.get(key)
  if (!slots) {
    slots = new Set<string>()
    heldConcurrencySlotsByClient.set(key, slots)
  }
  return slots
}

async function serializeConcurrencyOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = concurrencyOperation
  let finish!: () => void
  concurrencyOperation = new Promise<void>(resolve => {
    finish = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    finish()
  }
}

type AdvisoryLockKey = {
  high: number
  low: number
}

function advisoryKey(value: string): AdvisoryLockKey {
  const digest = createHash('sha256').update(value).digest()
  return { high: digest.readInt32BE(0), low: digest.readInt32BE(4) }
}

async function getConcurrencyClient(): Promise<PoolClient> {
  if (concurrencyClient) return concurrencyClient
  if (!concurrencyClientPromise) {
    concurrencyClientPromise = pool.connect().then(client => {
      concurrencyClient = client
      client.once('error', error => {
        rootLogger.warn(
          { event: 'rate_limit_concurrency_connection_error', err: error.message },
          'rate limiter concurrency connection failed'
        )
        if (concurrencyClient === client) concurrencyClient = null
        heldSlotsFor(client).clear()
        client.release(true)
      })
      return client
    })
  }
  try {
    return await concurrencyClientPromise
  } finally {
    concurrencyClientPromise = null
  }
}

async function unlockSlots(
  client: PoolClient,
  slots: Array<{ key: AdvisoryLockKey; identity: string }>
): Promise<boolean> {
  const heldSlots = heldSlotsFor(client)
  let success = true
  for (const acquired of slots.reverse()) {
    try {
      await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [
        acquired.key.high,
        acquired.key.low,
      ])
      heldSlots.delete(acquired.identity)
    } catch (error) {
      // The lock state is unknown after an unlock error. Keep the local guard
      // until the connection error path invalidates this client; otherwise a
      // same-session reentrant pg_try_advisory_lock could admit a duplicate.
      rootLogger.warn(
        {
          event: 'rate_limit_concurrency_unlock_error',
          err: error instanceof Error ? error.message : String(error),
        },
        'rate limiter concurrency unlock failed'
      )
      success = false
      break
    }
  }
  return success
}

async function invalidateDedicatedConcurrencyClient(client: PoolClient): Promise<void> {
  if (concurrencyClient !== client) return
  concurrencyClient = null
  heldSlotsFor(client).clear()
  // Advisory locks are session-scoped. Destroying this dedicated client is the
  // only fail-closed way to release a lock whose unlock response is unknown.
  client.release(true)
}

/**
 * Acquire bounded PostgreSQL advisory-lock slots on one dedicated pooled
 * session. Advisory locks are replica-safe and PostgreSQL releases them if the
 * process/connection dies. Local slot tracking prevents same-session lock
 * reentrancy from admitting the same slot twice.
 */
export async function acquireRateLimitConcurrencyLease(
  requirements: readonly RateLimitConcurrencyRequirement[],
  options: RateLimitConcurrencyLeaseOptions = {}
): Promise<RateLimitConcurrencyLease> {
  for (const requirement of requirements) {
    if (!Number.isSafeInteger(requirement.maxConcurrent) || requirement.maxConcurrent < 1)
      throw new Error('rate limit concurrency must be positive')
  }
  return serializeConcurrencyOperation(async () => {
    let client: PoolClient
    try {
      client = options.client ?? (await getConcurrencyClient())
    } catch (error) {
      rootLogger.warn(
        {
          event: 'rate_limit_concurrency_db_error',
          err: error instanceof Error ? error.message : String(error),
        },
        'rate limiter concurrency admission failed closed'
      )
      return { allowed: false, backendAvailable: false, release: async () => undefined }
    }

    const acquired: Array<{ key: AdvisoryLockKey; identity: string }> = []
    try {
      for (const requirement of requirements) {
        const bucketKey = advisoryKey(requirement.bucketKey)
        let selected: { key: AdvisoryLockKey; identity: string } | null = null
        for (let slot = 0; slot < requirement.maxConcurrent; slot += 1) {
          // Keep both halves of the SHA-256-derived key in the PostgreSQL
          // advisory lock identity. The slot is folded into the low half so
          // distinct buckets do not collide merely because their first 32
          // digest bits match.
          const key = { high: bucketKey.high, low: bucketKey.low ^ slot }
          const identity = `${key.high}:${key.low}`
          if (heldSlotsFor(client).has(identity)) continue
          const result = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
            [key.high, key.low]
          )
          if (result.rows[0]?.acquired === true) {
            selected = { key, identity }
            heldSlotsFor(client).add(identity)
            acquired.push(selected)
            break
          }
        }
        if (!selected) {
          const unlocked = await unlockSlots(client, acquired)
          if (!unlocked) await invalidateDedicatedConcurrencyClient(client)
          return { allowed: false, backendAvailable: true, release: async () => undefined }
        }
      }
    } catch (error) {
      const unlocked = await unlockSlots(client, acquired)
      if (!unlocked) await invalidateDedicatedConcurrencyClient(client)
      rootLogger.warn(
        {
          event: 'rate_limit_concurrency_db_error',
          err: error instanceof Error ? error.message : String(error),
        },
        'rate limiter concurrency admission failed closed'
      )
      return { allowed: false, backendAvailable: false, release: async () => undefined }
    }

    let released = false
    return {
      allowed: true,
      backendAvailable: true,
      release: async () => {
        if (released) return
        released = true
        await serializeConcurrencyOperation(async () => {
          const unlocked = await unlockSlots(client, acquired)
          if (!unlocked) await invalidateDedicatedConcurrencyClient(client)
        })
      },
    }
  })
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

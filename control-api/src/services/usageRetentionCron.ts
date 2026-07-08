/**
 * Retention cron for LLM-usage tables. One daily tick prunes each rollup
 * tier once it ages out:
 *
 *   usage_events  — ts < NOW() - 48 hours    (raw events; rollups have already absorbed them)
 *   usage_5min    — bucket < NOW() - 7 days  (covers the "Last 24 h" view)
 *   usage_hourly  — bucket < NOW() - 30 days (covers the "Last 7 d" view)
 *   usage_daily   — never pruned             (covers "Last 30 d" and beyond, kept indefinitely)
 *
 * The DELETEs are independent and idempotent: running twice in the same
 * day is a no-op the second time, and a missed run catches up on the
 * next tick (each window is a hard age cutoff, not a moving sweep).
 *
 * Errors per-DELETE are logged but do NOT abort the cron — a transient
 * lock contention on one tier shouldn't block the others.
 */
import { type DbClient, pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'

const log = rootLogger.child({ service: 'usage_retention' })

const PRUNE_TARGETS = [
  { table: 'usage_events', column: 'ts', interval: '48 hours' },
  { table: 'usage_5min', column: 'bucket', interval: '7 days' },
  { table: 'usage_hourly', column: 'bucket', interval: '30 days' },
  // usage_daily is intentionally never pruned — see plan.
] as const

export type RetentionResult = {
  table: string
  rowsDeleted: number
}

export async function pruneUsageRetention(db: DbClient = pool): Promise<RetentionResult[]> {
  const results: RetentionResult[] = []
  for (const target of PRUNE_TARGETS) {
    try {
      const sql = `DELETE FROM ${target.table} WHERE ${target.column} < NOW() - INTERVAL '${target.interval}'`
      const res = await db.query(sql)
      const rowsDeleted = res.rowCount ?? 0
      results.push({ table: target.table, rowsDeleted })
      if (rowsDeleted > 0) {
        log.info(
          { event: 'usage_retention_pruned', table: target.table, rowsDeleted },
          `pruned ${rowsDeleted} rows from ${target.table}`
        )
      }
    } catch (err) {
      log.error(
        {
          event: 'usage_retention_error',
          table: target.table,
          err: err instanceof Error ? err.message : String(err),
        },
        `failed to prune ${target.table}`
      )
      results.push({ table: target.table, rowsDeleted: 0 })
    }
  }
  return results
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startUsageRetentionCron(intervalMs: number): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    void pruneUsageRetention().catch(err => {
      log.error(
        {
          event: 'usage_retention_unhandled',
          err: err instanceof Error ? err.message : String(err),
        },
        'unhandled error in usage retention cron'
      )
    })
  }, intervalMs)
  intervalHandle.unref()
  log.info({ event: 'usage_retention_started', intervalMs }, 'usage retention cron started')
}

export function stopUsageRetentionCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

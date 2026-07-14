/**
 * Sweep cron for expired budget reservations (.specs/feat-token-budgets §5.4,
 * §9.7). One periodic tick deletes rows whose `expires_at <= NOW()`.
 *
 * This is PURE CLEANUP, not correctness-critical: the pending-sum query in the
 * budget-check already filters `expires_at > NOW()`, so an expired reservation
 * never counts toward a budget even if the sweep hasn't run yet. The sweep just
 * keeps the table small. A missed tick catches up on the next one (hard cutoff,
 * not a moving window), and running twice is a no-op the second time.
 *
 * Modeled on usageRetentionCron.ts: setInterval + unref so it never holds the
 * process open, errors logged but never thrown.
 */
import { type DbClient, pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { sweepExpiredReservations } from './budgets/reservations.js'

const log = rootLogger.child({ service: 'budget_reservation_sweep' })

export async function sweepBudgetReservations(db: DbClient = pool): Promise<number> {
  try {
    const rowsDeleted = await sweepExpiredReservations(db)
    if (rowsDeleted > 0) {
      log.info(
        { event: 'budget_reservation_sweep_pruned', rowsDeleted },
        `pruned ${rowsDeleted} expired budget reservations`
      )
    }
    return rowsDeleted
  } catch (err) {
    log.error(
      {
        event: 'budget_reservation_sweep_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to sweep expired budget reservations'
    )
    return 0
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startBudgetReservationSweepCron(intervalMs: number): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    void sweepBudgetReservations().catch(err => {
      log.error(
        {
          event: 'budget_reservation_sweep_unhandled',
          err: err instanceof Error ? err.message : String(err),
        },
        'unhandled error in budget reservation sweep cron'
      )
    })
  }, intervalMs)
  intervalHandle.unref()
  log.info(
    { event: 'budget_reservation_sweep_started', intervalMs },
    'budget reservation sweep cron started'
  )
}

export function stopBudgetReservationSweepCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

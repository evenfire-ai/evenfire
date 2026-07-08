import { rootLogger } from '../observability/logger.js'
import { archiveTerminalApprovals } from './userApprovalRequestArchiveService.js'

/**
 * Daily archival cron.
 *
 * Schedules the first run at the next 02:00 UTC boundary, then repeats every
 * 24h. Picking an off-hours UTC window minimises overlap with operator work
 * and with DB maintenance windows. The timer is `unref()`'d so it does not
 * keep the Node process alive on shutdown.
 *
 * `retentionDays` defaults to 180 (user override of the original 90-day plan).
 */

let firstRunHandle: ReturnType<typeof setTimeout> | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null

const DAY_MS = 24 * 60 * 60 * 1000

export function millisUntilNext02UTC(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0, 0)
  )
  if (target.getTime() <= nowMs) {
    target.setUTCDate(target.getUTCDate() + 1)
  }
  return target.getTime() - nowMs
}

export function startArchiveCron(params: { retentionDays: number; batchSize: number }): void {
  if (firstRunHandle || intervalHandle) return

  const run = () => {
    archiveTerminalApprovals(params.retentionDays, params.batchSize).catch(err => {
      // Error metric + log already emitted in the service. Swallow here so the
      // interval keeps running on next day.
      rootLogger.warn(
        {
          event: 'approvals_archive_cron_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'archive cron iteration failed'
      )
    })
  }

  const delay = millisUntilNext02UTC()
  rootLogger.info(
    {
      event: 'approvals_archive_cron_started',
      firstRunInMs: delay,
      retentionDays: params.retentionDays,
      batchSize: params.batchSize,
    },
    'approval archive cron started'
  )

  firstRunHandle = setTimeout(() => {
    run()
    intervalHandle = setInterval(run, DAY_MS)
    intervalHandle.unref()
  }, delay)
  firstRunHandle.unref()
}

export function stopArchiveCron(): void {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle)
    firstRunHandle = null
  }
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  approvalsExpiredByCronTotal,
  approvalsExpiryDurationSeconds,
  approvalsExpiryRunsTotal,
} from '../observability/metrics.js'
import { expirePendingRequests } from './userApprovalRequestService.js'

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startExpiryCron(intervalMs: number): void {
  if (intervalHandle) return

  intervalHandle = setInterval(async () => {
    const startHr = process.hrtime.bigint()
    try {
      const expired = await expirePendingRequests()
      if (expired > 0) {
        approvalsExpiredByCronTotal.inc(expired)
        console.log(`[UserApprovalRequestExpiry] Expired ${expired} pending approval request(s)`)
      }

      // Clean up expired JTI revocation entries
      const revokedJtis = await pool.query(
        `DELETE FROM workflow_revoked_refresh_jtis WHERE expires_at < NOW()`
      )

      // Clean up stale rate limiter buckets (older than 1 hour)
      const staleBuckets = await pool.query(
        `DELETE FROM rate_limit_buckets WHERE window_start_ms < $1`,
        [Date.now() - 3600_000]
      )

      // Legacy workflow_trigger_idempotency table was dropped (DB-first
      // idempotency now lives on workflow_runs.idempotency_key + unique index).
      // The archive path carries terminal rows to workflow_runs_audit, which
      // preserves idempotency_key for historical lookup.

      approvalsExpiryRunsTotal.inc({ result: 'ok' }, 1)
      console.log(
        `[UserApprovalRequestExpiry] Sweep complete (expired=${expired}, revokedRefreshJtisDeleted=${revokedJtis.rowCount ?? 0}, staleBucketsDeleted=${staleBuckets.rowCount ?? 0})`
      )
      rootLogger.debug(
        {
          event: 'approval_expiry_sweep',
          expired,
          revokedRefreshJtisDeleted: revokedJtis.rowCount ?? 0,
        },
        'approval expiry sweep complete'
      )
    } catch (err) {
      approvalsExpiryRunsTotal.inc({ result: 'error' }, 1)
      console.error('[UserApprovalRequestExpiry] Error during expiry sweep:', err)
      rootLogger.error(
        {
          event: 'approval_expiry_sweep_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'approval expiry sweep failed'
      )
    } finally {
      const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9
      approvalsExpiryDurationSeconds.observe(durationSec)
    }
  }, intervalMs)

  intervalHandle.unref()
}

export function stopExpiryCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

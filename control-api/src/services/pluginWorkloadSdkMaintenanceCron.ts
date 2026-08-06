import { rootLogger } from '../observability/logger.js'
import { pluginWorkloadSdkMaintenanceRunsTotal } from '../observability/metrics.js'
import {
  failStaleInvocations,
  getPromptBridgeAttemptLeaseSeconds,
  prunePluginWorkloadSdkExpiredIdempotency,
} from './pluginWorkloadSdkDb.js'

// ─── Plugin Workload SDK — maintenance cron (plan §5.1, OQ-5) ────────────
// Two recovery paths per sweep:
//   1. Stale in_progress invocations → failed after the promptBridge timeout
//      plus grace (covers mcp-host restarts that dropped in-flight calls).
//   2. Idempotency pruning: terminal invocation rows older than the 24h
//      TTL are deleted so their keys become reusable in a new period.

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startPluginWorkloadSdkMaintenanceCron(intervalMs = 60_000): void {
  if (intervalHandle) return

  intervalHandle = setInterval(async () => {
    try {
      const failed = await failStaleInvocations(getPromptBridgeAttemptLeaseSeconds())
      const pruned = await prunePluginWorkloadSdkExpiredIdempotency()
      if (failed > 0 || pruned > 0) {
        rootLogger.info(
          { event: 'plugin_workload_sdk_maintenance_sweep', failed, pruned },
          'plugin workload sdk maintenance sweep complete'
        )
      }
      pluginWorkloadSdkMaintenanceRunsTotal.inc({ result: 'ok' }, 1)
    } catch (err) {
      pluginWorkloadSdkMaintenanceRunsTotal.inc({ result: 'error' }, 1)
      rootLogger.error(
        {
          event: 'plugin_workload_sdk_maintenance_sweep_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'plugin workload sdk maintenance sweep failed'
      )
    }
  }, intervalMs)
  intervalHandle.unref()
}

export function stopPluginWorkloadSdkMaintenanceCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

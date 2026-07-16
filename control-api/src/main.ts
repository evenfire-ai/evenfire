import { config } from './config.js'
import { initDb, pool } from './db.js'
import { K8sGateway } from './k8s.js'
import { assertRegistryConnectionReady } from './registryBootGuard.js'
import { ControlApiServer } from './server.js'
import {
  startAdminRevokedTokenCleanup,
  stopAdminRevokedTokenCleanup,
} from './services/adminAuthService.js'
import { runBootEnrollment } from './services/memberRegistrationEnrollment.js'
import {
  startBudgetReservationSweepCron,
  stopBudgetReservationSweepCron,
} from './services/budgetReservationSweepCron.js'
import {
  startPluginWorkloadSdkMaintenanceCron,
  stopPluginWorkloadSdkMaintenanceCron,
} from './services/pluginWorkloadSdkMaintenanceCron.js'
import { startRateLimiterCleanup, stopRateLimiterCleanup } from './services/rateLimiterService.js'
import { startUsageRetentionCron, stopUsageRetentionCron } from './services/usageRetentionCron.js'
import { startUsageRollupCron, stopUsageRollupCron } from './services/usageRollupCron.js'
import { startArchiveCron, stopArchiveCron } from './services/userApprovalRequestArchiveCron.js'
import { startExpiryCron, stopExpiryCron } from './services/userApprovalRequestExpiryCron.js'
import {
  startWorkflowApprovalNotificationDeliveryWorker,
  stopWorkflowApprovalNotificationDeliveryWorker,
} from './services/workflowApprovalNotificationDeliveryWorker.js'
import {
  startWorkflowRunsArchiveCron,
  stopWorkflowRunsArchiveCron,
} from './services/workflowRunsArchiveCron.js'
import {
  startWorkflowScheduleWorker,
  stopWorkflowScheduleWorker,
} from './services/workflowScheduleWorkerCron.js'
import { validateStartupGuards } from './startupGuards.js'

async function main(): Promise<void> {
  console.log('[ControlAPI] Starting')
  console.log(`[ControlAPI] Namespace: ${config.namespace}`)
  console.log(`[ControlAPI] Port: ${config.port}`)
  validateStartupGuards(config)
  console.log(
    `[ControlAPI] Allowed issuance namespaces: ${config.allowedIssuanceNamespaces.join(',')}`
  )

  await initDb()
  console.log('[ControlAPI] Database initialized')

  // Self-hosted fail-fast (spec §8 / §14.3): refuse to boot a registry-enabled
  // self-hosted deployment that has no registry_connection identity row.
  await assertRegistryConnectionReady()

  // Hosted member-registration self-enrollment (spec §8.4): degrade, never
  // block — runBootEnrollment never rejects; failures log and retry on demand.
  await runBootEnrollment()

  startExpiryCron(config.userApprovalRequestExpiryIntervalMs)
  startPluginWorkloadSdkMaintenanceCron()
  startRateLimiterCleanup(config.approvalRlCleanupIntervalMs)
  startAdminRevokedTokenCleanup(config.adminRevokedTokenCleanupIntervalMs)
  startUsageRollupCron({
    fiveMinIntervalMs: config.usageRollup5MinIntervalMs,
    hourlyIntervalMs: config.usageRollupHourlyIntervalMs,
    dailyIntervalMs: config.usageRollupDailyIntervalMs,
  })
  startUsageRetentionCron(config.usageRetentionIntervalMs)
  startBudgetReservationSweepCron(config.budgetReservationSweepIntervalMs)

  if (config.userApprovalRequestArchiveCronEnabled) {
    startArchiveCron({
      retentionDays: config.approvalRetentionDays,
      batchSize: config.userApprovalRequestArchiveBatchSize,
    })
    console.log(
      `[ControlAPI] Approval archive cron enabled (retention=${config.approvalRetentionDays}d, batch=${config.userApprovalRequestArchiveBatchSize})`
    )
  } else {
    console.log('[ControlAPI] Approval archive cron disabled (APPROVAL_ARCHIVE_CRON_ENABLED=false)')
  }

  const gateway = new K8sGateway(config.namespace)

  if (config.workflowRunsArchiveCronEnabled) {
    startWorkflowRunsArchiveCron({
      gateway,
      intervalMs: config.workflowRunsArchiveIntervalMs,
      graceMs: config.workflowRunsArchiveGraceMs,
      batchSize: config.workflowRunsArchiveBatchSize,
    })
    console.log(
      `[ControlAPI] Workflow-runs archive cron enabled (interval=${config.workflowRunsArchiveIntervalMs}ms, grace=${config.workflowRunsArchiveGraceMs}ms, batch=${config.workflowRunsArchiveBatchSize})`
    )
  } else {
    console.log(
      '[ControlAPI] Workflow-runs archive cron disabled (WORKFLOW_RUNS_ARCHIVE_CRON_ENABLED=false)'
    )
  }

  if (config.workflowScheduleWorkerEnabled) {
    startWorkflowScheduleWorker({
      intervalMs: config.workflowScheduleWorkerIntervalMs,
      batchSize: config.workflowScheduleWorkerBatchSize,
    })
    console.log(
      `[ControlAPI] Workflow schedule worker enabled (interval=${config.workflowScheduleWorkerIntervalMs}ms, batch=${config.workflowScheduleWorkerBatchSize})`
    )
  } else {
    console.log(
      '[ControlAPI] Workflow schedule worker disabled (WORKFLOW_SCHEDULE_WORKER_ENABLED=false)'
    )
  }

  if (config.workflowApprovalNotificationDeliveryEnabled) {
    // Pass the K8sGateway so the worker resolves each delivery's per-channel bot
    // from its CommunicationChannel Secret (Figure D multi-bot).
    startWorkflowApprovalNotificationDeliveryWorker(undefined, gateway)
    console.log(
      `[ControlAPI] Workflow approval notification delivery enabled (interval=${config.workflowApprovalNotificationDeliveryIntervalMs}ms, batch=${config.workflowApprovalNotificationDeliveryBatchSize})`
    )
  } else {
    console.log(
      '[ControlAPI] Workflow approval notification delivery disabled (WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_ENABLED=false)'
    )
  }

  const server = new ControlApiServer(gateway, config.port)

  await server.start()
  console.log('[ControlAPI] Running')
}

main().catch(error => {
  console.error('[ControlAPI] Fatal error:', error)
  stopExpiryCron()
  stopPluginWorkloadSdkMaintenanceCron()
  stopArchiveCron()
  stopWorkflowRunsArchiveCron()
  stopWorkflowScheduleWorker()
  stopWorkflowApprovalNotificationDeliveryWorker()
  stopRateLimiterCleanup()
  stopAdminRevokedTokenCleanup()
  stopUsageRollupCron()
  stopUsageRetentionCron()
  stopBudgetReservationSweepCron()
  void pool.end()
  process.exit(1)
})

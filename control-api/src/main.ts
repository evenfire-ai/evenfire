import { config } from './config.js'
import { assertDbReady, pool } from './db.js'
import { K8sGateway } from './k8s.js'
import { reconcileAllowedModelsConfigMapOnBoot } from './llmAllowedModelsBootReconcile.js'
import { logRegistryConnectionState } from './registryBootGuard.js'
import { ControlApiServer } from './server.js'
import {
  startAdminRevokedTokenCleanup,
  stopAdminRevokedTokenCleanup,
} from './services/adminAuthService.js'
import {
  startBudgetReservationSweepCron,
  stopBudgetReservationSweepCron,
} from './services/budgetReservationSweepCron.js'
import { runBootEnrollment } from './services/memberRegistrationEnrollment.js'
import {
  startPluginWorkloadSdkMaintenanceCron,
  stopPluginWorkloadSdkMaintenanceCron,
} from './services/pluginWorkloadSdkMaintenanceCron.js'
import { startRateLimiterCleanup, stopRateLimiterCleanup } from './services/rateLimiterService.js'
import {
  startWorkflowApprovalTraceProjector,
  stopWorkflowApprovalTraceProjector,
} from './services/tracing/workflowApprovalTraceProjector.js'
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

  await assertDbReady()
  console.log('[ControlAPI] Database schema ready')

  // Observability only (never fatal): report whether this self-hosted deployment
  // holds a registry identity. Auth is derived from credential presence, so a
  // missing row simply means auth is inactive until the connect flow runs.
  await logRegistryConnectionState()

  // Anti-drift (spec §3-R3.4 / V7): re-materialize the LLM allowlist ConfigMap
  // from Postgres. Non-fatal — logs + metric on failure, never aborts boot.
  await reconcileAllowedModelsConfigMapOnBoot()

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
  startWorkflowApprovalTraceProjector()

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

  // Hosted member-registration self-enrollment (spec §8.4): degrade, never
  // block. Fire-and-forget, and only AFTER the listener is up — the liveness
  // probe has no startupProbe grace (control-api.yaml: initialDelaySeconds=8,
  // periodSeconds=12, failureThreshold=3 ≈ 32s), and a silently dropped hub
  // (egress firewall / default-deny NetworkPolicy) can burn up to 20s of that
  // budget on its own. Nothing is gained by awaiting it here: the hook never
  // rejects, every send re-attempts enrollment on demand via ensureEnrollment,
  // and the in-flight map dedupes any request that races this boot call.
  void runBootEnrollment()
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
  stopWorkflowApprovalTraceProjector()
  void pool.end()
  process.exit(1)
})

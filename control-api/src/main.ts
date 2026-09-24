import { config } from './config.js'
import { assertDbReady, pool, rateLimitPool } from './db.js'
import { K8sGateway } from './k8s.js'
import { reconcileAllowedModelsConfigMapOnBoot } from './llmAllowedModelsBootReconcile.js'
import { rootLogger } from './observability/logger.js'
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
import {
  startEntityChangeDispatcher,
  stopEntityChangeDispatcher,
} from './services/entityChangeService.js'
import { syncDiscoveredModels } from './services/llmCatalogSync.js'
import { startLlmCatalogSyncCron, stopLlmCatalogSyncCron } from './services/llmCatalogSyncCron.js'
import { runBootEnrollment } from './services/memberRegistrationEnrollment.js'
import {
  startPluginWorkloadSdkMaintenanceCron,
  stopPluginWorkloadSdkMaintenanceCron,
} from './services/pluginWorkloadSdkMaintenanceCron.js'
import { startRateLimiterCleanup, stopRateLimiterCleanup } from './services/rateLimiterService.js'
import {
  reconcileRegistryPullSecret,
  startRegistryPullSecretReconcileCron,
  stopRegistryPullSecretReconcileCron,
} from './services/registryPullSecretReconcileCron.js'
import {
  reconcileSubscriptionCatalogsFromEnv,
  startSubscriptionCatalogSyncCron,
  stopSubscriptionCatalogSyncCron,
} from './services/subscriptionCatalogSyncCron.js'
import { closeTracingPools } from './services/tracing/pools.js'
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
import {
  createControlApiShutdownSteps,
  createShutdownHandler,
  runShutdownSteps,
} from './shutdown.js'
import { validateStartupGuards } from './startupGuards.js'

const CONTROL_API_SHUTDOWN_TIMEOUT_MS = 25_000
const logger = rootLogger.child({ module: 'control-api-shutdown' })
let activeServer: ControlApiServer | null = null
let requestedExitCode = 0
let shutdownRequested = false

const shutdown = createShutdownHandler(async () => {
  const result = await runShutdownSteps(
    createControlApiShutdownSteps({
      'http-server-and-streams': () => activeServer?.stop(),
      'approval-expiry-cron': stopExpiryCron,
      'plugin-sdk-maintenance-cron': stopPluginWorkloadSdkMaintenanceCron,
      'rate-limit-cleanup': stopRateLimiterCleanup,
      'revoked-token-cleanup': stopAdminRevokedTokenCleanup,
      'usage-rollup-cron': stopUsageRollupCron,
      'usage-retention-cron': stopUsageRetentionCron,
      'budget-reservation-sweep': stopBudgetReservationSweepCron,
      'approval-archive-cron': stopArchiveCron,
      'llm-catalog-sync-cron': stopLlmCatalogSyncCron,
      'subscription-catalog-sync-cron': stopSubscriptionCatalogSyncCron,
      'registry-pull-secret-cron': stopRegistryPullSecretReconcileCron,
      'workflow-runs-archive-cron': stopWorkflowRunsArchiveCron,
      'workflow-schedule-worker': stopWorkflowScheduleWorker,
      'workflow-approval-notification-worker': stopWorkflowApprovalNotificationDeliveryWorker,
      'workflow-approval-trace-projector': stopWorkflowApprovalTraceProjector,
      'entity-change-dispatcher': stopEntityChangeDispatcher,
      'core-database-pool': () => pool.end(),
      'rate-limit-database-pool': () => rateLimitPool.end(),
      'trace-database-pools': closeTracingPools,
    }),
    CONTROL_API_SHUTDOWN_TIMEOUT_MS
  )
  for (const failure of result.errors) {
    logger.error(
      { event: 'control_api_shutdown_step_failed', step: failure.name, err: failure.error },
      'Control API shutdown step failed'
    )
  }
  if (result.timedOut) {
    logger.error(
      { event: 'control_api_shutdown_timed_out', timeoutMs: CONTROL_API_SHUTDOWN_TIMEOUT_MS },
      'Control API shutdown exceeded its deadline'
    )
  }
  process.exit(requestedExitCode || result.errors.length > 0 || result.timedOut ? 1 : 0)
})

const requestShutdown = () => {
  shutdownRequested = true
  void shutdown()
}
process.once('SIGTERM', requestShutdown)
process.once('SIGINT', requestShutdown)

function ensureStartupActive(): void {
  if (shutdownRequested) throw new Error('Control API startup interrupted by shutdown')
}

async function main(): Promise<void> {
  logger.info({ event: 'control_api_starting', namespace: config.namespace, port: config.port })
  validateStartupGuards(config)
  logger.info(
    { event: 'control_api_issuance_namespaces', namespaces: config.allowedIssuanceNamespaces },
    'Allowed issuance namespaces'
  )

  await assertDbReady()
  ensureStartupActive()
  logger.info({ event: 'control_api_database_ready' }, 'Database schema ready')
  startEntityChangeDispatcher()

  // Observability only (never fatal): report whether this self-hosted deployment
  // holds a registry identity. Auth is derived from credential presence, so a
  // missing row simply means auth is inactive until the connect flow runs.
  await logRegistryConnectionState()
  ensureStartupActive()

  // Anti-drift (spec §3-R3.4 / V7): re-materialize the LLM allowlist ConfigMap
  // from Postgres. Non-fatal — logs + metric on failure, never aborts boot.
  await reconcileAllowedModelsConfigMapOnBoot()
  ensureStartupActive()

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
    logger.info(
      {
        event: 'control_api_approval_archive_enabled',
        retentionDays: config.approvalRetentionDays,
        batchSize: config.userApprovalRequestArchiveBatchSize,
      },
      'Approval archive cron enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_approval_archive_disabled' },
      'Approval archive cron disabled'
    )
  }

  const gateway = new K8sGateway(config.namespace)

  // LLM catalog discovery sync cron (Fase 4). Code default off; the base deploy
  // sets LLM_CATALOG_SYNC_CRON_ENABLED=true. When on, the first sync runs a few
  // seconds after start (not awaited — boot never waits on models.dev), then
  // every interval. Non-destructive: inserts disabled discovery rows, only
  // stale-flags vanished ones under the §4.5 guards.
  // Started AFTER the gateway exists (#654): the sync publishes the allowlist
  // ConfigMap when it changes image-input evidence on an enabled row, so it
  // needs a materializer — the same one the admin routes use.
  if (config.llmCatalogSyncCronEnabled) {
    startLlmCatalogSyncCron(
      { sync: () => syncDiscoveredModels({ materializer: gateway.llmAllowedModelsConfigMap() }) },
      config.llmCatalogSyncIntervalMs
    )
    logger.info(
      {
        event: 'control_api_llm_catalog_sync_enabled',
        intervalMs: config.llmCatalogSyncIntervalMs,
      },
      'LLM catalog sync cron enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_llm_catalog_sync_disabled' },
      'LLM catalog sync cron disabled'
    )
  }

  // Subscription catalog reconciliation. A grant's catalog is written once at
  // connect and never refreshed on its own, so a model the vendor publishes
  // afterwards stays invisible to the subscription while the API-key provider of
  // the SAME vendor picks it up from the discovery sync above. The tick re-runs
  // the identical per-connection sync the Hub's manual action drives, and needs
  // the gateway for the same reason: it publishes the allowlist ConfigMap on
  // every tick — unconditionally, like `reconcileAllowedModelsConfigMapOnBoot`
  // above, so a publish that threw converges on the next tick instead of
  // stranding a stale runtime snapshot. Per-broker gates still apply inside the
  // tick.
  if (config.subscriptionCatalogSyncCronEnabled) {
    startSubscriptionCatalogSyncCron(
      { sync: () => reconcileSubscriptionCatalogsFromEnv(gateway.llmAllowedModelsConfigMap()) },
      config.subscriptionCatalogSyncIntervalMs
    )
    logger.info(
      {
        event: 'control_api_subscription_catalog_sync_enabled',
        intervalMs: config.subscriptionCatalogSyncIntervalMs,
      },
      'Subscription catalog sync cron enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_subscription_catalog_sync_disabled' },
      'Subscription catalog sync cron disabled'
    )
  }

  // Assert the platform image-pull credential up front and then on a timer. WRC injects
  // the reference for ANY WorkflowRecipe, including ones created by `kubectl apply` or the
  // `deploy_recipe` tool that control-api never sees — so provisioning cannot only happen
  // on our own install routes. Non-fatal: an unconnected cluster logs and retries.
  void reconcileRegistryPullSecret(gateway)
  startRegistryPullSecretReconcileCron(gateway, config.registryPullSecretReconcileIntervalMs)

  if (config.workflowRunsArchiveCronEnabled) {
    startWorkflowRunsArchiveCron({
      gateway,
      intervalMs: config.workflowRunsArchiveIntervalMs,
      graceMs: config.workflowRunsArchiveGraceMs,
      batchSize: config.workflowRunsArchiveBatchSize,
    })
    logger.info(
      {
        event: 'control_api_workflow_runs_archive_enabled',
        intervalMs: config.workflowRunsArchiveIntervalMs,
        graceMs: config.workflowRunsArchiveGraceMs,
        batchSize: config.workflowRunsArchiveBatchSize,
      },
      'Workflow-runs archive cron enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_workflow_runs_archive_disabled' },
      'Workflow-runs archive cron disabled'
    )
  }

  if (config.workflowScheduleWorkerEnabled) {
    startWorkflowScheduleWorker({
      intervalMs: config.workflowScheduleWorkerIntervalMs,
      batchSize: config.workflowScheduleWorkerBatchSize,
    })
    logger.info(
      {
        event: 'control_api_workflow_schedule_worker_enabled',
        intervalMs: config.workflowScheduleWorkerIntervalMs,
        batchSize: config.workflowScheduleWorkerBatchSize,
      },
      'Workflow schedule worker enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_workflow_schedule_worker_disabled' },
      'Workflow schedule worker disabled'
    )
  }

  if (config.workflowApprovalNotificationDeliveryEnabled) {
    // Pass the K8sGateway so the worker resolves each delivery's per-channel bot
    // from its CommunicationChannel Secret (Figure D multi-bot).
    startWorkflowApprovalNotificationDeliveryWorker(undefined, gateway)
    logger.info(
      {
        event: 'control_api_workflow_approval_delivery_enabled',
        intervalMs: config.workflowApprovalNotificationDeliveryIntervalMs,
        batchSize: config.workflowApprovalNotificationDeliveryBatchSize,
      },
      'Workflow approval notification delivery enabled'
    )
  } else {
    logger.info(
      { event: 'control_api_workflow_approval_delivery_disabled' },
      'Workflow approval delivery disabled'
    )
  }

  const server = new ControlApiServer(gateway, config.port)
  activeServer = server

  await server.start()
  ensureStartupActive()
  logger.info({ event: 'control_api_running' }, 'Control API running')

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
  if (shutdownRequested) return
  requestedExitCode = 1
  logger.fatal({ event: 'control_api_startup_failed', err: error }, 'Control API startup failed')
  void shutdown()
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Boot wiring of main.ts: it must wait for Postgres before checking the schema.
// Every module main.ts imports is replaced, so importing it runs main() with no
// database, no Kubernetes and no server. main() stops at the mocked database.

const db = vi.hoisted(() => ({
  waitForDbConnection: vi.fn(),
  assertDbReady: vi.fn(),
  pool: { end: vi.fn() },
  rateLimitPool: { end: vi.fn() },
}))
const log = vi.hoisted(() => {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
  l.child.mockReturnValue(l)
  return l
})

vi.mock('../src/db.js', () => db)
vi.mock('../src/observability/logger.js', () => ({ rootLogger: log }))
vi.mock('../src/config.js', () => ({
  config: { namespace: 'mcp-server', port: 0, allowedIssuanceNamespaces: [] },
}))
vi.mock('../src/startupGuards.js', () => ({ validateStartupGuards: vi.fn() }))
vi.mock('../src/k8s.js', () => ({ K8sGateway: vi.fn() }))
vi.mock('../src/server.js', () => ({ ControlApiServer: vi.fn() }))
vi.mock('../src/llmAllowedModelsBootReconcile.js', () => ({
  reconcileAllowedModelsConfigMapOnBoot: vi.fn(),
}))
vi.mock('../src/registryBootGuard.js', () => ({ logRegistryConnectionState: vi.fn() }))
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: vi.fn(),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  startAdminRevokedTokenCleanup: vi.fn(),
  stopAdminRevokedTokenCleanup: vi.fn(),
}))
vi.mock('../src/services/budgetReservationSweepCron.js', () => ({
  startBudgetReservationSweepCron: vi.fn(),
  stopBudgetReservationSweepCron: vi.fn(),
}))
vi.mock('../src/services/entityChangeService.js', () => ({
  startEntityChangeDispatcher: vi.fn(),
  stopEntityChangeDispatcher: vi.fn(),
}))
vi.mock('../src/services/llmCatalogSync.js', () => ({ syncDiscoveredModels: vi.fn() }))
vi.mock('../src/services/llmCatalogSyncCron.js', () => ({
  startLlmCatalogBootSync: vi.fn(),
  startLlmCatalogSyncCron: vi.fn(),
  stopLlmCatalogSyncCron: vi.fn(),
}))
vi.mock('../src/services/memberRegistrationEnrollment.js', () => ({ runBootEnrollment: vi.fn() }))
vi.mock('../src/services/oauthProactiveRefreshCron.js', () => ({
  REACTIVE_REFRESH_BUFFER_MS: 0,
  startOauthProactiveRefreshCron: vi.fn(),
  stopOauthProactiveRefreshCron: vi.fn(),
}))
vi.mock('../src/services/oauthSharedGrantSweepCron.js', () => ({
  runSharedGrantSweep: vi.fn(),
  startOauthSharedGrantSweepCron: vi.fn(),
  stopOauthSharedGrantSweepCron: vi.fn(),
}))
vi.mock('../src/services/pluginWorkloadSdkMaintenanceCron.js', () => ({
  startPluginWorkloadSdkMaintenanceCron: vi.fn(),
  stopPluginWorkloadSdkMaintenanceCron: vi.fn(),
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  startRateLimiterCleanup: vi.fn(),
  stopRateLimiterCleanup: vi.fn(),
}))
vi.mock('../src/services/registryPullSecretReconcileCron.js', () => ({
  reconcileRegistryPullSecret: vi.fn(),
  startRegistryPullSecretReconcileCron: vi.fn(),
  stopRegistryPullSecretReconcileCron: vi.fn(),
}))
vi.mock('../src/services/subscriptionCatalogSyncCron.js', () => ({
  reconcileSubscriptionCatalogsFromEnv: vi.fn(),
  startSubscriptionCatalogSyncCron: vi.fn(),
  stopSubscriptionCatalogSyncCron: vi.fn(),
}))
vi.mock('../src/services/tracing/pools.js', () => ({ closeTracingPools: vi.fn() }))
vi.mock('../src/services/tracing/workflowApprovalTraceProjector.js', () => ({
  startWorkflowApprovalTraceProjector: vi.fn(),
  stopWorkflowApprovalTraceProjector: vi.fn(),
}))
vi.mock('../src/services/usageRetentionCron.js', () => ({
  startUsageRetentionCron: vi.fn(),
  stopUsageRetentionCron: vi.fn(),
}))
vi.mock('../src/services/usageRollupCron.js', () => ({
  startUsageRollupCron: vi.fn(),
  stopUsageRollupCron: vi.fn(),
}))
vi.mock('../src/services/userApprovalRequestArchiveCron.js', () => ({
  startArchiveCron: vi.fn(),
  stopArchiveCron: vi.fn(),
}))
vi.mock('../src/services/userApprovalRequestExpiryCron.js', () => ({
  startExpiryCron: vi.fn(),
  stopExpiryCron: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalNotificationDeliveryWorker.js', () => ({
  startWorkflowApprovalNotificationDeliveryWorker: vi.fn(),
  stopWorkflowApprovalNotificationDeliveryWorker: vi.fn(),
}))
vi.mock('../src/services/workflowRunsArchiveCron.js', () => ({
  startWorkflowRunsArchiveCron: vi.fn(),
  stopWorkflowRunsArchiveCron: vi.fn(),
}))
vi.mock('../src/services/workflowScheduleWorkerCron.js', () => ({
  startWorkflowScheduleWorker: vi.fn(),
  stopWorkflowScheduleWorker: vi.fn(),
}))

const startupFailed = () =>
  log.fatal.mock.calls.filter(
    ([fields]) => (fields as { event?: string }).event === 'control_api_startup_failed'
  )

let exitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  log.child.mockReturnValue(log)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(() => {
  exitSpy.mockRestore()
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('control-api boot: database wait', () => {
  it('waits for Postgres before checking the schema, and a schema failure still fails the boot', async () => {
    const sentinel = new Error('schema not ready')
    db.waitForDbConnection.mockResolvedValue(undefined)
    db.assertDbReady.mockRejectedValue(sentinel)

    await import('../src/main.js')
    await vi.waitFor(() => expect(startupFailed()).toHaveLength(1))

    expect(db.waitForDbConnection).toHaveBeenCalledTimes(1)
    expect(db.assertDbReady).toHaveBeenCalledTimes(1)
    expect(db.waitForDbConnection.mock.invocationCallOrder[0]).toBeLessThan(
      db.assertDbReady.mock.invocationCallOrder[0]
    )
    // The wait is tied to shutdown: main passes its startup guard.
    const [options] = db.waitForDbConnection.mock.calls[0] as [{ ensureActive: () => void }]
    expect(options.ensureActive).toEqual(expect.any(Function))
    expect((startupFailed()[0][0] as { err: unknown }).err).toBe(sentinel)
    // The existing fatal path still ends the process with exit code 1.
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
  })

  it('does not report a startup failure when SIGTERM arrives during the wait', async () => {
    let failWait: (error: Error) => void = () => undefined
    db.waitForDbConnection.mockImplementation(
      () => new Promise((_resolve, reject) => (failWait = reject))
    )

    await import('../src/main.js')
    // Witness: boot reached the wait.
    await vi.waitFor(() => expect(db.waitForDbConnection).toHaveBeenCalledTimes(1))

    process.emit('SIGTERM')
    failWait(new Error('Control API startup interrupted by shutdown'))
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())

    expect(startupFailed()).toHaveLength(0)
    expect(db.assertDbReady).not.toHaveBeenCalled()
  })
})

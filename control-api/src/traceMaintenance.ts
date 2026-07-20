import { rootLogger } from './observability/logger.js'
import {
  canonicalTracingClusterLocation,
  canonicalTracingClusterName,
  canonicalTracingEnvironment,
} from './services/tracing/environment.js'
import {
  InfrastructureTelemetryEventService,
  type TraceMaintenanceInfrastructurePrincipal,
} from './services/tracing/infrastructureTelemetryEvents.js'
import {
  gcpBigQueryBillingConfigFromEnv,
  loadNormalizedGcpBillingRows,
} from './services/tracing/maintenance/gcpBigQueryBillingAdapter.js'
import {
  gcpBigQueryPricingConfigFromEnv,
  loadNormalizedGcpPricingEvidence,
} from './services/tracing/maintenance/gcpBigQueryPricingAdapter.js'
import { appendInventorySnapshotInChunks } from './services/tracing/maintenance/inventoryAppender.js'
import { createControlPlaneInventoryCache } from './services/tracing/maintenance/inventorySampler.js'
import {
  type MaintenanceCostPersistenceConfig,
  closedUtcDayRange,
  runMaintenanceCostPersistence,
} from './services/tracing/maintenance/maintenanceCostService.js'
import { runRetentionBatch } from './services/tracing/maintenance/retention.js'
import {
  TraceMaintenanceShutdownCoordinator,
  type TraceMaintenanceShutdownSignal,
  waitForAbortableDelay,
} from './services/tracing/maintenance/workerLifecycle.js'
import { closeTraceMaintenancePool, withTraceMaintenanceClient } from './services/tracing/pools.js'

const WAKE_INTERVAL_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 25_000
const GCP_EVIDENCE_ERROR_RETRY_MS = 900_000
const DEFAULT_COST_ROLLUP_INTERVAL_MS = 3_600_000

const maintenancePrincipal: TraceMaintenanceInfrastructurePrincipal = {
  kind: 'trace_maintenance',
  sourceService: 'control-api',
  serviceSub: 'trace-maintenance-worker',
  credentialId: 'in-process',
  resourceAuthority: 'control_plane_inventory',
  allowedTelemetryTypes: ['capacity_sample'],
}

const inventory = createControlPlaneInventoryCache()
let wakeInFlight = false
let nextGcpBillingImportAt = 0
let nextGcpPricingImportAt = 0
let nextCostRollupAt = 0

function boundedEnvInteger(input: {
  name: string
  fallback: number
  minimum: number
  maximum: number
}): number {
  const value = process.env[input.name]?.trim()
  if (!value) return input.fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < input.minimum || parsed > input.maximum) {
    throw new Error(
      `${input.name} must be an integer between ${input.minimum} and ${input.maximum}`
    )
  }
  return parsed
}

function costPersistenceConfig(): MaintenanceCostPersistenceConfig {
  const enabled = process.env.TRACING_INFRASTRUCTURE_COST_ENABLED === 'true'
  return {
    enabled,
    cloudProjectId: process.env.GCP_PROJECT_ID?.trim() ?? '',
    clusterLocation: enabled ? canonicalTracingClusterLocation() : '',
    clusterClass: process.env.KUBERNETES_CLUSTER_CLASS?.trim() ?? '',
    currency: process.env.TRACING_INFRASTRUCTURE_COST_CURRENCY?.trim() ?? 'USD',
    requestedCapacityLookbackDays: boundedEnvInteger({
      name: 'TRACING_INFRASTRUCTURE_COST_LOOKBACK_DAYS',
      fallback: 7,
      minimum: 1,
      maximum: 31,
    }),
    requestedCapacityFinalizationDelayHours: boundedEnvInteger({
      name: 'TRACING_INFRASTRUCTURE_COST_FINALIZATION_DELAY_HOURS',
      fallback: 24,
      minimum: 1,
      maximum: 168,
    }),
  }
}

async function loadBilledCostEvidence(now: Date, costConfig: MaintenanceCostPersistenceConfig) {
  if (!costConfig.enabled) {
    return {
      rows: [],
      finalizationDelayHours: 96,
      outcome: 'disabled' as const,
      exportLagSeconds: null,
    }
  }
  try {
    const config = gcpBigQueryBillingConfigFromEnv({
      target: {
        cloudProjectId: costConfig.cloudProjectId,
        clusterLocation: costConfig.clusterLocation,
        clusterName: canonicalTracingClusterName(),
        environment: canonicalTracingEnvironment(),
      },
    })
    if (!config.enabled || now.getTime() < nextGcpBillingImportAt) {
      return {
        rows: [],
        finalizationDelayHours: config.enabled ? config.finalizationDelayHours : 96,
        outcome: config.enabled ? ('cadence' as const) : ('disabled' as const),
        exportLagSeconds: null,
      }
    }
    nextGcpBillingImportAt = now.getTime() + config.importIntervalMs
    const range = closedUtcDayRange(now, config.lookbackDays)
    const rows = await loadNormalizedGcpBillingRows({
      config,
      ...range,
      now,
    })
    const latestWatermark = rows
      .map(row => Date.parse(row.exportWatermark))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0]
    return {
      rows,
      finalizationDelayHours: config.finalizationDelayHours,
      outcome: rows.length === 0 ? ('empty' as const) : ('success' as const),
      exportLagSeconds:
        latestWatermark === undefined
          ? null
          : Math.max(0, (now.getTime() - latestWatermark) / 1_000),
    }
  } catch (error) {
    nextGcpBillingImportAt = now.getTime() + GCP_EVIDENCE_ERROR_RETRY_MS
    rootLogger.error({ err: error }, 'normalized GCP billing import failed')
    return {
      rows: [],
      finalizationDelayHours: 96,
      outcome: 'error' as const,
      exportLagSeconds: null,
    }
  }
}

async function loadPriceEvidence(now: Date, costConfig: MaintenanceCostPersistenceConfig) {
  if (!costConfig.enabled) return { evidence: [], outcome: 'disabled' as const }
  try {
    const config = gcpBigQueryPricingConfigFromEnv({
      target: {
        cloudProjectId: costConfig.cloudProjectId,
        region: costConfig.clusterLocation,
        clusterClass: costConfig.clusterClass,
        currency: costConfig.currency,
      },
    })
    if (!config.enabled || now.getTime() < nextGcpPricingImportAt) {
      return {
        evidence: [],
        outcome: config.enabled ? ('cadence' as const) : ('disabled' as const),
      }
    }
    nextGcpPricingImportAt = now.getTime() + config.importIntervalMs
    const evidence = await loadNormalizedGcpPricingEvidence({ config, now })
    return {
      evidence,
      outcome: evidence.length === 0 ? ('empty' as const) : ('success' as const),
    }
  } catch (error) {
    nextGcpPricingImportAt = now.getTime() + GCP_EVIDENCE_ERROR_RETRY_MS
    rootLogger.error({ err: error }, 'normalized GCP pricing import failed')
    return { evidence: [], outcome: 'error' as const }
  }
}

async function appendInventory(client: import('./db.js').DbClient, now: Date): Promise<number> {
  const snapshot = inventory.snapshot(now)
  if (snapshot.workloads.length === 0) return 0
  const service = new InfrastructureTelemetryEventService({
    transaction: async () => {
      throw new Error('maintenance append requires caller transaction')
    },
    now: () => now,
  })
  return appendInventorySnapshotInChunks({
    client,
    service,
    principal: maintenancePrincipal,
    snapshot,
    now,
    environment: canonicalTracingEnvironment(),
    clusterName: canonicalTracingClusterName(),
  })
}

async function inspectStreamRegistrationGaps(
  client: import('./db.js').DbClient
): Promise<Record<string, number>> {
  // This is the family-to-stream transaction invariant, not producer ordering.
  // Postgres sequences may have legitimate holes; producer reporters own
  // drop/gap signals and validation gates use independent expected occurrences.
  const result = await client.query(`
    SELECT 'agent_run' AS family, COUNT(*)::int AS gap_count
      FROM (SELECT event_id FROM agent_run_events ORDER BY ingest_sequence DESC LIMIT 1000) event
      LEFT JOIN governed_event_stream stream
        ON stream.event_family = 'agent_run' AND stream.event_id = event.event_id
     WHERE stream.event_id IS NULL
    UNION ALL
    SELECT 'administrative', COUNT(*)::int
      FROM (SELECT event_id FROM administrative_events ORDER BY ingest_sequence DESC LIMIT 1000) event
      LEFT JOIN governed_event_stream stream
        ON stream.event_family = 'administrative' AND stream.event_id = event.event_id
     WHERE stream.event_id IS NULL
    UNION ALL
    SELECT 'infrastructure_telemetry', COUNT(*)::int
      FROM (SELECT event_id FROM infrastructure_telemetry_events ORDER BY ingest_sequence DESC LIMIT 1000) event
      LEFT JOIN governed_event_stream stream
        ON stream.event_family = 'infrastructure_telemetry' AND stream.event_id = event.event_id
     WHERE stream.event_id IS NULL
  `)
  const gaps: Record<string, number> = {}
  for (const row of result.rows as Array<{ family: string; gap_count: number }>) {
    gaps[row.family] = Number(row.gap_count)
  }
  return gaps
}

async function wake(): Promise<void> {
  if (wakeInFlight) {
    rootLogger.warn({ outcome: 'overlap_prevented' }, 'trace maintenance wake overlap prevented')
    return
  }
  wakeInFlight = true
  const startedAt = Date.now()
  let outcome = 'failed'
  let costRollupAttempted = false
  try {
    const now = new Date()
    const costConfig = costPersistenceConfig()
    const costRollupIntervalMs = boundedEnvInteger({
      name: 'TRACING_INFRASTRUCTURE_COST_ROLLUP_INTERVAL_MS',
      fallback: DEFAULT_COST_ROLLUP_INTERVAL_MS,
      minimum: 300_000,
      maximum: 86_400_000,
    })
    costRollupAttempted = costConfig.enabled && now.getTime() >= nextCostRollupAt
    if (costRollupAttempted) nextCostRollupAt = now.getTime() + costRollupIntervalMs
    // Remote cost evidence is fetched before any Postgres checkout or transaction.
    const [gcpBillingEvidence, gcpPricingEvidence] = costRollupAttempted
      ? await Promise.all([
          loadBilledCostEvidence(now, costConfig),
          loadPriceEvidence(now, costConfig),
        ])
      : [
          {
            rows: [],
            finalizationDelayHours: 96,
            outcome: costConfig.enabled ? ('cadence' as const) : ('disabled' as const),
            exportLagSeconds: null,
          },
          {
            evidence: [],
            outcome: costConfig.enabled ? ('cadence' as const) : ('disabled' as const),
          },
        ]
    await withTraceMaintenanceClient(async client => {
      try {
        await client.query('BEGIN')
        const lock = await client.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('governed-trace-maintenance-v1')) AS acquired"
        )
        if (!lock.rows[0]?.acquired) {
          outcome = 'lock_not_acquired'
          await client.query('ROLLBACK')
          rootLogger.info(
            { outcome, durationMs: Date.now() - startedAt },
            'trace maintenance wake skipped because the advisory lock was not acquired'
          )
          return
        }
        await client.query("SELECT set_config('statement_timeout', '30000', true)")
        const streamRegistrationGaps = await inspectStreamRegistrationGaps(client)
        if (Object.values(streamRegistrationGaps).some(count => count > 0)) {
          rootLogger.error(
            { streamRegistrationGaps },
            'governed trace stream registration invariant violated'
          )
        }
        const inventoryEvents = await appendInventory(client, now)
        const costPersistence = costRollupAttempted
          ? await runMaintenanceCostPersistence({
              db: client,
              now,
              config: costConfig,
              normalizedGcpBillingRows: gcpBillingEvidence.rows,
              gcpBillingFinalizationDelayHours: gcpBillingEvidence.finalizationDelayHours,
              priceSnapshots: gcpPricingEvidence.evidence,
            })
          : {
              priceSnapshotsInserted: 0,
              requestedCapacityVersions: 0,
              billedVersions: 0,
              skippedReason: costConfig.enabled ? 'cadence' : 'disabled',
            }
        const result = await runRetentionBatch(client)
        await client.query('COMMIT')
        outcome = 'completed'
        rootLogger.info(
          {
            ...result,
            inventoryEvents,
            costPersistence,
            streamRegistrationGaps,
            gcpBilling: {
              outcome: gcpBillingEvidence.outcome,
              rowCount: gcpBillingEvidence.rows.length,
              exportLagSeconds: gcpBillingEvidence.exportLagSeconds,
            },
            gcpPricing: {
              outcome: gcpPricingEvidence.outcome,
              snapshotCount: gcpPricingEvidence.evidence.length,
            },
            durationMs: Date.now() - startedAt,
          },
          'trace maintenance wake completed'
        )
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    })
  } catch (error) {
    if (costRollupAttempted) {
      const retryAt = Date.now() + GCP_EVIDENCE_ERROR_RETRY_MS
      nextCostRollupAt = Math.min(nextCostRollupAt, retryAt)
      nextGcpBillingImportAt = Math.min(nextGcpBillingImportAt, retryAt)
      nextGcpPricingImportAt = Math.min(nextGcpPricingImportAt, retryAt)
    }
    rootLogger.error(
      { err: error, outcome, durationMs: Date.now() - startedAt },
      'trace maintenance wake failed'
    )
  } finally {
    wakeInFlight = false
  }
}

async function main(): Promise<void> {
  const shutdown = new TraceMaintenanceShutdownCoordinator({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    onRequested: signal => {
      rootLogger.info({ signal }, 'trace maintenance shutdown requested')
    },
    onCompleted: signal => {
      rootLogger.info({ signal, outcome: 'completed' }, 'trace maintenance shutdown completed')
    },
    onTimedOut: (signal, timeoutMs) => {
      rootLogger.error(
        { signal, timeoutMs, outcome: 'timeout' },
        'trace maintenance shutdown timed out with a wake still in flight'
      )
    },
    exit: code => process.exit(code),
  })
  const requestShutdown = (signal: TraceMaintenanceShutdownSignal) => {
    shutdown.request(signal)
  }
  const onSigterm = () => requestShutdown('SIGTERM')
  const onSigint = () => requestShutdown('SIGINT')
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)

  let inventoryStarted = false
  try {
    await inventory.start()
    inventoryStarted = true
    while (!shutdown.signal.aborted) {
      await wake()
      if (!shutdown.signal.aborted) {
        await waitForAbortableDelay(WAKE_INTERVAL_MS, shutdown.signal)
      }
    }
  } finally {
    const cleanup = await Promise.allSettled([
      inventoryStarted ? inventory.stop() : Promise.resolve(),
      closeTraceMaintenancePool(),
    ])
    const failedCleanup = cleanup.find(result => result.status === 'rejected')
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
    if (failedCleanup?.status === 'rejected') throw failedCleanup.reason
    shutdown.finish()
  }
}

void main().catch(error => {
  rootLogger.error({ err: error }, 'trace maintenance worker terminated unexpectedly')
  process.exitCode = 1
})

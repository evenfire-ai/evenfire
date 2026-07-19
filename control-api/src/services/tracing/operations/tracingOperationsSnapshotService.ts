import {
  TRACING_JSON_BODY_LIMIT_BYTES,
  TRACING_MAX_BATCH_SIZE,
  getTracingMaxInFlight,
  getTracingOperationsRecentErrorSeconds,
  getTracingPoolOperationalLimits,
} from '../operationalLimits.js'
import type { TracingOperationsLimits, TracingOperationsSnapshot } from './contracts.js'
import {
  type TracingOperationsMetricState,
  gaugeMetricValue,
  readTracingOperationsMetrics,
  sumMetricSamples,
  tracingPoolSnapshot,
} from './metricState.js'
import {
  buildTracingOperationalErrors,
  classifyTracingOperationsHealth,
} from './operationalStatus.js'

export type TracingOperationsSnapshotDependencies = {
  now: () => Date
  instanceStartedAt: string
  readMetrics: () => Promise<TracingOperationsMetricState>
  readLimits: () => TracingOperationsLimits
}

const INSTANCE_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString()

function currentLimits(): TracingOperationsLimits {
  const pools = getTracingPoolOperationalLimits()
  return {
    bodyBytes: TRACING_JSON_BODY_LIMIT_BYTES,
    eventsPerRequest: TRACING_MAX_BATCH_SIZE,
    maxInFlight: getTracingMaxInFlight(),
    ingestPoolMax: pools.ingestPoolMax,
    readPoolMax: pools.readPoolMax,
    poolConnectionTimeoutMs: pools.connectionTimeoutMs,
    ingestStatementTimeoutMs: pools.ingestStatementTimeoutMs,
    readStatementTimeoutMs: pools.readStatementTimeoutMs,
    recentErrorSeconds: getTracingOperationsRecentErrorSeconds(),
  }
}

const DEFAULT_DEPENDENCIES: TracingOperationsSnapshotDependencies = {
  now: () => new Date(),
  instanceStartedAt: INSTANCE_STARTED_AT,
  readMetrics: readTracingOperationsMetrics,
  readLimits: currentLimits,
}

export class TracingOperationsSnapshotService {
  private readonly dependencies: TracingOperationsSnapshotDependencies

  constructor(dependencies: Partial<TracingOperationsSnapshotDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  async read(): Promise<TracingOperationsSnapshot> {
    const now = this.dependencies.now()
    const limits = this.dependencies.readLimits()
    const metrics = await this.dependencies.readMetrics()
    const acceptedEvents = sumMetricSamples(metrics.accepted)
    const replayedEvents = sumMetricSamples(metrics.replayed)
    const rejectedEvents = sumMetricSamples(metrics.rejected)
    const conflictingEvents = sumMetricSamples(metrics.conflicting)
    const inFlight = gaugeMetricValue(metrics.inFlight)
    const pools = [tracingPoolSnapshot('ingest', metrics), tracingPoolSnapshot('read', metrics)]
    const errors = buildTracingOperationalErrors(metrics, limits)

    return {
      generatedAt: now.toISOString(),
      instanceStartedAt: this.dependencies.instanceStartedAt,
      scope: 'control-api-instance',
      health: classifyTracingOperationsHealth(errors, pools, inFlight, limits, now),
      limits,
      ingestion: {
        acceptedEvents,
        replayedEvents,
        rejectedEvents,
        conflictingEvents,
        admissionRequests: sumMetricSamples(metrics.admission),
        admissionRejected: sumMetricSamples(
          metrics.admission,
          labels => labels.result === 'rejected'
        ),
        inFlight,
      },
      pools,
      errors,
    }
  }
}

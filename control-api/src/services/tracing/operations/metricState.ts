import {
  governedTraceAcceptedTotal,
  governedTraceAdmissionRequestsTotal,
  governedTraceConflictingTotal,
  governedTraceInFlightRequests,
  governedTraceLastErrorTimestampSeconds,
  governedTraceOperationalErrorsTotal,
  governedTracePoolConnections,
  governedTracePoolRejectionsTotal,
  governedTracePoolStatementTimeoutsTotal,
  governedTraceRejectedTotal,
  governedTraceReplayedTotal,
} from '../../../observability/metrics.js'
import type { TracingOperationsPoolSnapshot } from './contracts.js'

export type MetricSample = {
  value: number
  labels: Readonly<Partial<Record<string, string | number>>>
}

type ReadableMetric = {
  get(): Promise<{ values: readonly MetricSample[] }>
}

export type TracingOperationsMetricState = {
  accepted: readonly MetricSample[]
  replayed: readonly MetricSample[]
  rejected: readonly MetricSample[]
  conflicting: readonly MetricSample[]
  admission: readonly MetricSample[]
  operationalErrors: readonly MetricSample[]
  inFlight: readonly MetricSample[]
  poolConnections: readonly MetricSample[]
  poolRejections: readonly MetricSample[]
  poolStatementTimeouts: readonly MetricSample[]
  lastErrors: readonly MetricSample[]
}

async function values(metric: ReadableMetric): Promise<readonly MetricSample[]> {
  return (await metric.get()).values
}

export async function readTracingOperationsMetrics(): Promise<TracingOperationsMetricState> {
  const [
    accepted,
    replayed,
    rejected,
    conflicting,
    admission,
    operationalErrors,
    inFlight,
    poolConnections,
    poolRejections,
    poolStatementTimeouts,
    lastErrors,
  ] = await Promise.all([
    values(governedTraceAcceptedTotal),
    values(governedTraceReplayedTotal),
    values(governedTraceRejectedTotal),
    values(governedTraceConflictingTotal),
    values(governedTraceAdmissionRequestsTotal),
    values(governedTraceOperationalErrorsTotal),
    values(governedTraceInFlightRequests),
    values(governedTracePoolConnections),
    values(governedTracePoolRejectionsTotal),
    values(governedTracePoolStatementTimeoutsTotal),
    values(governedTraceLastErrorTimestampSeconds),
  ])
  return {
    accepted,
    replayed,
    rejected,
    conflicting,
    admission,
    operationalErrors,
    inFlight,
    poolConnections,
    poolRejections,
    poolStatementTimeouts,
    lastErrors,
  }
}

export function sumMetricSamples(
  samples: readonly MetricSample[],
  matches: (labels: MetricSample['labels']) => boolean = () => true
): number {
  return samples.reduce((total, sample) => {
    if (!matches(sample.labels) || !Number.isFinite(sample.value)) return total
    return total + sample.value
  }, 0)
}

export function gaugeMetricValue(
  samples: readonly MetricSample[],
  matches: (labels: MetricSample['labels']) => boolean = () => true
): number {
  return Math.max(0, sumMetricSamples(samples, matches))
}

export function tracingPoolSnapshot(
  name: 'ingest' | 'read',
  metrics: TracingOperationsMetricState
): TracingOperationsPoolSnapshot {
  const connection = (state: 'active' | 'idle' | 'waiting') =>
    gaugeMetricValue(
      metrics.poolConnections,
      labels => labels.pool === name && labels.state === state
    )
  return {
    name,
    active: connection('active'),
    idle: connection('idle'),
    waiting: connection('waiting'),
    rejectedSinceRestart: sumMetricSamples(metrics.poolRejections, labels => labels.pool === name),
    statementTimeoutsSinceRestart: sumMetricSamples(
      metrics.poolStatementTimeouts,
      labels => labels.pool === name
    ),
  }
}

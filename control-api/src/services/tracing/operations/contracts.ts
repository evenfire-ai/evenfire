import type { GovernedTraceOperationalErrorReason } from '../../../observability/metrics.js'

export type TracingOperationsHealth = 'healthy' | 'warning' | 'critical'
export type TracingOperationsSeverity = 'critical' | 'warning' | 'info'

export type TracingOperationsLimits = {
  bodyBytes: number
  eventsPerRequest: number
  maxInFlight: number
  ingestPoolMax: number
  readPoolMax: number
  poolConnectionTimeoutMs: number
  ingestStatementTimeoutMs: number
  readStatementTimeoutMs: number
  recentErrorSeconds: number
}

export type TracingOperationsPoolSnapshot = {
  name: 'ingest' | 'read'
  active: number
  idle: number
  waiting: number
  rejectedSinceRestart: number
  statementTimeoutsSinceRestart: number
}

export type TracingOperationsError = {
  reason: GovernedTraceOperationalErrorReason
  message: string
  severity: TracingOperationsSeverity
  countSinceRestart: number
  lastOccurredAt: string | null
  relatedSetting: string | null
  effectiveValue: number | null
  operatorAction: string
}

export type TracingOperationsSnapshot = {
  generatedAt: string
  instanceStartedAt: string
  scope: 'control-api-instance'
  health: TracingOperationsHealth
  limits: TracingOperationsLimits
  ingestion: {
    acceptedEvents: number
    replayedEvents: number
    rejectedEvents: number
    conflictingEvents: number
    admissionRequests: number
    admissionRejected: number
    inFlight: number
  }
  pools: TracingOperationsPoolSnapshot[]
  errors: TracingOperationsError[]
}

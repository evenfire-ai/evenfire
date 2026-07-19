import type { TracingOperationsSnapshot } from '@lib/governedTrace'

export type TracingOperationsViewState = {
  snapshot: TracingOperationsSnapshot | null
  initialLoading: boolean
  refreshing: boolean
  stale: boolean
  unavailable: boolean
  refresh: () => Promise<void>
}

export type HealthSummaryProps = {
  snapshot: TracingOperationsSnapshot
  stale: boolean
}

export type IngestionOutcomeChartProps = {
  ingestion: TracingOperationsSnapshot['ingestion']
}

export type PipelinePressureChartProps = {
  snapshot: TracingOperationsSnapshot
}

export type ErrorSummaryProps = {
  errors: TracingOperationsSnapshot['errors']
}

export type EffectiveLimitsProps = {
  limits: TracingOperationsSnapshot['limits']
}

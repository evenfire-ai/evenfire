import {
  GOVERNED_TRACE_OPERATIONAL_ERROR_REASONS,
  type GovernedTraceOperationalErrorReason,
} from '../../../observability/metrics.js'
import type {
  TracingOperationsError,
  TracingOperationsHealth,
  TracingOperationsLimits,
  TracingOperationsPoolSnapshot,
  TracingOperationsSeverity,
} from './contracts.js'
import { type TracingOperationsMetricState, sumMetricSamples } from './metricState.js'

type ErrorDefinition = {
  message: string
  severity: TracingOperationsSeverity
  setting: (limits: TracingOperationsLimits) => string | null
  value: (limits: TracingOperationsLimits) => number | null
  action: string
}

const ERROR_DEFINITIONS: Record<GovernedTraceOperationalErrorReason, ErrorDefinition> = {
  unsupported_content_type: {
    message: 'Tracing request must use application/json.',
    severity: 'info',
    setting: () => null,
    value: () => null,
    action: 'Correct the producer Content-Type header.',
  },
  invalid_json: {
    message: 'Tracing request contained invalid JSON.',
    severity: 'info',
    setting: () => null,
    value: () => null,
    action: 'Correct producer serialization before retrying.',
  },
  body_too_large: {
    message: 'Tracing request exceeded 512 KiB and was rejected.',
    severity: 'warning',
    setting: () => '512 KiB hard ceiling (not ENV-configurable)',
    value: limits => limits.bodyBytes,
    action: 'Reduce payload fields or split the request; do not raise the hard ceiling.',
  },
  batch_too_large: {
    message: 'Tracing batch exceeded 100 events and was rejected.',
    severity: 'warning',
    setting: () => '100-event hard ceiling (not ENV-configurable)',
    value: limits => limits.eventsPerRequest,
    action: 'Split the producer batch into requests of at most 100 events.',
  },
  capacity_exhausted: {
    message: 'All tracing request slots were occupied.',
    severity: 'warning',
    setting: () => 'TRACING_MAX_IN_FLIGHT',
    value: limits => limits.maxInFlight,
    action: 'Inspect control-api and database pressure before changing concurrency.',
  },
  event_rejected: {
    message: 'One or more submitted trace events failed validation.',
    severity: 'warning',
    setting: () => null,
    value: () => null,
    action: 'Inspect the producer contract and correct the rejected event fields.',
  },
  idempotency_conflict: {
    message: 'An idempotency key was reused with different event content.',
    severity: 'warning',
    setting: () => null,
    value: () => null,
    action: 'Correct the producer key or content; this is not a capacity limit.',
  },
  submission_failed: {
    message: 'A tracing submission failed after request admission.',
    severity: 'critical',
    setting: () => null,
    value: () => null,
    action: 'Inspect control-api structured logs and tracing dependencies before retrying.',
  },
  pool_rejected: {
    message: 'A tracing database connection could not be acquired in time.',
    severity: 'critical',
    setting: () =>
      'TRACING_INGEST_POOL_MAX / TRACING_READ_POOL_MAX / TRACING_POOL_CONNECTION_TIMEOUT_MS',
    value: () => null,
    action: 'Inspect Postgres latency and current pool pressure before changing pool budgets.',
  },
  statement_timeout: {
    message: 'A tracing database statement exceeded its execution budget.',
    severity: 'critical',
    setting: () => 'TRACING_READ_STATEMENT_TIMEOUT_MS / code-owned ingest timeout',
    value: () => null,
    action: 'Inspect the slow query and database health before increasing its timeout.',
  },
  attribution_binding_unavailable: {
    message: 'Direct run attribution could not be recorded within the binding boundary.',
    severity: 'warning',
    setting: () => null,
    value: () => null,
    action:
      'Inspect control-api binding availability; affected events retain unavailable attribution.',
  },
  attribution_binding_conflict: {
    message: 'A direct run id was reused with different immutable attribution facts.',
    severity: 'warning',
    setting: () => null,
    value: () => null,
    action: 'Inspect producer retry and run correlation behavior; do not overwrite the binding.',
  },
  prompt_history_disabled: {
    message: 'Approval prompt capture was skipped because the feature is disabled.',
    severity: 'info',
    setting: () => 'TRACING_APPROVAL_PROMPT_HISTORY_ENABLED',
    value: () => null,
    action:
      'No action is required unless protected prompt history is expected for this environment.',
  },
  prompt_history_key_unavailable: {
    message:
      'Approval prompt capture was enabled but its encryption configuration was unavailable.',
    severity: 'warning',
    setting: () => 'TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY',
    value: () => null,
    action: 'Restore the Secret-backed encryption key and verify the configured key version.',
  },
  prompt_history_rejected: {
    message: 'Approval prompt capture was rejected by a bounded association or size rule.',
    severity: 'warning',
    setting: () => 'TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES',
    value: () => null,
    action: 'Inspect capture association and bounded-size outcomes without logging prompt content.',
  },
}

function lastOccurredAt(
  metrics: TracingOperationsMetricState,
  reason: GovernedTraceOperationalErrorReason
): string | null {
  const timestamp = Math.max(
    0,
    ...metrics.lastErrors
      .filter(sample => sample.labels.reason === reason && Number.isFinite(sample.value))
      .map(sample => sample.value)
  )
  return timestamp > 0 ? new Date(timestamp * 1_000).toISOString() : null
}

export function buildTracingOperationalErrors(
  metrics: TracingOperationsMetricState,
  limits: TracingOperationsLimits
): TracingOperationsError[] {
  const severityOrder: Record<TracingOperationsSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  }
  return GOVERNED_TRACE_OPERATIONAL_ERROR_REASONS.flatMap(reason => {
    const countSinceRestart = sumMetricSamples(
      metrics.operationalErrors,
      labels => labels.reason === reason
    )
    if (countSinceRestart <= 0) return []
    const definition = ERROR_DEFINITIONS[reason]
    return [
      {
        reason,
        message: definition.message,
        severity: definition.severity,
        countSinceRestart,
        lastOccurredAt: lastOccurredAt(metrics, reason),
        relatedSetting: definition.setting(limits),
        effectiveValue: definition.value(limits),
        operatorAction: definition.action,
      },
    ]
  })
    .sort(
      (left, right) =>
        severityOrder[left.severity] - severityOrder[right.severity] ||
        right.countSinceRestart - left.countSinceRestart ||
        left.reason.localeCompare(right.reason)
    )
    .slice(0, 10)
}

function isRecent(error: TracingOperationsError, now: Date, recentErrorSeconds: number): boolean {
  if (!error.lastOccurredAt) return false
  const ageSeconds = (now.getTime() - Date.parse(error.lastOccurredAt)) / 1_000
  return Number.isFinite(ageSeconds) && ageSeconds <= recentErrorSeconds
}

export function classifyTracingOperationsHealth(
  errors: readonly TracingOperationsError[],
  pools: readonly TracingOperationsPoolSnapshot[],
  inFlight: number,
  limits: TracingOperationsLimits,
  now: Date
): TracingOperationsHealth {
  const recent = new Set(
    errors
      .filter(error => isRecent(error, now, limits.recentErrorSeconds))
      .map(error => error.reason)
  )
  if (
    inFlight >= limits.maxInFlight ||
    recent.has('submission_failed') ||
    recent.has('pool_rejected') ||
    recent.has('statement_timeout')
  )
    return 'critical'

  const warningReasons: GovernedTraceOperationalErrorReason[] = [
    'capacity_exhausted',
    'body_too_large',
    'batch_too_large',
    'event_rejected',
    'idempotency_conflict',
    'attribution_binding_unavailable',
    'attribution_binding_conflict',
    'prompt_history_key_unavailable',
    'prompt_history_rejected',
  ]
  if (pools.some(pool => pool.waiting > 0) || warningReasons.some(reason => recent.has(reason))) {
    return 'warning'
  }
  return 'healthy'
}

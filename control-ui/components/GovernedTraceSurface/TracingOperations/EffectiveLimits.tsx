import type { EffectiveLimitsProps } from './types'

export function EffectiveLimits({ limits }: EffectiveLimitsProps) {
  const items = [
    {
      label: 'Request body',
      value: `${limits.bodyBytes / 1024} KiB`,
      source: 'Hard ceiling',
    },
    {
      label: 'Events per request',
      value: limits.eventsPerRequest.toLocaleString(),
      source: 'Hard ceiling',
    },
    {
      label: 'Concurrent requests',
      value: limits.maxInFlight.toLocaleString(),
      source: 'TRACING_MAX_IN_FLIGHT',
    },
    {
      label: 'Ingest pool',
      value: limits.ingestPoolMax.toLocaleString(),
      source: 'TRACING_INGEST_POOL_MAX',
    },
    {
      label: 'Read pool',
      value: limits.readPoolMax.toLocaleString(),
      source: 'TRACING_READ_POOL_MAX',
    },
    {
      label: 'Pool acquisition',
      value: `${limits.poolConnectionTimeoutMs.toLocaleString()} ms`,
      source: 'TRACING_POOL_CONNECTION_TIMEOUT_MS',
    },
    {
      label: 'Ingest statement',
      value: `${limits.ingestStatementTimeoutMs.toLocaleString()} ms`,
      source: 'Code-owned budget',
    },
    {
      label: 'Read statement',
      value: `${limits.readStatementTimeoutMs.toLocaleString()} ms`,
      source: 'TRACING_READ_STATEMENT_TIMEOUT_MS',
    },
    {
      label: 'Recent-error window',
      value: `${limits.recentErrorSeconds.toLocaleString()} s`,
      source: 'TRACING_OPERATIONS_RECENT_ERROR_SECONDS',
    },
  ]
  return (
    <section className="cu-trace-ops-limits" aria-label="Effective tracing limits">
      <div className="cu-trace-ops-section-head">
        <strong>Effective limits</strong>
        <span>Read-only values applied by this control-api instance</span>
      </div>
      <dl>
        {items.map(item => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
            <span>{item.source}</span>
          </div>
        ))}
      </dl>
    </section>
  )
}

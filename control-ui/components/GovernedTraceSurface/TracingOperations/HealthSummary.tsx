import { IconAlertTriangle, IconCheck } from '@components/icons'
import { formatTraceTimestamp } from '../formatters'
import type { HealthSummaryProps } from './types'

const HEALTH_COPY = {
  healthy: 'No current or recent tracing pressure requires operator action.',
  warning: 'Recent tracing rejection or current pressure needs review.',
  critical:
    'Recent critical tracing failures or current capacity pressure require immediate review.',
} as const

export function HealthSummary({ snapshot, stale }: HealthSummaryProps) {
  const poolWaiting = snapshot.pools.reduce((total, pool) => total + pool.waiting, 0)
  const state = stale ? 'stale' : snapshot.health
  const title = stale ? 'Tracing health stale' : `Tracing health ${snapshot.health}`
  const message = stale
    ? `Latest refresh failed. Last known state was ${snapshot.health}; showing the snapshot generated ${formatTraceTimestamp(snapshot.generatedAt)}.`
    : HEALTH_COPY[snapshot.health]
  return (
    <>
      <div
        aria-live="polite"
        className="cu-trace-ops-health"
        data-state={state}
        role={state === 'critical' || state === 'stale' ? 'alert' : 'status'}
      >
        {state === 'healthy' ? (
          <IconCheck aria-hidden="true" height={18} width={18} />
        ) : state === 'warning' || state === 'stale' ? (
          <IconAlertTriangle aria-hidden="true" height={18} width={18} />
        ) : (
          <IconAlertTriangle aria-hidden="true" height={18} width={18} />
        )}
        <div>
          <strong>{title}</strong>
          <span>{message}</span>
        </div>
      </div>
      <div className="cu-trace-ops-scope">
        <span>Since control-api restart</span>
        <span>Instance started {formatTraceTimestamp(snapshot.instanceStartedAt)}</span>
        <span>Snapshot generated {formatTraceTimestamp(snapshot.generatedAt)}</span>
      </div>
      <dl aria-label="Tracing operations summary" className="cu-trace-summary" role="group">
        <div>
          <dt>Accepted events</dt>
          <dd>{snapshot.ingestion.acceptedEvents.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Rejected requests</dt>
          <dd>
            {snapshot.ingestion.admissionRejected.toLocaleString()} /{' '}
            {snapshot.ingestion.admissionRequests.toLocaleString()} total
          </dd>
        </div>
        <div>
          <dt>Request slots</dt>
          <dd>
            {snapshot.ingestion.inFlight.toLocaleString()} /{' '}
            {snapshot.limits.maxInFlight.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Pool waiters</dt>
          <dd>{poolWaiting.toLocaleString()}</dd>
        </div>
      </dl>
    </>
  )
}

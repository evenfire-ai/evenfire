'use client'

import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconAlertTriangle, IconRefresh } from '@components/icons'
import { EffectiveLimits } from './EffectiveLimits'
import { ErrorSummary } from './ErrorSummary'
import { HealthSummary } from './HealthSummary'
import { IngestionOutcomeChart } from './IngestionOutcomeChart'
import { PipelinePressureChart } from './PipelinePressureChart'
import { useTracingOperationsSnapshot } from './useTracingOperationsSnapshot'

export function TracingOperations() {
  const { initialLoading, refresh, refreshing, snapshot, stale, unavailable } =
    useTracingOperationsSnapshot()
  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title="Tracing dashboard"
          subtitle="Current control-api ingestion health and effective limits."
          refreshAction={
            <button
              aria-label={refreshing ? 'Refreshing tracing health' : 'Refresh tracing health'}
              className="cu-trace-refresh"
              disabled={refreshing}
              onClick={() => void refresh()}
              title="Refresh"
              type="button"
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} height={18} width={18} />
            </button>
          }
        />
        {initialLoading && !snapshot ? (
          <div className="cu-empty">Loading tracing health…</div>
        ) : unavailable && !snapshot ? (
          <div className="cu-trace-ops-unavailable" role="alert">
            <IconAlertTriangle aria-hidden="true" height={20} width={20} />
            <div>
              <strong>Tracing health unavailable</strong>
              <span>
                Control API did not return a valid operations snapshot. No zero or healthy state is
                inferred.
              </span>
            </div>
          </div>
        ) : snapshot ? (
          <div className="cu-trace-ops-body">
            <HealthSummary snapshot={snapshot} stale={stale} />
            <div className="cu-trace-ops-charts">
              <IngestionOutcomeChart ingestion={snapshot.ingestion} />
              <PipelinePressureChart snapshot={snapshot} />
            </div>
            <EffectiveLimits limits={snapshot.limits} />
            <ErrorSummary errors={snapshot.errors} />
          </div>
        ) : null}
      </div>
    </section>
  )
}

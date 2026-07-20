import type { PipelinePressureChartProps } from './types'

export function PipelinePressureChart({ snapshot }: PipelinePressureChartProps) {
  const ingest = snapshot.pools.find(pool => pool.name === 'ingest')
  const read = snapshot.pools.find(pool => pool.name === 'read')
  const data = [
    {
      key: 'requests',
      label: 'Requests',
      used: snapshot.ingestion.inFlight,
      limit: snapshot.limits.maxInFlight,
      waiting: 0,
    },
    {
      key: 'ingest',
      label: 'Ingest pool',
      used: ingest?.active ?? 0,
      limit: snapshot.limits.ingestPoolMax,
      waiting: ingest?.waiting ?? 0,
    },
    {
      key: 'read',
      label: 'Read pool',
      used: read?.active ?? 0,
      limit: snapshot.limits.readPoolMax,
      waiting: read?.waiting ?? 0,
    },
  ].map(point => ({
    ...point,
    percentage: point.limit > 0 ? Math.min(100, (point.used / point.limit) * 100) : 0,
  }))
  const summary = data
    .map(point => `${point.label} ${point.used} of ${point.limit}, ${point.waiting} waiting`)
    .join('; ')
  return (
    <section className="cu-trace-ops-chart" aria-label="Current tracing pipeline pressure">
      <div className="cu-trace-ops-section-head">
        <strong>Pipeline pressure</strong>
        <span>Current usage against effective limits</span>
      </div>
      <div
        aria-label={`Current tracing pipeline pressure: ${summary}`}
        className="cu-trace-ops-pressure"
        role="img"
      >
        {data.map(point => (
          <div className="cu-trace-ops-pressure__row" data-pipeline={point.key} key={point.key}>
            <div className="cu-trace-ops-pressure__label">
              <span>{point.label}</span>
              <strong>
                {point.used.toLocaleString()} / {point.limit.toLocaleString()}
              </strong>
            </div>
            <div aria-hidden="true" className="cu-trace-ops-pressure__track">
              <span
                className="cu-trace-ops-pressure__fill"
                style={{ width: `${point.percentage}%` }}
              />
            </div>
            <span className="cu-trace-ops-pressure__waiters">
              {point.waiting.toLocaleString()} waiting
            </span>
          </div>
        ))}
        <div aria-hidden="true" className="cu-trace-ops-pressure__scale">
          <span>0%</span>
          <span>100% ceiling</span>
        </div>
      </div>
    </section>
  )
}

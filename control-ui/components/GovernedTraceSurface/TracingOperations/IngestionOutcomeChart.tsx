import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { IngestionOutcomeChartProps } from './types'

export function IngestionOutcomeChart({ ingestion }: IngestionOutcomeChartProps) {
  const data = [
    { label: 'Accepted events', value: ingestion.acceptedEvents, color: 'var(--cu-success)' },
    { label: 'Replayed events', value: ingestion.replayedEvents, color: 'var(--cu-link)' },
    { label: 'Rejected events', value: ingestion.rejectedEvents, color: 'var(--cu-danger)' },
    {
      label: 'Conflicting events',
      value: ingestion.conflictingEvents,
      color: 'var(--cu-warning)',
    },
  ]
  const summary = data.map(point => `${point.label} ${point.value}`).join(', ')
  return (
    <section className="cu-trace-ops-chart" aria-label="Current event processing outcomes">
      <div className="cu-trace-ops-section-head">
        <strong>Event processing outcomes</strong>
        <span>Since control-api restart</span>
      </div>
      <div
        aria-label={`Current event processing outcomes: ${summary}`}
        className="cu-trace-ops-chart__canvas"
        role="img"
      >
        <ResponsiveContainer height="100%" width="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ bottom: 4, left: 4, right: 16, top: 4 }}
          >
            <CartesianGrid horizontal={false} stroke="var(--cu-border-subtle)" />
            <XAxis
              allowDecimals={false}
              fontSize={11}
              stroke="var(--cu-text-muted)"
              type="number"
            />
            <YAxis
              dataKey="label"
              fontSize={11}
              stroke="var(--cu-text-muted)"
              type="category"
              width={112}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--cu-bg-elevated)',
                border: '1px solid var(--cu-border-subtle)',
                fontSize: 12,
              }}
            />
            <Bar dataKey="value" radius={[0, 3, 3, 0]}>
              {data.map(point => (
                <Cell fill={point.color} key={point.label} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <dl className="cu-trace-ops-chart-values">
        {data.map(point => (
          <div key={point.label}>
            <dt>{point.label}</dt>
            <dd>{point.value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

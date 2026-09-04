import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DataTable, TableViewport } from '@clerum/frontend-components'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import type { GovernedTraceEvent } from '@lib/governedTrace'
import { displayTraceValue, formatTraceTimestamp } from '../formatters'
import type { InfrastructureOperationalSnapshotProps } from './types'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'workload', label: 'Workload', minWidth: '12rem' },
  { key: 'status', label: 'Status', minWidth: '6rem' },
  { key: 'capacity', label: 'Capacity', minWidth: '13rem' },
  { key: 'signal', label: 'Primary signal', minWidth: '17rem' },
  { key: 'event', label: 'Latest event', minWidth: '10rem' },
]

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function intervalSeconds(payload: Record<string, unknown>): number | null {
  const start = payloadString(payload, 'interval_start')
  const end = payloadString(payload, 'interval_end')
  if (!start || !end) return null
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

function formatRatio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'Not sampled' : `${(value * 100).toFixed(0)}%`
}

function formatCpuEvidence(payload: Record<string, unknown>): {
  label: string
  ratio: number | null
} {
  const seconds = intervalSeconds(payload)
  const usage = payloadNumber(payload, 'cpu_usage_core_seconds')
  const request = payloadNumber(payload, 'cpu_request_cores')
  if (usage === null) return { label: 'Usage not sampled', ratio: null }
  if (!seconds) return { label: 'Sampling interval not recorded', ratio: null }
  if (request === null || request <= 0) return { label: 'CPU request not recorded', ratio: null }
  const average = usage / seconds
  const ratio = average / request
  return {
    label: `${average.toFixed(2)} / ${request.toFixed(2)} cores · ${formatRatio(ratio)}`,
    ratio,
  }
}

function formatMemoryEvidence(payload: Record<string, unknown>): {
  label: string
  ratio: number | null
} {
  const seconds = intervalSeconds(payload)
  const usage = payloadNumber(payload, 'memory_usage_byte_seconds')
  const request = payloadNumber(payload, 'memory_request_bytes')
  if (usage === null) return { label: 'Usage not sampled', ratio: null }
  if (!seconds) return { label: 'Sampling interval not recorded', ratio: null }
  if (request === null || request <= 0) return { label: 'Memory request not recorded', ratio: null }
  const average = usage / seconds
  const ratio = average / request
  const gib = 1024 ** 3
  return {
    label: `${(average / gib).toFixed(2)} / ${(request / gib).toFixed(2)} GiB · ${formatRatio(ratio)}`,
    ratio,
  }
}

export function InfrastructureOperationalSnapshot({
  events,
}: InfrastructureOperationalSnapshotProps) {
  const signals = useMemo(() => {
    const byWorkload = new Map<
      string,
      { event: GovernedTraceEvent; payload: Record<string, unknown> }
    >()
    for (const event of events) {
      const workload = event.targetRef ?? payloadString(event.payload, 'workload_ref')
      if (!workload) continue
      const previous = byWorkload.get(workload)
      if (!previous) {
        byWorkload.set(workload, { event, payload: { ...event.payload } })
        continue
      }
      // Stream reads are latest-first; older pages may backfill fields but cannot replace the latest fact.
      byWorkload.set(workload, {
        event: previous.event,
        payload: { ...event.payload, ...previous.payload },
      })
    }
    return [...byWorkload.entries()]
      .map(([workload, signal]) => {
        const desired = payloadNumber(signal.payload, 'desired_replicas')
        const ready = payloadNumber(signal.payload, 'ready_replicas')
        const cpu = formatCpuEvidence(signal.payload)
        const memory = formatMemoryEvidence(signal.payload)
        const reasons: string[] = []
        if (/failed|denied|rejected|error/i.test(signal.event.outcome ?? '')) {
          reasons.push(`Outcome ${signal.event.outcome}`)
        }
        if (desired !== null && ready !== null && ready < desired) {
          const gap = desired - ready
          reasons.push(`${gap} replica${gap === 1 ? '' : 's'} not ready`)
        }
        if (cpu.ratio !== null && cpu.ratio > 1) {
          reasons.push(`CPU at ${formatRatio(cpu.ratio)} of request`)
        }
        if (memory.ratio !== null && memory.ratio > 1) {
          reasons.push(`Memory at ${formatRatio(memory.ratio)} of request`)
        }
        return {
          workload,
          ...signal,
          desired,
          ready,
          cpu,
          memory,
          needsReview: reasons.length > 0,
          primarySignal:
            reasons.join(' · ') ||
            (cpu.ratio === null && memory.ratio === null
              ? 'Replica capacity is healthy; measured usage was not sampled'
              : 'No threshold breach in loaded evidence'),
        }
      })
      .sort(
        (left, right) =>
          Number(right.needsReview) - Number(left.needsReview) ||
          left.workload.localeCompare(right.workload)
      )
  }, [events])

  const pressureData = useMemo(
    () =>
      signals
        .filter(signal => signal.cpu.ratio !== null || signal.memory.ratio !== null)
        .map(signal => ({
          cpu: signal.cpu.ratio === null ? null : signal.cpu.ratio * 100,
          fullWorkload: signal.workload,
          memory: signal.memory.ratio === null ? null : signal.memory.ratio * 100,
          workload:
            signal.workload.length > 24 ? `${signal.workload.slice(0, 21)}…` : signal.workload,
        }))
        .sort(
          (left, right) =>
            Math.max(right.cpu ?? 0, right.memory ?? 0) - Math.max(left.cpu ?? 0, left.memory ?? 0)
        )
        .slice(0, 6),
    [signals]
  )

  const pressureSummary = pressureData
    .map(
      point =>
        `${point.fullWorkload}: CPU ${formatRatio(point.cpu === null ? null : point.cpu / 100)}, memory ${formatRatio(point.memory === null ? null : point.memory / 100)}`
    )
    .join('; ')

  return (
    <section aria-label="Infrastructure operational snapshot" className="cu-trace-operations">
      <div className="cu-trace-operations__head">
        <span className="cu-trace-cost-section-title">Operational workload snapshot</span>
        <span className="cu-trace-operations__scope">Latest loaded evidence per workload</span>
      </div>
      <div className="cu-table__cell-muted">
        Deployment capacity samples include requested resources and replica health. CPU and memory
        utilization appears only when measured usage telemetry is present.
      </div>
      {pressureData.length ? (
        <div
          aria-label={`Capacity pressure. ${pressureSummary}`}
          className="cu-trace-pressure"
          role="img"
        >
          <div className="cu-trace-pressure__head">
            <span className="cu-trace-cost-section-title">Capacity pressure</span>
            <span className="cu-trace-operations__scope">
              Highest loaded utilization · 100% equals requested capacity
            </span>
          </div>
          <div
            className="cu-trace-pressure__chart"
            style={{ height: Math.max(180, pressureData.length * 44) }}
          >
            <ResponsiveContainer height="100%" width="100%">
              <BarChart
                data={pressureData}
                layout="vertical"
                margin={{ bottom: 4, left: 4, right: 24, top: 4 }}
              >
                <CartesianGrid horizontal={false} stroke="var(--cu-border-subtle)" />
                <XAxis
                  domain={[0, 'auto']}
                  fontSize={11}
                  stroke="var(--cu-text-muted)"
                  tickFormatter={value => `${value}%`}
                  type="number"
                />
                <YAxis
                  dataKey="workload"
                  fontSize={11}
                  stroke="var(--cu-text-muted)"
                  type="category"
                  width={150}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--cu-bg-elevated)',
                    border: '1px solid var(--cu-border-subtle)',
                    fontSize: 12,
                  }}
                  formatter={(value: number, name: string) => [`${value.toFixed(0)}%`, name]}
                  labelFormatter={(_, payload) => payload[0]?.payload.fullWorkload ?? ''}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine stroke="var(--cu-warning)" strokeDasharray="4 4" x={100} />
                <Bar
                  dataKey="cpu"
                  fill="var(--cu-accent)"
                  name="CPU / request"
                  radius={[0, 3, 3, 0]}
                />
                <Bar
                  dataKey="memory"
                  fill="var(--cu-warning)"
                  name="Memory / request"
                  radius={[0, 3, 3, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
      <TableViewport className="cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band">
          <thead>
            <TableHeaderRow columns={COLUMNS} />
          </thead>
          <tbody>
            {signals.map(
              ({
                cpu,
                desired,
                event,
                memory,
                needsReview,
                payload,
                primarySignal,
                ready,
                workload,
              }) => {
                return (
                  <tr key={workload}>
                    <td data-label="Workload">
                      <div>{workload}</div>
                      <div className="cu-table__cell-muted">
                        {displayTraceValue(payloadString(payload, 'cluster_name'))} ·{' '}
                        {displayTraceValue(payloadString(payload, 'namespace'))} ·{' '}
                        {displayTraceValue(payloadString(payload, 'workload_kind'))}
                      </div>
                    </td>
                    <td data-label="Status">
                      <span
                        className="cu-trace-signal-status"
                        data-state={needsReview ? 'review' : 'nominal'}
                      >
                        {needsReview ? 'Investigate' : 'Nominal'}
                      </span>
                    </td>
                    <td data-label="Capacity">
                      <div>
                        Ready{' '}
                        {ready === null || desired === null
                          ? 'Capacity not recorded'
                          : `${ready} / ${desired}`}
                      </div>
                      <div className="cu-table__cell-muted">CPU {cpu.label}</div>
                      <div className="cu-table__cell-muted">Memory {memory.label}</div>
                    </td>
                    <td data-label="Primary signal">{primarySignal}</td>
                    <td data-label="Latest event">
                      <div>
                        {event.eventType} · {displayTraceValue(event.outcome)}
                      </div>
                      <div className="cu-table__cell-muted">
                        {formatTraceTimestamp(event.occurredAt)}
                      </div>
                    </td>
                  </tr>
                )
              }
            )}
            {!signals.length ? (
              <tr>
                <td className="cu-empty" colSpan={COLUMNS.length}>
                  No workload capacity evidence is present in the loaded telemetry page.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </TableViewport>
    </section>
  )
}

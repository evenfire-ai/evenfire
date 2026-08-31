import { DataTable } from '@clerum/frontend-table-system'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { formatTraceTimestamp } from '../formatters'
import type { ErrorSummaryProps } from './types'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'severity', label: 'Severity', minWidth: '6rem' },
  { key: 'error', label: 'Error', minWidth: '17rem' },
  { key: 'count', label: 'Count', minWidth: '5rem' },
  { key: 'last', label: 'Last occurrence', minWidth: '10rem' },
  { key: 'setting', label: 'Effective setting', minWidth: '16rem' },
  { key: 'action', label: 'Operator action', minWidth: '18rem' },
]

function effectiveValue(reason: string, value: number | null): string | null {
  if (value === null) return null
  if (reason === 'body_too_large') return `${value / 1024} KiB`
  if (reason === 'batch_too_large') return `${value.toLocaleString()} events`
  if (reason === 'capacity_exhausted') return `${value.toLocaleString()} requests`
  return value.toLocaleString()
}

export function ErrorSummary({ errors }: ErrorSummaryProps) {
  return (
    <section className="cu-trace-ops-errors" aria-label="Tracing operational errors">
      <div className="cu-trace-ops-section-head">
        <strong>Operational errors</strong>
        <span>Recorded occurrences since control-api restart</span>
      </div>
      <div className="eft-table-viewport cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band cu-trace-ops-table">
          <thead>
            <TableHeaderRow columns={COLUMNS} />
          </thead>
          <tbody>
            {errors.map(error => {
              const value = effectiveValue(error.reason, error.effectiveValue)
              return (
                <tr key={error.reason}>
                  <td data-label="Severity">
                    <span className="cu-trace-ops-severity" data-severity={error.severity}>
                      {error.severity}
                    </span>
                  </td>
                  <td data-label="Error">
                    <div>{error.message}</div>
                    <div className="cu-table__cell-muted">{error.reason}</div>
                  </td>
                  <td data-label="Count">{error.countSinceRestart.toLocaleString()}</td>
                  <td data-label="Last occurrence">
                    {error.lastOccurredAt
                      ? formatTraceTimestamp(error.lastOccurredAt)
                      : 'Not recorded'}
                  </td>
                  <td data-label="Effective setting">
                    <div>{error.relatedSetting ?? 'No tunable setting'}</div>
                    {value ? (
                      <div className="cu-table__cell-muted">Effective value: {value}</div>
                    ) : null}
                  </td>
                  <td data-label="Operator action">{error.operatorAction}</td>
                </tr>
              )
            })}
            {!errors.length ? (
              <tr>
                <td className="cu-empty" colSpan={COLUMNS.length}>
                  No tracing operational errors recorded since this control-api instance started.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </div>
    </section>
  )
}

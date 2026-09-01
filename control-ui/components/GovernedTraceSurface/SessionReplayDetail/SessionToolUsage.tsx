import { DataTable } from '@clerum/frontend-components'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { GovernedTraceToolUsage } from '@lib/governedTrace'
import { formatTraceTimestamp } from '../formatters'
import { SESSION_TOOL_COLUMNS } from './constants'

export function SessionToolUsage({ tools }: { tools: readonly GovernedTraceToolUsage[] }) {
  return (
    <section className="cu-trace-detail-section" aria-labelledby="trace-session-tools">
      <div className="cu-trace-detail-section__head">
        <div>
          <h2 id="trace-session-tools">Tool usage</h2>
          <p>Approval decisions and observed executions remain separate.</p>
        </div>
        <span>{tools.length} loaded</span>
      </div>
      <div className="eft-table-viewport cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band cu-trace-detail-table">
          <thead>
            <TableHeaderRow columns={SESSION_TOOL_COLUMNS} />
          </thead>
          <tbody>
            {tools.map(tool => (
              <tr key={JSON.stringify([tool.toolName, tool.toolKind, tool.toolSourceRef])}>
                <td data-label="Tool">
                  <strong>{tool.toolName}</strong>
                </td>
                <td data-label="Type">
                  {tool.toolKind === 'unclassified'
                    ? 'Unclassified legacy event'
                    : tool.toolKind.replaceAll('_', ' ')}
                </td>
                <td data-label="Source">
                  {tool.toolSourceRef ?? 'Not captured by legacy producer'}
                </td>
                <td data-label="Calls">{tool.totalCalls}</td>
                <td data-label="Succeeded">{tool.succeeded}</td>
                <td data-label="Failed">{tool.failed}</td>
                <td data-label="First observed">{formatTraceTimestamp(tool.firstOccurredAt)}</td>
                <td data-label="Last observed">{formatTraceTimestamp(tool.lastOccurredAt)}</td>
              </tr>
            ))}
            {!tools.length ? (
              <tr>
                <td className="cu-empty" colSpan={SESSION_TOOL_COLUMNS.length}>
                  No governed tool calls are available for this session.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </div>
    </section>
  )
}

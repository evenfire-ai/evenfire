import React, { useMemo, useState } from 'react'
import { Button, DataTable, IconButton } from '@components/Common'
import { formatMcpServerDisplayName } from '@lib/format'
import {
  type McpServerUiLabel,
  type MergedMcpServerRow,
  mergeAgentHealth,
} from '../../../src/mcpServerHealth'
import type { AgentWithMcpServers, HostRuntimeStatus } from '../../../src/types'
import type { ConnectorActionInput } from '../hooks/domain/useConnectorsController'
import type {
  McpServerConnectorAction,
  McpServerHealthTableProps,
} from './McpServerHealthTable.types'

const LABEL_TEXT: Record<McpServerUiLabel, string> = {
  running: 'Running',
  degraded: 'Degraded',
  failed: 'Failed',
  starting: 'Starting',
  disabled: 'Disabled',
  unknown: 'Unknown',
  stale: 'Stale',
}

const REASON_HINT: Record<string, string> = {
  auth_failed: 'Check the API key used when this server was installed.',
  upstream_4xx: 'Upstream rejected the request.',
  upstream_5xx: 'Upstream server error.',
  network: 'Could not reach the upstream host.',
  handshake: 'MCP protocol error after connect.',
  timeout: 'Upstream did not respond in time.',
  not_ready: 'Deployment not ready yet; retrying.',
  unknown: '',
}

/** Labels that indicate the row needs operator attention. */
const ATTENTION_LABELS: ReadonlySet<McpServerUiLabel> = new Set(['failed', 'degraded', 'stale'])

export function McpServerHealthTable({
  hostRef,
  mcpServerNames,
  status,
  now,
  onRefresh,
  refreshing,
  defaultExpanded = false,
  alwaysExpanded = false,
  connectorActions,
  onAuthorize,
  onDisconnect,
}: McpServerHealthTableProps) {
  const showActions = connectorActions !== undefined
  const [expanded, setExpanded] = useState(defaultExpanded)
  const isExpanded = alwaysExpanded || expanded

  const table = useMemo(() => {
    const agent: AgentWithMcpServers = {
      name: hostRef,
      contextRef: null,
      mcpServers: mcpServerNames.map(name => ({ name })),
    }
    return mergeAgentHealth(agent, status, now ?? Date.now())
  }, [hostRef, mcpServerNames, status, now])

  const summary = useMemo(() => {
    const total = table.rows.length
    let attention = 0
    for (const row of table.rows) {
      if (ATTENTION_LABELS.has(row.label)) attention += 1
    }
    return { total, attention }
  }, [table.rows])

  const refreshButton = onRefresh ? (
    <IconButton
      className={`mcp-health-refresh${refreshing ? ' is-refreshing' : ''}`}
      onClick={e => {
        // Stop toggle from firing when the user clicks the refresh icon.
        e.stopPropagation()
        void onRefresh()
      }}
      disabled={refreshing}
      label="Refresh connector status"
      size="sm"
      title="Refresh connector status"
      data-testid="mcp-health-refresh"
      variant="ghost"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 3V1L5 4l3 3V5c2.21 0 4 1.79 4 4 0 .68-.17 1.32-.47 1.88l1.09 1.09C13.5 11.14 14 10.13 14 9c0-3.31-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4 0-.68.17-1.32.47-1.88L3.38 6.03C2.5 6.86 2 7.87 2 9c0 3.31 2.69 6 6 6v2l3-3-3-3v2z"
          fill="currentColor"
        />
      </svg>
    </IconButton>
  ) : null

  // The caret icon (▸ collapsed / ▾ expanded). SVG rotates via CSS.
  const caret = (
    <svg
      className={`mcp-health-caret${isExpanded ? ' is-expanded' : ''}`}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 2l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  // `<button type="button">` already handles Enter/Space natively — no
  // explicit keyDown handler needed.
  const toggle = () => {
    if (alwaysExpanded) return
    setExpanded(v => !v)
  }

  if (table.rows.length === 0) {
    if (alwaysExpanded) {
      return (
        <div
          className="mcp-health-empty mcp-health-empty--table-only"
          data-testid="mcp-health-empty"
        >
          <p className="muted">No connectors configured for this agent.</p>
        </div>
      )
    }

    return (
      <div className="mcp-health-empty" data-testid="mcp-health-empty">
        <div className="mcp-health-heading">
          <h4>Connectors</h4>
          {refreshButton}
        </div>
        <p className="muted">No connectors configured for this agent.</p>
      </div>
    )
  }

  return (
    <div
      className={`mcp-health-section${alwaysExpanded ? ' mcp-health-section--table-only' : ''}${
        isExpanded ? ' is-expanded' : ' is-collapsed'
      }`}
      data-testid="mcp-health-table"
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      {!alwaysExpanded ? (
        <div className="mcp-health-heading">
          <Button
            className="mcp-health-heading--toggle"
            onClick={toggle}
            aria-expanded={isExpanded}
            aria-controls="mcp-health-rows"
            data-testid="mcp-health-toggle"
            variant="ghost"
          >
            {caret}
            <h4>Connectors</h4>
            <span className="mcp-health-summary" data-testid="mcp-health-summary">
              <span className="mcp-health-summary-count">
                {summary.total} server{summary.total === 1 ? '' : 's'}
              </span>
              {summary.attention > 0 ? (
                <span
                  className="mcp-health-summary-attention"
                  data-testid="mcp-health-summary-attention"
                >
                  {summary.attention} need{summary.attention === 1 ? 's' : ''} attention
                </span>
              ) : null}
            </span>
            {table.unknownFallback ? (
              <span className="mcp-health-fallback muted" data-testid="mcp-health-unknown-fallback">
                Awaiting live status
              </span>
            ) : null}
          </Button>
          {refreshButton}
        </div>
      ) : null}
      {isExpanded ? (
        <div id="mcp-health-rows" className="mcp-health-rows">
          <DataTable frameless className="agent-mcp-health-data-table">
            <thead>
              <tr>
                <th className="da-table__col-header" scope="col">
                  MCP Server Name
                </th>
                <th
                  className={`da-table__col-header${showActions ? '' : ' da-table__col-header--right'}`}
                  scope="col"
                >
                  Status
                </th>
                {showActions ? (
                  <th className="da-table__col-header da-table__col-header--right" scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map(row => (
                <McpServerHealthRow
                  key={row.name}
                  row={row}
                  showActions={showActions}
                  action={connectorActions?.get(row.name)}
                  onAuthorize={onAuthorize}
                  onDisconnect={onDisconnect}
                />
              ))}
            </tbody>
          </DataTable>
        </div>
      ) : null}
    </div>
  )
}

function McpServerHealthRow({
  row,
  showActions,
  action,
  onAuthorize,
  onDisconnect,
}: {
  row: MergedMcpServerRow
  showActions: boolean
  action: McpServerConnectorAction | undefined
  onAuthorize?: (input: ConnectorActionInput) => void
  onDisconnect?: (input: ConnectorActionInput) => void
}) {
  const label = row.label
  const hint = row.reason ? (REASON_HINT[row.reason] ?? '') : row.message || ''
  const needsAttention = ATTENTION_LABELS.has(label)

  return (
    <tr
      className={`mcp-health-table-row mcp-health-row--${label}`}
      data-testid={`mcp-health-row-${row.name}`}
      data-label={label}
      data-reason={row.reason ?? ''}
    >
      <td className="da-table__cell">
        <span className="mcp-health-name-cell">
          <span className="mcp-health-name" title={hint || undefined}>
            {formatMcpServerDisplayName(row.name)}
          </span>
          {needsAttention ? (
            <span className="mcp-health-row-attention">Needs attention</span>
          ) : null}
        </span>
      </td>
      <td className={`da-table__cell${showActions ? '' : ' da-table__cell--right'}`}>
        <span className="mcp-health-status">
          <span
            className={`mcp-health-chip mcp-health-chip--${label}`}
            aria-label={LABEL_TEXT[label]}
          >
            {LABEL_TEXT[label]}
          </span>
        </span>
      </td>
      {showActions ? (
        <td className="da-table__cell da-table__cell--right">
          {action ? (
            action.authorized ? (
              <Button
                color="danger"
                disabled={action.busy}
                loading={action.busy}
                onClick={event => {
                  event.stopPropagation()
                  onDisconnect?.(action.actionInput)
                }}
                onKeyDown={event => event.stopPropagation()}
                size="sm"
                variant="ghost"
              >
                Disconnect
              </Button>
            ) : (
              <Button
                color="primary"
                disabled={action.busy}
                loading={action.busy}
                onClick={event => {
                  event.stopPropagation()
                  onAuthorize?.(action.actionInput)
                }}
                onKeyDown={event => event.stopPropagation()}
                size="sm"
                variant="soft"
              >
                Authorize
              </Button>
            )
          ) : null}
        </td>
      ) : null}
    </tr>
  )
}

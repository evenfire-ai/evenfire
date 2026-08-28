import { useMemo } from 'react'
import { Button, DataTable, EmptyState, Pill, ReferenceTag, StatusBanner } from '@components/Common'
import { scopeCaption, statusPresentation } from '@lib/connectorPresentation'
import { type ConnectorRow, deriveConnectorRows } from '@lib/connectorRows'
import { formatMcpServerDisplayName } from '@lib/format'
import { useNavigationContext } from '../contexts/NavigationContext'
import {
  type ConnectorActionInput,
  isActionableConnector,
  useConnectorsController,
} from '../hooks/domain/useConnectorsController'
import { clickableRowProps } from '../lib/clickableRowProps'

function ConnectorRowView({
  row,
  busy,
  onAuthorize,
  onDisconnect,
  onOpenAgent,
}: {
  row: ConnectorRow
  busy: boolean
  onAuthorize: (input: ConnectorActionInput) => void
  onDisconnect: (input: ConnectorActionInput) => void
  onOpenAgent: (agentName: string) => void
}) {
  const { connector, contextRef } = row
  const presentation = statusPresentation(connector.status)
  const caption = scopeCaption(connector)
  // The action IPC needs a hostRef to mint the token; the row is per
  // (server, context), so we act under the deterministic representative agent.
  const actionInput: ConnectorActionInput = {
    agentName: row.representativeAgent,
    contextRef,
    connector,
  }

  // The whole row deep-links to the representative agent's Connectors tab — but
  // ONLY when the connector has a mapped context (contexts are 1:1 with agents,
  // so this is the "has a real mapping" signal). Contextless rows stay
  // non-interactive (no target).
  const rowProps = contextRef
    ? {
        className: 'da-table__row--clickable',
        ...clickableRowProps(() => onOpenAgent(row.representativeAgent), {
          ariaLabel: `Open connectors for agent ${row.representativeAgent}`,
        }),
      }
    : {}

  return (
    <tr {...rowProps}>
      <td className="da-table__cell">
        <span className="context-id-cell">
          <strong>{formatMcpServerDisplayName(connector.name)}</strong>
          {connector.provider ? <span className="muted"> · {connector.provider}</span> : null}
        </span>
      </td>

      <td className="da-table__cell">
        {contextRef ? (
          <ReferenceTag kind="context" title={`Context: ${contextRef}`}>
            {contextRef}
          </ReferenceTag>
        ) : (
          <span className="agent-table-muted">—</span>
        )}
      </td>

      <td className="da-table__cell">
        {row.usedByAgents.length ? (
          <span className="reference-tag-list">
            {row.usedByAgents.map(agentName => (
              <ReferenceTag
                key={agentName}
                kind="agent"
                onClick={event => {
                  event.stopPropagation()
                  onOpenAgent(agentName)
                }}
                // The row's clickableRowProps installs an Enter/Space onKeyDown
                // on the <tr>; stop keyboard activation from bubbling so a chip
                // press opens the agent instead of navigating the row.
                onKeyDown={event => event.stopPropagation()}
                title={agentName}
                aria-label={`Open agent ${agentName}`}
              >
                {agentName}
              </ReferenceTag>
            ))}
          </span>
        ) : (
          <span className="agent-table-muted">None</span>
        )}
      </td>

      <td className="da-table__cell">
        <Pill tone={presentation.tone} size="sm" title={caption ?? undefined}>
          {presentation.label}
        </Pill>
      </td>

      <td className="da-table__cell da-table__cell--right">
        {!isActionableConnector(connector) ? null : connector.status === 'authorized' ? (
          <Button
            color="danger"
            disabled={busy}
            loading={busy}
            onClick={event => {
              // Keep the click on the button — don't trigger the row navigation.
              event.stopPropagation()
              onDisconnect(actionInput)
            }}
            // Same guard for keyboard: Enter/Space on the button must not bubble
            // to the row's onKeyDown and navigate as well.
            onKeyDown={event => event.stopPropagation()}
            size="sm"
            variant="ghost"
          >
            Disconnect
          </Button>
        ) : (
          <Button
            color="primary"
            disabled={busy}
            loading={busy}
            onClick={event => {
              event.stopPropagation()
              onAuthorize(actionInput)
            }}
            onKeyDown={event => event.stopPropagation()}
            size="sm"
            variant="soft"
          >
            Authorize
          </Button>
        )}
      </td>
    </tr>
  )
}

export function McpServersPage() {
  const { loading, error, agents, pendingKey, authorize, disconnect } = useConnectorsController()
  const { handleOpenAgentWorkspace } = useNavigationContext()

  const rows = useMemo(() => deriveConnectorRows(agents), [agents])
  const hasRows = rows.length > 0

  return (
    <section className="page">
      <div className="page-header">
        <h2>Connectors</h2>
        <p className="muted">
          Review the connectors available across your agents, authorize the ones that require setup,
          and disconnect the ones you no longer want.
        </p>
      </div>

      <div className="page-layout">
        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        <section className="page-card mcp-servers-board-card" aria-label="Connectors">
          {loading && !hasRows ? (
            <EmptyState title="Loading" body="Fetching your connectors…" />
          ) : !hasRows ? (
            <EmptyState
              title="No connectors"
              body="No agents with connectors are available for your account yet."
            />
          ) : (
            <DataTable frameless fullBleed className="mcp-servers-data-table">
              <thead>
                <tr>
                  <th className="da-table__col-header" scope="col">
                    Connector
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Context
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Agents
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Status
                  </th>
                  <th className="da-table__col-header da-table__col-header--right" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <ConnectorRowView
                    key={row.key}
                    row={row}
                    busy={pendingKey === row.key}
                    onAuthorize={input => {
                      authorize(input).catch(() => undefined)
                    }}
                    onDisconnect={input => {
                      disconnect(input).catch(() => undefined)
                    }}
                    onOpenAgent={agentName => handleOpenAgentWorkspace(agentName, 'mcp-servers')}
                  />
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>
    </section>
  )
}

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
  const { connector, contextRef, agentName } = row
  const presentation = statusPresentation(connector.status)
  const caption = scopeCaption(connector)
  // The action IPC needs a hostRef to mint the token; the row is per
  // (connector, agent), so we act under the row's own agent.
  const actionInput: ConnectorActionInput = {
    agentName,
    contextRef,
    connector,
  }

  // Every row deep-links to ITS agent's Connectors tab. In the agent-centric
  // model every row has an agent (contextless `oauth-user` rows included), so
  // every row is clickable.
  const rowProps = {
    className: 'da-table__row--clickable',
    ...clickableRowProps(() => onOpenAgent(agentName), {
      ariaLabel: `Open connectors for agent ${agentName}`,
    }),
  }

  return (
    <tr {...rowProps}>
      <td className="da-table__cell">
        <span className="context-id-cell">
          <strong>{formatMcpServerDisplayName(connector.name)}</strong>
          {connector.provider ? <span className="muted"> · {connector.provider}</span> : null}
        </span>
      </td>

      <td className="da-table__cell">
        {/* Presentational: the whole row already navigates to this agent, so the
            tag carries no click/key handlers of its own. */}
        <ReferenceTag kind="agent" title={agentName} aria-label={`Agent ${agentName}`}>
          {agentName}
        </ReferenceTag>
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
                    Agent
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
                    key={row.renderKey}
                    row={row}
                    // Busy is a property of the GRANT, never the render row:
                    // authorizing/disconnecting a shared grant must show every
                    // sibling row busy, so anchor on grantKey (matches the
                    // controller's pendingKey = connectorRowKey).
                    busy={pendingKey === row.grantKey}
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

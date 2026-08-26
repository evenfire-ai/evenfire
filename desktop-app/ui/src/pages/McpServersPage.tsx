import { Button, EmptyState, Pill, StatusBanner } from '@components/Common'
import { formatMcpServerDisplayName } from '@lib/format'
import type { RpcConnector } from '../../../src/types'
import {
  connectorActionKey,
  isActionableConnector,
  isSharedConnector,
  useConnectorsController,
} from '../hooks/domain/useConnectorsController'

const CONNECTORS_GRID_COLS =
  'minmax(10rem, 1.4fr) minmax(8rem, 0.6fr) minmax(12rem, 1.4fr) minmax(7rem, auto)'

type StatusPresentation = {
  label: string
  tone: 'success' | 'warning' | 'neutral'
}

function statusPresentation(status: RpcConnector['status']): StatusPresentation {
  switch (status) {
    case 'authorized':
      return { label: 'Authorized', tone: 'success' }
    case 'requires_setup':
      return { label: 'Requires setup', tone: 'warning' }
    default:
      return { label: 'No OAuth', tone: 'neutral' }
  }
}

/**
 * The per-connector scope caption (spec §1.3 / D-1). A `oauth-user` grant is
 * global to `(server, userId)`, so acting under one agent flips the SAME server
 * across every agent that lists it; a `oauth-context` grant is shared by the
 * whole Context. Surfaced verbatim so the user understands the blast radius
 * before the derived state changes several rows at once.
 */
function scopeCaption(connector: RpcConnector): string | null {
  if (connector.status === 'no_oauth') return null
  if (isSharedConnector(connector)) {
    return 'Shared by the team — affects everyone in this context.'
  }
  if (connector.authKind === 'oauth-user') {
    return 'Affects all your agents that use this connector.'
  }
  return null
}

export function McpServersPage() {
  const { loading, error, agents, pendingKey, authorize, disconnect } = useConnectorsController()

  const hasAgents = agents.length > 0

  return (
    <section className="page">
      <div className="page-header">
        <h2>Connectors</h2>
        <p className="muted">
          Review the connectors available to each agent, authorize the ones that require setup, and
          disconnect the ones you no longer want to grant.
        </p>
      </div>

      <div className="page-layout">
        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        {loading && !hasAgents ? (
          <section className="page-card">
            <EmptyState title="Loading" body="Fetching your connectors…" />
          </section>
        ) : !hasAgents ? (
          <section className="page-card">
            <EmptyState
              title="No connectors"
              body="No agents with connectors are available for your account yet."
            />
          </section>
        ) : (
          agents.map(agent => {
            const contextRef = agent.contextRef
            return (
              <section
                className="page-card"
                key={agent.name}
                aria-labelledby={`agent-${agent.name}`}
              >
                <div className="page-card__header">
                  <div>
                    <h3 id={`agent-${agent.name}`}>{agent.name}</h3>
                    <p className="muted">
                      {contextRef ? `Context: ${contextRef}` : 'No context assigned'}
                    </p>
                  </div>
                </div>

                {agent.connectors.length === 0 ? (
                  <EmptyState
                    title="No connectors"
                    body="This agent's context lists no connectors."
                  />
                ) : (
                  <div className="da-grid" style={{ '--da-grid-cols': CONNECTORS_GRID_COLS }}>
                    <div className="da-grid__head">
                      <span className="da-grid__col-header">Connector</span>
                      <span className="da-grid__col-header">Status</span>
                      <span className="da-grid__col-header">Scope</span>
                      <span className="da-grid__col-header da-grid__col-header--right">
                        Actions
                      </span>
                    </div>
                    <div className="da-grid__body">
                      {agent.connectors.map(connector => {
                        const presentation = statusPresentation(connector.status)
                        const caption = scopeCaption(connector)
                        const actionKey = connectorActionKey(agent.name, connector.name)
                        const busy = pendingKey === actionKey
                        const actionInput = { agentName: agent.name, contextRef, connector }
                        return (
                          <div className="da-grid__row" key={`${agent.name}:${connector.name}`}>
                            <span className="da-grid__cell">
                              {formatMcpServerDisplayName(connector.name)}
                              {connector.provider ? (
                                <span className="muted"> · {connector.provider}</span>
                              ) : null}
                            </span>
                            <span className="da-grid__cell">
                              <Pill tone={presentation.tone} size="sm">
                                {presentation.label}
                              </Pill>
                            </span>
                            <span className="da-grid__cell muted">{caption ?? '—'}</span>
                            <span className="da-grid__cell da-grid__cell--right">
                              {!isActionableConnector(connector) ? null : connector.status ===
                                'authorized' ? (
                                <Button
                                  color="danger"
                                  disabled={busy}
                                  loading={busy}
                                  onClick={() => disconnect(actionInput).catch(() => undefined)}
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
                                  onClick={() => authorize(actionInput).catch(() => undefined)}
                                  size="sm"
                                  variant="soft"
                                >
                                  Authorize
                                </Button>
                              )}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>
    </section>
  )
}

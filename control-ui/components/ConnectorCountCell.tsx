'use client'

import React, { useState } from 'react'

// Hover card over an agent's connectors count. The agent's private connector
// context is an implementation detail, so the card shows a neutral
// "Connectors" heading plus the attached MCP-server names — never the context
// slug. The card is keyboard-accessible (focus + blur mirror hover) and
// `role="tooltip"` keeps screen readers in sync with what's visible. Clicking
// opens the agent's own Connectors tab. Shared by the Agents table and the
// Users & Teams Access rows so both render identically.
export function ConnectorCountHoverCard({
  hostKey,
  servers,
  onOpenConnectors,
}: {
  hostKey: string
  servers: string[]
  onOpenConnectors: () => void
}) {
  const [open, setOpen] = useState(false)
  const hasServers = servers.length > 0
  const cardId = `agent-connectors-${hostKey}`

  const trigger = (
    <button
      type="button"
      className="cu-link cu-host-connectors-count"
      onClick={e => {
        e.stopPropagation()
        onOpenConnectors()
      }}
      onKeyDown={e => e.stopPropagation()}
      aria-describedby={hasServers && open ? cardId : undefined}
    >
      {servers.length}
    </button>
  )

  if (!hasServers) return trigger

  return (
    <span
      className="cu-host-connectors-hover"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {trigger}
      {open ? (
        <div role="tooltip" id={cardId} className="cu-agent-connectors-summary">
          <div className="cu-agent-connectors-summary__head">
            <span>Connectors</span>
            <span>{servers.length}</span>
          </div>
          <ul className="cu-agent-connectors-summary__list">
            {servers.map(server => (
              <li key={server} title={server}>
                {server}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  )
}

// Full cell for an agent row: count pill (or muted placeholders when the
// enrichment map lacks the agent's scope), hover card, and click-through.
export function ConnectorCountCell({
  agentKey,
  contextRef,
  contextsByRef,
  onOpenConnectors,
}: {
  agentKey: string
  contextRef: string
  contextsByRef: Record<string, string[]>
  onOpenConnectors: () => void
}) {
  const servers = contextRef ? contextsByRef[contextRef] : undefined
  if (!contextRef) {
    return <span className="cu-table__cell-muted">—</span>
  }
  if (!Array.isArray(servers) || servers.length === 0) {
    return <span className="cu-table__cell-muted">0</span>
  }
  return (
    <ConnectorCountHoverCard
      hostKey={agentKey}
      servers={servers}
      onOpenConnectors={onOpenConnectors}
    />
  )
}

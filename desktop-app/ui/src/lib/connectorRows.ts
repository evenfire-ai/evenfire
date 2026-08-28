import type { RpcAgentConnectors, RpcConnector } from '../../../src/types'
import { formatMcpServerDisplayName } from './format'

/**
 * A single row of the Connectors table.
 *
 * In the agent-centric model (spec §5.E) the table shows ONE row per
 * `(connector, agent)`: clicking a row deep-links to THAT agent's Connectors
 * tab. The grant itself is never per-agent — `oauth-context`/`grantScope:'context'`
 * grants are keyed by `(server, context)` and `oauth-user` grants by
 * `(server, userId)` — so a row carries TWO keys:
 *
 *   - `renderKey`  — unique per `(agent, context, server)`; the React key.
 *   - `grantKey`   — the GRANT identity `(context, server)`; the anchor for the
 *                    `pendingKey` busy-state and the authorize/disconnect action.
 *
 * Two agents that share a grant produce two rows with the SAME `grantKey` and
 * DISTINCT `renderKey`. `agentName` is the row's own agent: both the deep-link
 * target and the RPC-token minter for the action.
 */
export type ConnectorRow = {
  /** React key — UNIQUE per row: `(agent, context, server)`. */
  renderKey: string
  /**
   * Grant identity `(context, server)` = `connectorRowKey(contextRef, name)`.
   * The `pendingKey` busy-state anchor and the action target. Shared by every
   * sibling row of the same grant.
   */
  grantKey: string
  /**
   * The connector policy for this row, with the grant's CANONICAL status
   * stamped in (max `STATUS_RANK` across all `(agent, connector)` appearances of
   * the grant) so sibling rows can never disagree on status. `provider`/
   * `authKind`/`grantScope` are invariant across the grant, so this row's own
   * connector describes them.
   */
  connector: RpcConnector
  contextRef: string | null
  /**
   * The agent this row belongs to: the deep-link destination AND the agent used
   * to mint the RPC token for authorize/disconnect.
   */
  agentName: string
}

/**
 * The single canonical key for a `(context, server)` pair — the GRANT identity.
 * Used for BOTH the status fold in `deriveConnectorRows` and the `pendingKey`
 * busy-state anchor, so a row, its grant, and its busy state can never disagree.
 *
 * Anchored to the VISIBLE `(context, server)`, not to the agent, so the busy
 * spinner tracks the grant even though the action mints its token under one
 * agent. Two collision guards:
 *  - a leading `\x01` (null) / `\x02` (present) tag so "no context" can never be
 *    confused with a context literally named `''`;
 *  - a non-printable `\x00` delimiter so `('a', 'b c')` and `('a b', 'c')` map
 *    to distinct keys.
 */
export function connectorRowKey(contextRef: string | null, connectorName: string): string {
  const context = contextRef === null ? '\x01' : `\x02${contextRef}`
  return `${context}\x00${connectorName}`
}

/**
 * The React key for a row — UNIQUE per `(agent, context, server)`. Prefixes the
 * agent name onto the grant key with the same `\x00` delimiter, so two agents
 * sharing a grant get distinct render keys while still exposing the shared
 * `grantKey` for the busy-state/action.
 *
 * Injectivity relies on `agentName` containing no `\x00`: the FIRST `\x00`
 * cleanly splits the agent prefix from the grant key (whose own `\x01`/`\x02`
 * tag + `\x00` guards keep it injective in `(contextRef, connectorName)`). Agent
 * names are DNS labels, so `\x00` can never appear — the boundary is unambiguous.
 */
export function connectorRenderKey(
  agentName: string,
  contextRef: string | null,
  connectorName: string
): string {
  return `${agentName}\x00${connectorRowKey(contextRef, connectorName)}`
}

// "More connected" ranking for the status fold below. A grant is
// per-context/per-user (not per-agent), so every agent that lists a grant should
// report the same status; if they ever diverge, prefer the most connected so an
// existing grant is never hidden behind a stale row.
const STATUS_RANK: Record<RpcConnector['status'], number> = {
  authorized: 2,
  requires_setup: 1,
  no_oauth: 0,
}

/**
 * Fold the per-agent payload into a flat, sorted list of `(connector, agent)`
 * rows. Pure and total: safe to call in a `useMemo`.
 *
 * Two passes:
 *  1. Fold the CANONICAL status per grant (`max STATUS_RANK` across every
 *     `(agent, connector)` appearance of that grant).
 *  2. Explode to one row per `(agent, connector)`, stamping each sibling row
 *     with the grant's canonical status. A single agent that lists the same
 *     connector twice (an anomaly) collapses by `renderKey`.
 */
export function deriveConnectorRows(agents: RpcAgentConnectors[]): ConnectorRow[] {
  // Pass 1: canonical status per grant.
  const canonicalStatus = new Map<string, RpcConnector['status']>()
  for (const agent of agents) {
    for (const connector of agent.connectors) {
      const grantKey = connectorRowKey(agent.contextRef, connector.name)
      const current = canonicalStatus.get(grantKey)
      if (current === undefined || STATUS_RANK[connector.status] > STATUS_RANK[current]) {
        canonicalStatus.set(grantKey, connector.status)
      }
    }
  }

  // Pass 2: one row per (agent, connector). Dedup by renderKey collapses a
  // single agent that lists the same connector.name twice (anomaly); distinct
  // agents are never collapsed.
  const byRenderKey = new Map<string, ConnectorRow>()
  for (const agent of agents) {
    for (const connector of agent.connectors) {
      const grantKey = connectorRowKey(agent.contextRef, connector.name)
      const renderKey = connectorRenderKey(agent.name, agent.contextRef, connector.name)
      if (byRenderKey.has(renderKey)) continue
      const status = canonicalStatus.get(grantKey) ?? connector.status
      byRenderKey.set(renderKey, {
        renderKey,
        grantKey,
        connector: { ...connector, status },
        contextRef: agent.contextRef,
        agentName: agent.name,
      })
    }
  }

  const rows = Array.from(byRenderKey.values())

  // Stable total order: displayed name, then real name, then context, then
  // agent. Purely presentational — groups the same connector's rows contiguously
  // and keeps the output deterministic for a given payload.
  rows.sort((a, b) => {
    const byDisplay = formatMcpServerDisplayName(a.connector.name).localeCompare(
      formatMcpServerDisplayName(b.connector.name)
    )
    if (byDisplay !== 0) return byDisplay
    const byName = a.connector.name.localeCompare(b.connector.name)
    if (byName !== 0) return byName
    const byContext = (a.contextRef ?? '').localeCompare(b.contextRef ?? '')
    if (byContext !== 0) return byContext
    return a.agentName.localeCompare(b.agentName)
  })

  return rows
}

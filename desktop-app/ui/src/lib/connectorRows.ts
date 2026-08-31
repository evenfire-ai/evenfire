import type { RpcAgentConnectors, RpcConnector } from '../../../src/types'
import { formatMcpServerDisplayName } from './format'

/**
 * A connector is "shared by the team" when its grant is keyed by Context, not by
 * user (spec §1.3). Authorizing/disconnecting it affects EVERYONE in the
 * Context, so both the confirm-dialog copy and the panel warning key off this.
 *
 * Lives in `lib/` (pure, no react) so `lib/connectorPresentation` can consume it
 * without `lib/` importing from `hooks/domain/` — the layering runs one way.
 */
export function isSharedConnector(
  connector: Pick<RpcConnector, 'authKind' | 'grantScope'>
): boolean {
  return connector.grantScope === 'context' || connector.authKind === 'oauth-context'
}

/** A connector row is actionable from the connectors rail only when it is
 *  OAuth-governed: `authorized` → disconnect, `requires_setup` → authorize.
 *  `no_oauth` (static / none) is managed by Secret, out of scope — no button. */
export function isActionableConnector(connector: Pick<RpcConnector, 'status'>): boolean {
  return connector.status === 'authorized' || connector.status === 'requires_setup'
}

/**
 * A single deduplicated row of the Connectors table.
 *
 * The payload from rpc-proxy is grouped BY AGENT, but a grant is never
 * per-agent: `oauth-context` grants are keyed by `(server, context)` and
 * `oauth-user` grants by `(server, userId)`. So the correct dedup key for the
 * view is `(server, context)` — two agents that share a Context list the SAME
 * connector once, not twice.
 */
export type ConnectorRow = {
  /** Stable per-row key `(context, server)` — also the `pendingKey` anchor. */
  key: string
  /**
   * The representative connector policy for the group. `status`/`provider`/
   * `authKind`/`grantScope` are invariant across a `(server, context)` group,
   * so any member describes the row; see the defensive status merge below.
   */
  connector: RpcConnector
  contextRef: string | null
  /**
   * The agent used to mint the RPC token for authorize/disconnect. The row is
   * no longer per-agent, but the action IPC still needs a hostRef, so we pick
   * the first agent alphabetically as a deterministic representative. (This
   * replaces spec decision D-1: the view is per `(server, context)`, and the
   * agent is only a token-minter, not part of the grant identity.)
   */
  representativeAgent: string
  /** All agents in this `(server, context)` group, sorted, for the AGENTS cell. */
  usedByAgents: string[]
}

/**
 * The single canonical key for a `(context, server)` pair. Used for BOTH the
 * grouping in `deriveConnectorRows` and the `pendingKey` busy-state anchor, so
 * a row, its group, and its busy state can never disagree.
 *
 * Anchored to the VISIBLE `(context, server)`, not to the representative agent,
 * so the busy spinner tracks the row the user clicked even though the action
 * mints its token under one agent. Two collision guards:
 *  - a leading `\x01` (null) / `\x02` (present) tag so "no context" can never be
 *    confused with a context literally named `''`;
 *  - a non-printable `\x00` delimiter so `('a', 'b c')` and `('a b', 'c')` map
 *    to distinct keys.
 */
export function connectorRowKey(contextRef: string | null, connectorName: string): string {
  const context = contextRef === null ? '\x01' : `\x02${contextRef}`
  return `${context}\x00${connectorName}`
}

// "More connected" ranking for the defensive merge below. A grant is
// per-context/per-user (not per-agent), so every agent in a `(server, context)`
// group should report the same status; if they ever diverge, prefer the most
// connected so an existing grant is never hidden behind a stale row.
const STATUS_RANK: Record<RpcConnector['status'], number> = {
  authorized: 2,
  requires_setup: 1,
  no_oauth: 0,
}

/**
 * Fold the per-agent payload into a flat, deduplicated, sorted list of
 * `(server, context)` rows. Pure and total: safe to call in a `useMemo`.
 */
export function deriveConnectorRows(agents: RpcAgentConnectors[]): ConnectorRow[] {
  const groups = new Map<
    string,
    { connector: RpcConnector; contextRef: string | null; agents: Set<string> }
  >()

  for (const agent of agents) {
    for (const connector of agent.connectors) {
      const key = connectorRowKey(agent.contextRef, connector.name)
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          connector,
          contextRef: agent.contextRef,
          agents: new Set([agent.name]),
        })
        continue
      }
      existing.agents.add(agent.name)
      // Defensive only: keep the most-connected policy if statuses diverge
      // within a group (they should not — the grant is per-context/per-user).
      if (STATUS_RANK[connector.status] > STATUS_RANK[existing.connector.status]) {
        existing.connector = connector
      }
    }
  }

  const rows: ConnectorRow[] = Array.from(groups.values()).map(group => {
    const usedByAgents = Array.from(group.agents).sort((a, b) => a.localeCompare(b))
    return {
      key: connectorRowKey(group.contextRef, group.connector.name),
      connector: group.connector,
      contextRef: group.contextRef,
      representativeAgent: usedByAgents[0] ?? '',
      usedByAgents,
    }
  })

  // Stable total order: displayed name, then real name, then context. Purely
  // presentational — groups the same connector's contexts contiguously and
  // keeps the output deterministic for a given payload.
  rows.sort((a, b) => {
    const byDisplay = formatMcpServerDisplayName(a.connector.name).localeCompare(
      formatMcpServerDisplayName(b.connector.name)
    )
    if (byDisplay !== 0) return byDisplay
    const byName = a.connector.name.localeCompare(b.connector.name)
    if (byName !== 0) return byName
    return (a.contextRef ?? '').localeCompare(b.contextRef ?? '')
  })

  return rows
}

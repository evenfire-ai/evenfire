import type { ConnectorActionInput } from '../hooks/domain/useConnectorsController'

/**
 * Per-connector OAuth action data for one health row, keyed by mcp-server name.
 * The parent (AgentWorkspace) derives this from `deriveConnectorRows` filtered to
 * the selected agent, including ONLY rows for which `isActionableConnector` is
 * true — so the presence of an entry means the row has an Authorize/Disconnect
 * button. The table stays dumb: it never re-derives actionability.
 */
export interface McpServerConnectorAction {
  /** Passed straight back to the parent's `authorize`/`disconnect` handlers. */
  actionInput: ConnectorActionInput
  /** `true` → render Disconnect; `false` → render Authorize. */
  authorized: boolean
  /** Busy state anchored to the grant (`pendingKey === grantKey`) — disables/loads the button. */
  busy: boolean
}

export interface McpServerHealthTableProps {
  hostRef: string
  /** Names this agent is configured to use (from session catalog). */
  mcpServerNames: string[]
  /** Latest HostRuntimeStatus for this agent, or null if not yet available. */
  status: import('../../../src/types').HostRuntimeStatus | null
  /** Clock injection point for tests. Defaults to Date.now() when absent. */
  now?: number
  /**
   * Optional manual-refresh handler. When provided, a refresh icon renders
   * next to the section heading. Fires on click; the parent should re-fetch
   * the session catalog AND force the host-status subscription to reconnect.
   */
  onRefresh?: () => void | Promise<void>
  /** True while `onRefresh` is in flight — the icon animates while busy. */
  refreshing?: boolean
  /**
   * Initial expanded state. Defaults to false (collapsed) — the header is
   * always visible; the body unfolds on click. Tests use this to render the
   * expanded shape without simulating a click.
   */
  defaultExpanded?: boolean
  /**
   * Forces the table body to stay expanded and disables collapsing.
   */
  alwaysExpanded?: boolean
  /**
   * Optional per-connector OAuth action data, keyed by mcp-server name. When
   * provided, an Actions column renders; a row whose name maps to an entry gets
   * an Authorize/Disconnect button. Absent (health-only usage) → no Actions
   * column, identical to the prior two-column table.
   */
  connectorActions?: Map<string, McpServerConnectorAction>
  /** Fired when the Authorize button is clicked for a `requires_setup` connector. */
  onAuthorize?: (input: ConnectorActionInput) => void
  /** Fired when the Disconnect button is clicked for an `authorized` connector. */
  onDisconnect?: (input: ConnectorActionInput) => void
}

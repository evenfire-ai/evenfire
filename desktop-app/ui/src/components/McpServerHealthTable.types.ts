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
}

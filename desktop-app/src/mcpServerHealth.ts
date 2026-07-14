/**
 * Desktop-side pure logic for MCP server health.
 *
 *   - Merges the session-catalog `agents[].mcpServers` (names only) with the
 *     latest RPC snapshot per `hostRef` (HostRuntimeStatus.mcpServers) to
 *     produce a UI-ready row per configured server.
 *   - Applies staleness per spec §7.1 (STALE_AFTER_MS from last observedAt).
 *   - Derives a single UI label (Running / Degraded / Failed / Starting /
 *     Disabled / Unknown / Stale) from state + toolCount + freshness.
 *
 * Spec: docs/plans/mcp-server-health-in-desktop.md §4.4, §5, §6, §7
 */
import type {
  AgentWithMcpServers,
  HostRuntimeStatus,
  McpServerFailureReason,
  McpServerHealthRow,
  McpServerState,
} from './types'

/** Desktop polls the host-status endpoint every POLL_INTERVAL_MS (spec §6.1). */
export const POLL_INTERVAL_MS = 60_000

/**
 * While any row is `connecting`, desktop polls faster to avoid the
 * first-connect UX penalty (spec review item: cold-open latency).
 */
export const FAST_POLL_INTERVAL_MS = 5_000

/**
 * A row is stale when observedAt is older than STALE_AFTER_MS. Pinned to
 * `2 × POLL_INTERVAL_MS` so a single missed tick doesn't trip staleness.
 */
export const STALE_AFTER_MS = 2 * POLL_INTERVAL_MS

/** Max concurrent background pollers when the app has multiple agents open. */
export const MAX_CONCURRENT_POLLERS = 3

/**
 * Exact failure messages emitted by mcp-host. Exported so E2E tests can
 * assert against them by string equality (spec §9, scenario #1). Keep in
 * sync with mcp-host/src/mcp/serverStatus.ts.
 */
export const MCP_INIT_AUTH_FAILED_MESSAGE = 'initialize returned 401'
export const MCP_NOT_READY_MESSAGE = 'control plane reported server not ready'

export type McpServerUiLabel =
  | 'running'
  | 'degraded'
  | 'failed'
  | 'starting'
  | 'disabled'
  | 'unknown'
  | 'stale'

/** A health row annotated with the desktop-side derived UI label. */
export type MergedMcpServerRow = McpServerHealthRow & {
  label: McpServerUiLabel
  stale: boolean
}

/** Per-agent health table. `unknownFallback` is true when the host status
 * snapshot was absent or omitted `mcpServers` (old mcp-host) — the UI
 * should show a "waiting for status" hint instead of mis-labeling rows. */
export type AgentHealthTable = {
  hostRef: string
  contextRef: string | null
  rows: MergedMcpServerRow[]
  unknownFallback: boolean
}

/** Returns true if the row's observedAt is older than STALE_AFTER_MS.
 * Non-parseable timestamps are treated as stale. */
export function isStale(observedAt: string, nowMs: number, threshold = STALE_AFTER_MS): boolean {
  const t = Date.parse(observedAt)
  if (!Number.isFinite(t)) return true
  return nowMs - t > threshold
}

/**
 * Map a health row to a single UI label.
 *
 * Priority: `disabled` is operator intent and never goes stale. For all
 * other states, staleness takes precedence over state-derived labels since
 * stale data should not be trusted as live.
 */
export function classifyRowLabel(
  row: McpServerHealthRow,
  nowMs: number,
  threshold = STALE_AFTER_MS
): McpServerUiLabel {
  // `disabled` is operator intent and never goes stale.
  if (row.state === 'disabled') return 'disabled'
  // `unknown` is already the "no data yet" label; don't promote it to `stale`
  // just because the synthesized row carries an epoch timestamp.
  if (row.state === 'unknown') return 'unknown'

  if (isStale(row.observedAt, nowMs, threshold)) return 'stale'

  switch (row.state) {
    case 'connected':
      return row.toolCount > 0 ? 'running' : 'degraded'
    case 'connecting':
      return 'starting'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

/**
 * Synthesize an "unknown" row for a catalog-listed server that has no
 * corresponding RPC row. Spec §5: catalog names missing from the RPC status
 * render as `state: "unknown"` — no empty-list regression.
 */
function unknownRow(name: string): McpServerHealthRow {
  return {
    name,
    state: 'unknown',
    expected: true,
    toolCount: 0,
    reason: null,
    message: null,
    // observedAt of 1970 → always "stale" unless threshold check is skipped.
    // classifyRowLabel short-circuits on state==='unknown' before staleness.
    observedAt: new Date(0).toISOString(),
  }
}

/**
 * Merge a single agent's catalog entry with the latest host-status snapshot.
 *
 *   - For each name in `agent.mcpServers`, bind the matching row from
 *     `status?.mcpServers` by name; synthesize an `unknown` row if absent.
 *   - Rows present in status but not in the catalog are ignored (spec §5).
 *   - `unknownFallback` is true when the caller has no status yet OR the
 *     status omits `mcpServers` — useful for the UI to show "awaiting status".
 */
export function mergeAgentHealth(
  agent: AgentWithMcpServers,
  status: HostRuntimeStatus | null | undefined,
  nowMs: number,
  threshold = STALE_AFTER_MS
): AgentHealthTable {
  const statusRows = status?.mcpServers
  const unknownFallback = statusRows === undefined

  const byName = new Map<string, McpServerHealthRow>()
  if (Array.isArray(statusRows)) {
    for (const r of statusRows) byName.set(r.name, r)
  }

  const rows: MergedMcpServerRow[] = agent.mcpServers.map(({ name }) => {
    const base = byName.get(name) ?? unknownRow(name)
    const label = classifyRowLabel(base, nowMs, threshold)
    return {
      ...base,
      label,
      stale: label === 'stale',
    }
  })

  return {
    hostRef: agent.name,
    contextRef: agent.contextRef,
    rows,
    unknownFallback,
  }
}

/**
 * Merge every agent in the session catalog with its latest status.
 * Returns one table per agent, keyed by hostRef (== agent name).
 */
export function mergeCatalogHealth(
  agents: readonly AgentWithMcpServers[],
  statusByHostRef: ReadonlyMap<string, HostRuntimeStatus | null | undefined>,
  nowMs: number,
  threshold = STALE_AFTER_MS
): AgentHealthTable[] {
  return agents.map(agent =>
    mergeAgentHealth(agent, statusByHostRef.get(agent.name), nowMs, threshold)
  )
}

/**
 * True when any merged row is in `connecting`/`starting`. Used by the poller
 * to switch to FAST_POLL_INTERVAL_MS until the state settles.
 */
export function hasConnectingRow(tables: readonly AgentHealthTable[]): boolean {
  for (const t of tables) {
    for (const r of t.rows) if (r.label === 'starting') return true
  }
  return false
}

/**
 * Pick an interval for the next poll. Fast while anything is `connecting`,
 * otherwise steady-state. Exposed as a pure function so the scheduler (M7)
 * and its tests can reuse the same decision.
 */
export function nextPollIntervalMs(tables: readonly AgentHealthTable[]): number {
  return hasConnectingRow(tables) ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS
}

/** Re-export for tests that want to assert on the reason taxonomy by name. */
export type { McpServerFailureReason, McpServerHealthRow, McpServerState }

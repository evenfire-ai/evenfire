/**
 * MCP Server Health Tracking.
 *
 * In-memory state machine for per-MCP-server health, surfaced by mcp-host
 * via `GET /v1/runtime/status` and consumed by desktop via rpc-proxy.
 *
 * Spec: docs/plans/mcp-server-health-in-desktop.md §4.2, §4.4, §4.5
 */

export type McpServerState = 'connected' | 'connecting' | 'failed' | 'disabled' | 'unknown'

export type McpServerFailureReason =
  | 'auth_failed'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'network'
  | 'handshake'
  | 'timeout'
  | 'not_ready'
  | 'unknown'

/**
 * Exported message constants for E2E assertions. Keep these stable; desktop
 * tests match against them by string equality.
 */
export const MCP_INIT_AUTH_FAILED_MESSAGE = 'initialize returned 401'
export const MCP_NOT_READY_MESSAGE = 'control plane reported server not ready'

export interface McpServerStatusEntry {
  name: string
  state: McpServerState
  expected: boolean
  toolCount: number
  reason: McpServerFailureReason | null
  message: string | null
  observedAt: string
}

/**
 * Classify a thrown error into a spec-defined failure reason.
 *
 * Order matters: HTTP-status detection is preferred over string matching so
 * that e.g. a 401 with "timeout" in its message still maps to auth_failed.
 */
export function classifyConnectError(error: unknown): {
  reason: McpServerFailureReason
  message: string
} {
  const msg = errorMessage(error)
  const httpStatus = extractHttpStatus(error, msg)

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      reason: 'auth_failed',
      message:
        httpStatus === 401 ? MCP_INIT_AUTH_FAILED_MESSAGE : `initialize returned ${httpStatus}`,
    }
  }
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    return { reason: 'upstream_4xx', message: `initialize returned ${httpStatus}` }
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus < 600) {
    return { reason: 'upstream_5xx', message: `initialize returned ${httpStatus}` }
  }

  const code = extractErrorCode(error)
  if (code === 'ETIMEDOUT' || code === -32001 || /timed? ?out/i.test(msg)) {
    return { reason: 'timeout', message: truncate(msg || 'request timed out') }
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  ) {
    return { reason: 'network', message: truncate(msg || code) }
  }

  // MCP SDK surfaces protocol errors with numeric JSON-RPC codes in msg.
  if (/jsonrpc|protocol|invalid params|invalid request/i.test(msg) || isZodValidationError(error)) {
    return {
      reason: 'handshake',
      message: isZodValidationError(error) ? 'invalid MCP response schema' : truncate(msg),
    }
  }

  return { reason: 'unknown', message: truncate(msg || 'unknown error') }
}

function errorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const m = (error as Record<string, unknown>).message
    if (typeof m === 'string') return m
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function extractHttpStatus(error: unknown, msg: string): number | null {
  if (error && typeof error === 'object') {
    const status =
      (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode
    if (typeof status === 'number' && Number.isInteger(status)) return status
    const code = (error as Record<string, unknown>).code
    // MCP SDK sometimes puts an HTTP status in `code` for StreamableHTTP errors.
    if (typeof code === 'number' && code >= 100 && code < 600) return code
  }
  // Fallback: "HTTP 401", "status 500", "returned 404"
  const m = msg.match(/(?:HTTP|status|returned|code)[^\d]{0,6}(\d{3})/i)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 100 && n < 600) return n
  }
  return null
}

function extractErrorCode(error: unknown): string | number | null {
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code
    if (typeof code === 'string') return code
    if (typeof code === 'number') return code
  }
  return null
}

function isZodValidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as Record<string, unknown>
  const hasIssues = Array.isArray(candidate.issues)
  return hasIssues && (candidate.name === 'ZodError' || candidate.name === '$ZodError')
}

function truncate(s: string, max = 240): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * In-memory tracker. One instance per mcp-host process.
 *
 * State machine rules (spec §4.5):
 *   - Initial: `connecting` (via markConnecting) OR `disabled` (via markDisabled).
 *   - After `connected`, do NOT return to `connecting` on transient refresh
 *     failure — stay `connected`, update toolCount + optional reason/message.
 *   - `connecting` can reappear only after reset() (process/subsystem reset).
 */
export class ServerStatusTracker {
  private entries = new Map<string, McpServerStatusEntry>()
  private clock: () => Date

  constructor(clock?: () => Date) {
    this.clock = clock ?? (() => new Date())
  }

  /**
   * Called when mcp-host begins attempting to connect to a server.
   * Sets state=connecting, expected=true. No-op if already connected.
   */
  markConnecting(name: string): void {
    const prev = this.entries.get(name)
    if (prev && prev.state === 'connected') {
      // Monotonic: can't go back to connecting without a reset.
      return
    }
    this.write({
      name,
      state: 'connecting',
      expected: true,
      toolCount: 0,
      reason: null,
      message: null,
    })
  }

  /**
   * Called after tools/list succeeds at least once.
   */
  markConnected(name: string, toolCount: number): void {
    this.write({
      name,
      state: 'connected',
      expected: true,
      toolCount: Math.max(0, toolCount | 0),
      reason: null,
      message: null,
    })
  }

  /**
   * Called when a connect attempt fails.
   */
  markFailed(name: string, error: unknown, opts?: { expected?: boolean }): void {
    const { reason, message } = classifyConnectError(error)
    this.write({
      name,
      state: 'failed',
      expected: opts?.expected ?? true,
      toolCount: 0,
      reason,
      message,
    })
  }

  /**
   * Called when the control plane reports the server deployment is not ready.
   * Classified as reason="not_ready" (transient infra), not "disabled".
   */
  markNotReady(name: string, message?: string): void {
    this.write({
      name,
      state: 'failed',
      expected: true,
      toolCount: 0,
      reason: 'not_ready',
      message: message ?? MCP_NOT_READY_MESSAGE,
    })
  }

  /**
   * Called when the CR has enabled=false (operator intent, not infra).
   */
  markDisabled(name: string): void {
    this.write({
      name,
      state: 'disabled',
      expected: false,
      toolCount: 0,
      reason: null,
      message: null,
    })
  }

  /**
   * Update tool count without changing state (background refresh / reconnect).
   * Spec §4.5: on refresh failure stay connected; set toolCount to reality.
   */
  updateToolCount(name: string, toolCount: number, opts?: { refreshError?: unknown }): void {
    const prev = this.entries.get(name)
    if (!prev) return
    if (prev.state !== 'connected') return // only meaningful while connected

    const patch: Partial<McpServerStatusEntry> = {
      toolCount: Math.max(0, toolCount | 0),
    }
    if (opts?.refreshError) {
      const { reason, message } = classifyConnectError(opts.refreshError)
      patch.reason = reason
      patch.message = message
    } else {
      patch.reason = null
      patch.message = null
    }
    this.write({ ...prev, ...patch })
  }

  /**
   * Mark observedAt fresh without changing anything else. Called by the
   * heartbeat in M2 after a successful probe of a connected server.
   */
  touch(name: string): void {
    const prev = this.entries.get(name)
    if (!prev) return
    this.write(prev)
  }

  /**
   * Remove a server from tracking (e.g. deleted from context).
   */
  remove(name: string): void {
    this.entries.delete(name)
  }

  /**
   * Reset tracking for a server (or all servers) back to "unknown".
   * Called on process restart or explicit subsystem reset — after reset,
   * markConnecting may transition to connecting again (monotonicity reset).
   */
  reset(name?: string): void {
    if (name === undefined) {
      this.entries.clear()
      return
    }
    this.entries.delete(name)
  }

  get(name: string): McpServerStatusEntry | undefined {
    const entry = this.entries.get(name)
    return entry ? { ...entry } : undefined
  }

  snapshot(): McpServerStatusEntry[] {
    return [...this.entries.values()].map(e => ({ ...e }))
  }

  size(): number {
    return this.entries.size
  }

  private write(next: Omit<McpServerStatusEntry, 'observedAt'>): void {
    this.entries.set(next.name, {
      ...next,
      observedAt: this.clock().toISOString(),
    })
  }
}

import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'

/**
 * Per-MCP-server health row as emitted by mcp-host and forwarded by rpc-proxy.
 * Mirrors `McpServerStatusEntry` in mcp-host/src/mcp/serverStatus.ts (the two
 * services cannot share types directly; keep these in sync).
 *
 * Spec: docs/plans/mcp-server-health-in-desktop.md §4.2
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

export type McpServerHealthRow = {
  name: string
  state: McpServerState
  expected: boolean
  toolCount: number
  reason: McpServerFailureReason | null
  message: string | null
  observedAt: string
}

export type HostRuntimeStatus = {
  hostRef: string
  agent: {
    state: string
    currentTaskId: string | null
    tasksProcessed: number
    tasksSucceeded: number
    tasksFailed: number
    uptime: number
  }
  queue: {
    pending: number
    processing: number
    completed: number
    failed: number
  }
  cronJobs: number
  pendingApprovalsCount: number
  /**
   * Per-MCP-server health. Absent when upstream mcp-host is an older build;
   * desktop treats absence as "unknown for every server" per spec §5.
   */
  mcpServers?: McpServerHealthRow[]
  /**
   * Non-null when the Host is degraded and refusing new tasks. Currently
   * the only emitted reason is `llm_key_missing`. Forward to consumers
   * verbatim so the Desktop App can render a banner and disable composer
   * input.
   */
  degraded?: {
    reason: 'llm_key_missing'
    message: string
  } | null
  observedAt: string
}

export type HostRuntimeHealth = {
  hostRef: string
  status: string
  observedAt: string
}

export type HostActivitySeverity = 'info' | 'warn' | 'error'
export type HostActivityType =
  | 'task.queued'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'llm.requested'
  | 'llm.responded'
  | 'llm.failed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.denied'
  | 'safety.input_blocked'
  | 'safety.output_sanitized'
  | 'queue.depth.changed'
  | 'agent.state.changed'
export type HostActivityEvent = {
  version: '1.0'
  eventId: string
  hostRef: string
  ts: string
  taskId?: string
  type: HostActivityType
  title: string
  severity: HostActivitySeverity
  meta: Record<string, unknown>
  redactions: string[]
}
export type HostActivitySnapshot = {
  hostRef: string
  version: '1.0'
  items: HostActivityEvent[]
  nextCursor: string | null
}

export type HostRuntimeMessageRequest = {
  content: string
  channelType?: string
  sender?: string
  hostRef?: string
  // Stable idempotency identity for cross-delivery duplicate suppression at
  // mcp-host (MessageQueue.deliveryKeyOf keys on messageId). MUST be identical
  // across the first forward and the wake-and-hold retry so a re-forwarded turn
  // is deduped (replayed) instead of re-executed.
  messageId?: string
  [key: string]: unknown
}

// REST host runtime submit path:
// rpc-proxy accepts a REST body from desktop and submits to mcp-host runtime REST.
// This function is intentionally separate from stream/status forwarding logic.
export async function forwardHostMessageToHost(
  host: ResolvedServerConnection,
  message: HostRuntimeMessageRequest,
  options?: { async?: boolean }
): Promise<Record<string, unknown>> {
  const payload = {
    ...message,
    hostRef: String(message.hostRef || host.name).trim(),
  }
  const baseUrl = host.url.replace(/\/+$/, '')
  const query = options?.async ? '?async=true' : ''
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs)
  try {
    const response = await fetch(`${baseUrl}/v1/runtime/messages${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...host.headers,
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    })
    const rawBody = await response.text()
    if (!response.ok) {
      throw new UpstreamHostError(response.status, rawBody.slice(0, 300))
    }

    let body: Record<string, unknown> = {}
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody) as unknown
        body =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
      } catch {
        body = {}
      }
    }
    return body
  } finally {
    clearTimeout(timeout)
  }
}

export async function forwardTaskResultFromHost(
  host: ResolvedServerConnection,
  taskId: string
): Promise<Record<string, unknown> | null> {
  const baseUrl = host.url.replace(/\/+$/, '')
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs)
  try {
    const response = await fetch(
      `${baseUrl}/v1/runtime/tasks/${encodeURIComponent(taskId)}/result`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...host.headers,
        },
        signal: abortController.signal,
      }
    )
    if (response.status === 404) return null
    if (!response.ok) throw new UpstreamHostError(response.status, '')
    const rawBody = await response.text()
    if (!rawBody.trim()) return null
    try {
      const parsed = JSON.parse(rawBody) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  } finally {
    clearTimeout(timeout)
  }
}

export type CancelUpstreamResult = {
  status: number
  body: string
  contentType: string | null
}

export async function forwardCancelToHost(
  host: ResolvedServerConnection,
  taskId: string,
  userId?: string
): Promise<CancelUpstreamResult> {
  const baseUrl = host.url.replace(/\/+$/, '')
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs)
  // Mirrors the approve/deny pattern: always forward userId so mcp-host can
  // apply the ownership check. Falls back to 'desktop-app' when absent.
  const upstreamBody = { userId: userId || 'desktop-app' }
  try {
    const response = await fetch(
      `${baseUrl}/v1/runtime/tasks/${encodeURIComponent(taskId)}/cancel`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...host.headers,
        },
        body: JSON.stringify(upstreamBody),
        signal: abortController.signal,
      }
    )
    const body = await response.text()
    return {
      status: response.status,
      body,
      contentType: response.headers.get('content-type'),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function asObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function asNumber(input: unknown): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : 0
}

function asString(input: unknown): string {
  return typeof input === 'string' ? input : ''
}

function asNullableString(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input : null
}

const VALID_MCP_STATES: ReadonlySet<McpServerState> = new Set([
  'connected',
  'connecting',
  'failed',
  'disabled',
  'unknown',
])

const VALID_MCP_REASONS: ReadonlySet<McpServerFailureReason> = new Set([
  'auth_failed',
  'upstream_4xx',
  'upstream_5xx',
  'network',
  'handshake',
  'timeout',
  'not_ready',
  'unknown',
])

function normalizeMcpServerRow(raw: unknown): McpServerHealthRow | null {
  const row = asObject(raw)
  if (!row) return null
  const name = asString(row.name)
  if (!name) return null

  const stateCandidate = asString(row.state) as McpServerState
  const state: McpServerState = VALID_MCP_STATES.has(stateCandidate) ? stateCandidate : 'unknown'

  const reasonCandidate = asString(row.reason) as McpServerFailureReason
  const reason: McpServerFailureReason | null =
    row.reason === null || row.reason === undefined
      ? null
      : VALID_MCP_REASONS.has(reasonCandidate)
        ? reasonCandidate
        : 'unknown'

  return {
    name,
    state,
    expected: row.expected === true,
    toolCount: Math.max(0, Math.floor(asNumber(row.toolCount))),
    reason,
    message: asNullableString(row.message),
    observedAt: asString(row.observedAt) || new Date(0).toISOString(),
  }
}

function normalizeMcpServers(raw: unknown): McpServerHealthRow[] | undefined {
  if (!Array.isArray(raw)) return undefined // absent / malformed → undefined (spec §5)
  const rows: McpServerHealthRow[] = []
  for (const entry of raw) {
    const row = normalizeMcpServerRow(entry)
    if (row) rows.push(row)
  }
  return rows
}

function normalizeHostStatusPayload(hostRef: string, raw: unknown): HostRuntimeStatus | null {
  const root = asObject(raw)
  if (!root) return null
  const agentRaw = asObject(root.agent)
  const queueRaw = asObject(root.queue)
  if (!agentRaw || !queueRaw) return null

  const pendingApprovals = Array.isArray(root.pendingApprovals) ? root.pendingApprovals : []
  const mcpServers = normalizeMcpServers(root.mcpServers)
  const degraded = normalizeDegraded(root.degraded)
  return {
    hostRef,
    agent: {
      state: asString(agentRaw.state) || 'unknown',
      currentTaskId: asNullableString(agentRaw.currentTaskId),
      tasksProcessed: asNumber(agentRaw.tasksProcessed),
      tasksSucceeded: asNumber(agentRaw.tasksSucceeded),
      tasksFailed: asNumber(agentRaw.tasksFailed),
      uptime: asNumber(agentRaw.uptime),
    },
    queue: {
      pending: asNumber(queueRaw.pending),
      processing: asNumber(queueRaw.processing),
      completed: asNumber(queueRaw.completed),
      failed: asNumber(queueRaw.failed),
    },
    cronJobs: asNumber(root.cronJobs),
    pendingApprovalsCount: pendingApprovals.length,
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
    observedAt: new Date().toISOString(),
  }
}

/**
 * Validate the optional `degraded` field shape. Older mcp-host builds omit
 * it; treat absence as undefined (caller passes through). Unknown reasons
 * are dropped to undefined so the contract stays narrow.
 */
function normalizeDegraded(
  raw: unknown
): { reason: 'llm_key_missing'; message: string } | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const obj = asObject(raw)
  if (!obj) return undefined
  const reason = asString(obj.reason)
  const message = asString(obj.message)
  if (reason !== 'llm_key_missing') return undefined
  return { reason: 'llm_key_missing', message: message || 'Host degraded' }
}

// Exported for unit tests only.
export const __test__normalizeHostStatusPayload = normalizeHostStatusPayload

async function fetchHostRuntimeJson(
  host: ResolvedServerConnection,
  path: string
): Promise<unknown> {
  const baseUrl = host.url.replace(/\/+$/, '')
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...host.headers,
      },
      signal: abortController.signal,
    })
    const rawBody = await response.text()
    if (!response.ok) {
      throw new UpstreamHostError(response.status, rawBody.slice(0, 300))
    }
    if (!rawBody.trim()) return {}
    return JSON.parse(rawBody) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Thrown when the upstream mcp-host returns a non-2xx status. Carries the
 * status code so callers (e.g. the host-status SSE loop) can distinguish
 * auth failures (401/403) from transient errors and react accordingly —
 * stream auth-expired, count consecutive errors, etc.
 */
export class UpstreamHostError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodySnippet: string
  ) {
    super(`Upstream host returned ${status}: ${bodySnippet}`)
    this.name = 'UpstreamHostError'
  }
}

// REST host runtime read path for status snapshots.
export async function forwardHostStatus(
  host: ResolvedServerConnection
): Promise<HostRuntimeStatus | null> {
  const raw = await fetchHostRuntimeJson(host, '/v1/runtime/status')
  return normalizeHostStatusPayload(host.name, raw)
}

// REST host runtime read path for health/liveness.
export async function forwardHostHealth(
  host: ResolvedServerConnection
): Promise<HostRuntimeHealth> {
  const raw = await fetchHostRuntimeJson(host, '/v1/runtime/health')
  const body = asObject(raw)
  return {
    hostRef: host.name,
    status: asString(body?.status) || 'unknown',
    observedAt: new Date().toISOString(),
  }
}

// REST host runtime read path for activity timeline snapshots.
export async function forwardHostActivity(
  host: ResolvedServerConnection,
  limit: number,
  sinceEventId?: string
): Promise<HostActivitySnapshot> {
  const params = new URLSearchParams()
  params.set('limit', String(Math.min(Math.max(limit || 50, 1), 200)))
  if (sinceEventId) params.set('sinceEventId', sinceEventId)
  const raw = await fetchHostRuntimeJson(host, `/v1/runtime/activity?${params.toString()}`)
  const body = asObject(raw)
  const itemsRaw = Array.isArray(body?.items) ? body?.items : []
  const items: HostActivityEvent[] = itemsRaw
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => entry as HostActivityEvent)
  const nextCursor = typeof body?.nextCursor === 'string' ? body.nextCursor : null
  return {
    hostRef: typeof body?.hostRef === 'string' ? body.hostRef : host.name,
    version: '1.0',
    items,
    nextCursor,
  }
}

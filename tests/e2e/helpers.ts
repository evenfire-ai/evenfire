/**
 * E2E test helpers — shared utilities for all test suites.
 */
import { execSync } from 'child_process'

export const MCP_HOST_URL = process.env.MCP_HOST_URL || 'http://localhost:8080'
export const CTX_MAPPER_URL = process.env.CTX_MAPPER_URL || 'http://localhost:8081'
export const KUBE_CONTEXT =
  process.env.KUBECONTEXT ||
  process.env.KUBE_CONTEXT ||
  process.env.MINIKUBE_PROFILE ||
  'clerum-test'
export const MCP_HOST_NAMESPACE = process.env.E2E_MCP_HOST_NAMESPACE || 'mcp-host'
const DEFAULT_HOST_REF = process.env.E2E_HOST_REF ?? 'chatllm'

let cachedMcpHostDeployment: string | undefined

type McpHostEdgeCaller = 'channel-reader' | 'rpc-proxy'

export type McpHostEdgeContext = {
  caller: McpHostEdgeCaller
  hostRef?: string
  userId?: string
  channelType?: string
  channelId?: string
  sender?: string
  requestId?: string
}

function mcpHostEdgeHeaders(ctx: McpHostEdgeContext): Record<string, string> {
  const headers: Record<string, string> = {
    'x-clerum-edge-caller': ctx.caller,
    'x-clerum-edge-host-ref': ctx.hostRef ?? DEFAULT_HOST_REF,
    'x-clerum-edge-request-id': ctx.requestId ?? `e2e-${Date.now()}`,
  }

  if (ctx.caller === 'rpc-proxy') {
    headers['x-clerum-edge-user-id'] = ctx.userId ?? 'e2e-vitest-runtime'
    headers['x-clerum-edge-team-id'] = 'e2e-team'
  } else {
    headers['x-clerum-edge-channel-type'] = ctx.channelType ?? 'telegram'
    headers['x-clerum-edge-channel-id'] = ctx.channelId ?? 'test-channel'
    headers['x-clerum-edge-sender'] = ctx.sender ?? 'test-user'
  }

  return headers
}

function defaultEdgeForRuntimeUrl(url: string, method = 'GET'): McpHostEdgeContext | undefined {
  if (!url.startsWith(MCP_HOST_URL)) return undefined

  const path = url.slice(MCP_HOST_URL.replace(/\/+$/, '').length)
  if (
    path.startsWith('/v1/runtime/health') ||
    path.startsWith('/v1/runtime/live') ||
    path === '/metrics'
  ) {
    return undefined
  }

  if (
    method === 'GET' &&
    (path.startsWith('/v1/runtime/status') ||
      path.startsWith('/v1/runtime/activity') ||
      path.startsWith('/v1/runtime/sessions'))
  ) {
    return { caller: 'rpc-proxy' }
  }

  return { caller: 'channel-reader' }
}

/**
 * Direct port-forwarded mcp-host runtime routes require edge caller headers.
 * Bearer JWTs are rejected on these paths (see edgeRuntimeAuth.ts).
 */
function withMcpHostRuntime(
  url: string,
  opts?: RequestInit,
  edge?: McpHostEdgeContext
): RequestInit | undefined {
  const method = opts?.method ?? 'GET'
  const resolvedEdge = edge ?? defaultEdgeForRuntimeUrl(url, method)
  if (!resolvedEdge) return opts

  const headers = new Headers(opts?.headers)
  for (const [name, value] of Object.entries(mcpHostEdgeHeaders(resolvedEdge))) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return { ...opts, headers }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Simple fetch wrapper that returns status + parsed JSON body. */
export async function fetchJson(
  url: string,
  opts?: RequestInit,
  edge?: McpHostEdgeContext
): Promise<{ status: number; data: any }> {
  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, withMcpHostRuntime(url, opts, edge))
      const text = await res.text()
      let data: any
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
      return { status: res.status, data }
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt)
      }
    }
  }

  throw lastError
}

/** Send a message to mcp-host POST /v1/runtime/messages. */
export async function sendMessage(
  content: string,
  opts?: {
    hostRef?: string
    channelId?: string
    userId?: string
    channelType?: string
  }
): Promise<{ status: number; data: any }> {
  const sender = opts?.userId ?? 'test-user'
  const hostRef = opts?.hostRef ?? DEFAULT_HOST_REF
  const channelId = opts?.channelId ?? 'test-channel'
  const channelType = opts?.channelType ?? 'telegram'
  return fetchJson(
    `${MCP_HOST_URL}/v1/runtime/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        hostRef,
        channelId,
        sender,
        channelType,
        timestamp: new Date().toISOString(),
        messageId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    },
    {
      caller: 'channel-reader',
      hostRef,
      channelType,
      channelId,
      sender,
    }
  )
}

/** GET mcp-host /v1/runtime/status. */
export async function getStatus(): Promise<any> {
  const { data } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/status`)
  return data
}

/** GET service health, using mcp-host's runtime path only for mcp-host. */
export async function healthCheck(url: string = MCP_HOST_URL, path?: string): Promise<boolean> {
  try {
    const healthPath = path ?? (url.startsWith(MCP_HOST_URL) ? '/v1/runtime/health' : '/health')
    const normalizedPath = healthPath.startsWith('/') ? healthPath : `/${healthPath}`
    const { status } = await fetchJson(`${url.replace(/\/+$/, '')}${normalizedPath}`)
    return status === 200
  } catch {
    return false
  }
}

/** Poll mcp-host /v1/runtime/status until agent is idle or timeout. */
export async function waitForIdle(timeoutMs = 30_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus()
    if (status.agent?.state === 'idle') return status
    await sleep(500)
  }
  throw new Error('Agent did not return to idle within timeout')
}

/** Wait for agent to process at least N total tasks. */
export async function waitForTasksProcessed(minCount: number, timeoutMs = 60_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus()
    if ((status.agent?.tasksProcessed ?? 0) >= minCount) return status
    await sleep(1000)
  }
  throw new Error(`Agent did not process ${minCount} tasks within ${timeoutMs}ms`)
}

/** Query the temporary PR 2 global-inventory compatibility route. */
export async function getGlobalMcpInventory(): Promise<any> {
  const { data } = await fetchJson(`${CTX_MAPPER_URL}/api/v1/mcpservers`)
  return data
}

/** Run a kubectl command and return stdout. */
export function kubectl(args: string): string {
  return execSync(`kubectl --context=${shellQuote(KUBE_CONTEXT)} ${args}`, {
    encoding: 'utf-8',
  }).trim()
}

export function resolveMcpHostDeployment(): string {
  if (cachedMcpHostDeployment) return cachedMcpHostDeployment

  const configured = process.env.E2E_MCP_HOST_DEPLOYMENT
    ? [process.env.E2E_MCP_HOST_DEPLOYMENT]
    : []
  const candidates = [...configured, 'chatllm', 'mcp-host']

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      kubectl(`get deployment ${candidate} -n ${MCP_HOST_NAMESPACE} -o name`)
      cachedMcpHostDeployment = candidate
      return candidate
    } catch {
      // Try the next supported deployment name.
    }
  }

  throw new Error(`No mcp-host runtime deployment found in namespace ${MCP_HOST_NAMESPACE}`)
}

export function mcpHostExec(command: string): string {
  const deployment = resolveMcpHostDeployment()
  return kubectl(
    `exec -n ${MCP_HOST_NAMESPACE} deploy/${deployment} -- sh -c ${shellQuote(command)}`
  )
}

/** Get pod logs (last N lines). */
export function getPodLogs(deployment: string, namespace: string, tail = 50): string {
  if (namespace === MCP_HOST_NAMESPACE && deployment === 'mcp-host') {
    deployment = resolveMcpHostDeployment()
  }
  return kubectl(`logs deploy/${deployment} -n ${namespace} --tail=${tail}`)
}

/** POST /v1/runtime/approvals/approve to mcp-host. */
export async function approveRequest(
  userId: string,
  requestId: string,
  alwaysApprove = false
): Promise<{ status: number; data: any }> {
  const channelId = 'test-channel'
  const channelType = 'telegram'
  return fetchJson(
    `${MCP_HOST_URL}/v1/runtime/approvals/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, requestId, alwaysApprove, channelType, channelId }),
    },
    {
      caller: 'channel-reader',
      sender: userId,
      channelType,
      channelId,
    }
  )
}

/** POST /v1/runtime/approvals/deny to mcp-host. */
export async function denyRequest(
  userId: string,
  requestId: string
): Promise<{ status: number; data: any }> {
  const channelId = 'test-channel'
  const channelType = 'telegram'
  return fetchJson(
    `${MCP_HOST_URL}/v1/runtime/approvals/deny`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, requestId, channelType, channelId }),
    },
    {
      caller: 'channel-reader',
      sender: userId,
      channelType,
      channelId,
    }
  )
}

/** Poll mcp-host /v1/runtime/status until agent reaches targetState or timeout. */
export async function waitForAgentState(targetState: string, timeoutMs = 30_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus()
    if (status.agent?.state === targetState) return status
    await sleep(500)
  }
  throw new Error(`Agent did not reach state "${targetState}" within ${timeoutMs}ms`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Poll GET /v1/runtime/tasks/:id/result until the task has completed or timeout. */
export async function getTaskResult(
  taskId: string,
  timeoutMs = 60_000
): Promise<{ status: number; data: any }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/result`)
    if (res.data?.status === 'completed' || res.data?.response) {
      return res
    }
    await sleep(1000)
  }
  // Return last result even if not completed
  return fetchJson(`${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/result`)
}

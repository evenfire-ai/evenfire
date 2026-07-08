import type {
  WorkflowApprovalNotificationClaim,
  WorkflowApprovalNotificationDelivery,
  WorkflowApprovalNotificationTerminal,
} from '../server/types'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

export type WorkflowApprovalNotificationClaimResult =
  | { deliveries: WorkflowApprovalNotificationDelivery[] }
  | { error: string }

export type WorkflowApprovalNotificationTerminalResult = { ok: boolean; error?: string }

function workflowControlCredential(auth: McpHostRuntimeAuth): string {
  const value = auth.mcpHostControlToken?.trim()
  if (!value) throw new Error('workflow control credential is required')
  return value
}

function headers(auth: McpHostRuntimeAuth): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${workflowControlCredential(auth)}`,
  }
}

function claimUrl(auth: McpHostRuntimeAuth, input: WorkflowApprovalNotificationClaim): string {
  const url = new URL('/api/v1/workflow-approval-notifications/deliveries', auth.baseUrl)
  url.searchParams.set('medium', input.medium)
  url.searchParams.set('limit', String(input.limit))
  for (const channelId of input.providerChannelIds) {
    url.searchParams.append('providerChannelId', channelId)
  }
  if (input.providerWorkspaceId) {
    url.searchParams.set('providerWorkspaceId', input.providerWorkspaceId)
  }
  return url.toString()
}

async function claimOnce(
  input: WorkflowApprovalNotificationClaim,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(claimUrl(auth, input), {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: headers(auth),
  })
}

export async function claimProviderWorkflowApprovalNotifications(
  input: WorkflowApprovalNotificationClaim,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<WorkflowApprovalNotificationClaimResult> {
  if (!auth) return { error: 'MCP host runtime auth is not configured' }

  let res = await claimOnce(input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await claimOnce(input, auth, fetchImpl)
  }

  const text = await res.text().catch(() => '')
  let body: { deliveries?: WorkflowApprovalNotificationDelivery[]; error?: string } = {}
  try {
    body = text ? (JSON.parse(text) as typeof body) : body
  } catch {
    body = {}
  }
  if (!res.ok) {
    return { error: body.error ?? `workflow approval notification claim rejected (${res.status})` }
  }
  return { deliveries: Array.isArray(body.deliveries) ? body.deliveries : [] }
}

async function terminalOnce(
  id: string,
  action: 'ack' | 'fail',
  input: WorkflowApprovalNotificationTerminal,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(
    `${auth.baseUrl}/api/v1/workflow-approval-notifications/deliveries/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: headers(auth),
      body: JSON.stringify(input),
    }
  )
}

export async function recordProviderWorkflowApprovalNotificationTerminal(
  id: string,
  action: 'ack' | 'fail',
  input: WorkflowApprovalNotificationTerminal,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<WorkflowApprovalNotificationTerminalResult> {
  if (!auth) return { ok: false, error: 'MCP host runtime auth is not configured' }

  let res = await terminalOnce(id, action, input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await terminalOnce(id, action, input, auth, fetchImpl)
  }
  if (res.status === 204 || res.status === 404) return { ok: true }

  const text = await res.text().catch(() => '')
  let body: { error?: string } = {}
  try {
    body = text ? (JSON.parse(text) as typeof body) : body
  } catch {
    body = {}
  }
  return {
    ok: false,
    error: body.error ?? `workflow approval notification ${action} rejected (${res.status})`,
  }
}

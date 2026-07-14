import type { ProviderDecisionIdentity } from '../server/types'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

export interface ProviderWorkflowApprovalDecisionInput {
  approvalRequestId: string
  decision: 'approve' | 'deny'
  providerIdentity: ProviderDecisionIdentity
  note?: string | null
}

export interface ProviderWorkflowApprovalDecisionResult {
  success: boolean
  duplicate?: boolean
  status?: string
  run?: Record<string, unknown> | null
  error?: string
}

function controlToken(auth: McpHostRuntimeAuth): string {
  const token = auth.mcpHostControlToken?.trim()
  if (!token) {
    throw new Error('MCP_HOST_WORKFLOW_CONTROL_TOKEN is required for provider workflow approvals')
  }
  return token
}

async function submitOnce(
  input: ProviderWorkflowApprovalDecisionInput,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(
    `${auth.baseUrl}/api/v1/workflow-approvals/${encodeURIComponent(input.approvalRequestId)}/provider-decision`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${controlToken(auth)}`,
      },
      body: JSON.stringify({
        decision: input.decision,
        providerIdentity: input.providerIdentity,
        ...(input.note ? { note: input.note } : {}),
      }),
    }
  )
}

export async function submitProviderWorkflowApprovalDecision(
  input: ProviderWorkflowApprovalDecisionInput,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderWorkflowApprovalDecisionResult> {
  if (!auth) {
    return {
      success: false,
      error: 'MCP host runtime auth is not configured',
    }
  }

  let res = await submitOnce(input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await submitOnce(input, auth, fetchImpl)
  }

  const text = await res.text().catch(() => '')
  let body: ProviderWorkflowApprovalDecisionResult = { success: false }
  try {
    body = text ? (JSON.parse(text) as ProviderWorkflowApprovalDecisionResult) : body
  } catch {
    body = { success: false }
  }
  if (!res.ok) {
    return {
      success: false,
      error: body.error ?? `provider decision rejected (${res.status})`,
    }
  }
  return body
}

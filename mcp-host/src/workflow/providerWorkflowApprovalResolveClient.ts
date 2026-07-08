import type { ProviderIdentity } from '../server/types'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

export interface ProviderWorkflowApprovalResolveInput {
  recipeName: string
  providerIdentity: ProviderIdentity
}

export type ProviderWorkflowApprovalResolveResult =
  | { status: 'found'; approvalRequestId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  | { status: 'error'; error: string }

function workflowControlCredential(auth: McpHostRuntimeAuth): string {
  const value = auth.mcpHostControlToken?.trim()
  if (!value) throw new Error('workflow control credential is required')
  return value
}

async function resolveOnce(
  input: ProviderWorkflowApprovalResolveInput,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(`${auth.baseUrl}/api/v1/workflow-approvals/pending/resolve`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workflowControlCredential(auth)}`,
    },
    body: JSON.stringify({
      recipeName: input.recipeName,
      providerIdentity: input.providerIdentity,
    }),
  })
}

export async function resolvePendingProviderWorkflowApproval(
  input: ProviderWorkflowApprovalResolveInput,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderWorkflowApprovalResolveResult> {
  if (!auth) {
    return {
      status: 'error',
      error: 'MCP host runtime auth is not configured',
    }
  }

  let res = await resolveOnce(input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await resolveOnce(input, auth, fetchImpl)
  }

  const text = await res.text().catch(() => '')
  let body: { approvalRequestId?: unknown; error?: unknown } = {}
  try {
    body = text ? (JSON.parse(text) as typeof body) : body
  } catch {
    body = {}
  }

  if (res.status === 404) return { status: 'not_found' }
  if (res.status === 409) return { status: 'ambiguous' }
  if (!res.ok) {
    return {
      status: 'error',
      error:
        typeof body.error === 'string'
          ? body.error
          : `pending workflow approval resolve rejected (${res.status})`,
    }
  }

  return typeof body.approvalRequestId === 'string' && body.approvalRequestId.trim()
    ? { status: 'found', approvalRequestId: body.approvalRequestId }
    : { status: 'not_found' }
}

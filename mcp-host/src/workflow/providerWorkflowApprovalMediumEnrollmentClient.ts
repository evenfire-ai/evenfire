import type { WorkflowApprovalMediumEnrollment } from '../server/types'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

export type WorkflowApprovalMediumEnrollmentResult =
  | { ok: true; account?: unknown }
  | { ok: false; error: string }

function workflowControlCredential(auth: McpHostRuntimeAuth): string {
  const value = auth.mcpHostControlToken?.trim()
  if (!value) throw new Error('workflow control credential is required')
  return value
}

async function confirmOnce(
  input: WorkflowApprovalMediumEnrollment,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(`${auth.baseUrl}/api/v1/workflow-approval-mediums/link-sessions/confirm`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workflowControlCredential(auth)}`,
    },
    body: JSON.stringify(input),
  })
}

export async function confirmProviderWorkflowApprovalMediumEnrollment(
  input: WorkflowApprovalMediumEnrollment,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<WorkflowApprovalMediumEnrollmentResult> {
  if (!auth) return { ok: false, error: 'MCP host runtime auth is not configured' }

  let res = await confirmOnce(input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await confirmOnce(input, auth, fetchImpl)
  }

  const text = await res.text().catch(() => '')
  let body: WorkflowApprovalMediumEnrollmentResult = { ok: false, error: 'unknown_error' }
  try {
    body = text ? (JSON.parse(text) as WorkflowApprovalMediumEnrollmentResult) : body
  } catch {
    body = { ok: false, error: 'invalid_response' }
  }
  if (res.ok && body.ok) return body
  return {
    ok: false,
    error:
      !body.ok && body.error ? body.error : `workflow approval enrollment rejected (${res.status})`,
  }
}

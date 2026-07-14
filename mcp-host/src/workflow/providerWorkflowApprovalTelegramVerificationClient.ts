import type { TelegramWorkflowApprovalVerification } from '../server/types'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

export type TelegramWorkflowApprovalVerificationResult =
  | { ok: true; accountId: string }
  | { ok: false; error: string }

function workflowControlCredential(auth: McpHostRuntimeAuth): string {
  const value = auth.mcpHostControlToken?.trim()
  if (!value) throw new Error('workflow control credential is required')
  return value
}

async function confirmOnce(
  input: TelegramWorkflowApprovalVerification,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(
    `${auth.baseUrl}/api/v1/workflow-approval-mediums/telegram/challenges/confirm-provider-event`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workflowControlCredential(auth)}`,
      },
      body: JSON.stringify(input),
    }
  )
}

export async function confirmProviderWorkflowApprovalTelegramVerification(
  input: TelegramWorkflowApprovalVerification,
  auth: McpHostRuntimeAuth | null,
  fetchImpl: typeof fetch = fetch
): Promise<TelegramWorkflowApprovalVerificationResult> {
  if (!auth) return { ok: false, error: 'MCP host runtime auth is not configured' }

  let res = await confirmOnce(input, auth, fetchImpl)
  if (res.status === 401) {
    await refreshWithRecovery(auth)
    res = await confirmOnce(input, auth, fetchImpl)
  }

  const text = await res.text().catch(() => '')
  let body: TelegramWorkflowApprovalVerificationResult = { ok: false, error: 'unknown_error' }
  try {
    body = text ? (JSON.parse(text) as TelegramWorkflowApprovalVerificationResult) : body
  } catch {
    body = { ok: false, error: 'invalid_response' }
  }
  if (res.ok && body.ok) return body
  return {
    ok: false,
    error: !body.ok && body.error ? body.error : `telegram verification rejected (${res.status})`,
  }
}

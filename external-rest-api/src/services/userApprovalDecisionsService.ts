import { controlApiRequest } from '../controlApiClient.js'

export type PendingUserApprovalDecision = {
  id: string
  recipeNamespace: string
  recipeName: string
  requestedAt: string
  expiresAt: string
  payload: {
    message: string
    options?: string[]
    metadata?: unknown
  }
  correlation: {
    taskId?: string
    stepId?: string
  } | null
  target: {
    userId: string | null
    teamId: string | null
    teamName: string | null
  }
}

export async function listPendingUserApprovalDecisions(
  sessionToken: string,
  limit = 20
): Promise<{ items: PendingUserApprovalDecision[] }> {
  return controlApiRequest('GET', '/external/workflow-approvals/pending', {
    userSessionToken: sessionToken,
    query: { limit: String(limit) },
  })
}

export async function decideUserApprovalDecision(
  sessionToken: string,
  approvalId: string,
  decision: 'approve' | 'deny',
  note?: string
): Promise<{ ok: boolean }> {
  return controlApiRequest(
    'POST',
    `/external/workflow-approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      userSessionToken: sessionToken,
      body: note ? { decision, note } : { decision },
    }
  )
}

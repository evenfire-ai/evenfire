import { apiGet, apiSend } from './api'

export type WorkflowApprovalMediumAccount = {
  id: string
  userId: string
  medium: 'telegram' | 'slack'
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  isPreferred?: boolean
}

export async function getAdminUserWorkflowApprovalMediums(userId: string) {
  return apiGet(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/workflow-approval-mediums`
  ) as Promise<{ items?: WorkflowApprovalMediumAccount[] }>
}

export async function preferAdminUserWorkflowApprovalMedium(userId: string, accountId: string) {
  return apiSend(
    'PUT',
    `/api/v1/admin/users/${encodeURIComponent(userId)}/workflow-approval-mediums/${encodeURIComponent(accountId)}/preference`,
    {}
  ) as Promise<{ ok: true; account: WorkflowApprovalMediumAccount }>
}

export async function revokeAdminUserWorkflowApprovalMedium(userId: string, accountId: string) {
  return apiSend(
    'DELETE',
    `/api/v1/admin/users/${encodeURIComponent(userId)}/workflow-approval-mediums/${encodeURIComponent(accountId)}`,
    {}
  ) as Promise<void>
}

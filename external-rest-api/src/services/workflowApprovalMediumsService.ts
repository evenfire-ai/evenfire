import { controlApiRequest, controlApiRequestWithStatus } from '../controlApiClient.js'

export type WorkflowApprovalMedium = 'telegram' | 'slack' | 'teams' | 'discord'

export type WorkflowApprovalMediumAccount = {
  id: string
  userId: string
  medium: WorkflowApprovalMedium
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  communicationChannelRef?: string | null
  displayName?: string | null
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerChannelHandle?: string | null
  disabledAt: string | null
  isPreferred?: boolean
  targets?: ApprovalChannelTarget[]
}

export type ApprovalChannelTarget = {
  id: string
  medium: 'telegram' | 'slack' | 'teams'
  agentName: string
  channelName: string
  channelNamespace: string
  botLabel: string
  botUsername: string | null
  botDeepLink: string | null
  providerWorkspaceId?: string | null
  status: 'ready'
}

export type CreateWorkflowApprovalMediumChallengeInput = {
  medium: string
  providerUserId?: string
  providerWorkspaceId?: string | null
  providerChannelId?: string | null
  targetId?: string
}

export async function createWorkflowApprovalMediumChallenge(
  sessionToken: string,
  input: CreateWorkflowApprovalMediumChallengeInput
): Promise<{
  challengeId: string
  expiresAt: string
  code?: string
  delivery: { channel: string }
  target?: ApprovalChannelTarget
}> {
  return controlApiRequest('POST', '/external/workflow-approval-mediums/challenges', {
    userSessionToken: sessionToken,
    body: input,
  })
}

export async function listApprovalChannelTargets(
  sessionToken: string
): Promise<{ items: ApprovalChannelTarget[] }> {
  return controlApiRequest('GET', '/external/workflow-approval-mediums/targets', {
    userSessionToken: sessionToken,
  })
}

export async function createWorkflowApprovalMediumLinkSession(
  sessionToken: string,
  input: { medium: string; providerWorkspaceId?: string | null; targetId?: string | null }
): Promise<{
  linkSessionId: string
  nonce: string
  expiresAt: string
  deepLinkUrl: string | null
  target?: ApprovalChannelTarget
}> {
  return controlApiRequest('POST', '/external/workflow-approval-mediums/link-sessions', {
    userSessionToken: sessionToken,
    body: input,
  })
}

export async function confirmWorkflowApprovalMediumChallenge(
  sessionToken: string,
  challengeId: string,
  code: string
): Promise<{ ok: true; accountId: string }> {
  return controlApiRequest(
    'POST',
    `/external/workflow-approval-mediums/challenges/${encodeURIComponent(challengeId)}/confirm`,
    {
      userSessionToken: sessionToken,
      body: { code },
    }
  )
}

export async function listWorkflowApprovalMediums(
  sessionToken: string,
  options: { includeDisabled?: boolean } = {}
): Promise<{ items: WorkflowApprovalMediumAccount[] }> {
  return controlApiRequest('GET', '/external/workflow-approval-mediums', {
    userSessionToken: sessionToken,
    query: {
      includeDisabled: options.includeDisabled ? 'true' : undefined,
    },
  })
}

export async function disableWorkflowApprovalMedium(
  sessionToken: string,
  accountId: string
): Promise<void> {
  await controlApiRequestWithStatus<null>(
    'DELETE',
    `/external/workflow-approval-mediums/${encodeURIComponent(accountId)}`,
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function preferWorkflowApprovalMedium(
  sessionToken: string,
  accountId: string
): Promise<{ ok: true; account: WorkflowApprovalMediumAccount }> {
  return controlApiRequest(
    'PUT',
    `/external/workflow-approval-mediums/${encodeURIComponent(accountId)}/preference`,
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function updateWorkflowApprovalMediumDisplayName(
  sessionToken: string,
  accountId: string,
  displayName: string | null
): Promise<{ ok: true; account: WorkflowApprovalMediumAccount }> {
  return controlApiRequest(
    'PATCH',
    `/external/workflow-approval-mediums/${encodeURIComponent(accountId)}/display-name`,
    {
      userSessionToken: sessionToken,
      body: { displayName },
    }
  )
}

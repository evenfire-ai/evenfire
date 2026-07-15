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
  replyOnlyWhenMentioned?: boolean
  status: 'ready'
}

export type WorkflowApprovalMediumAccount = {
  id: string
  userId: string
  medium: 'telegram' | 'slack' | 'teams' | 'discord'
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  displayName?: string | null
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerChannelHandle?: string | null
  communicationChannelRef?: string | null
  disabledAt?: string | null
  targets?: ApprovalChannelTarget[]
}

export type WorkflowApprovalMediumChallenge = {
  challengeId: string
  expiresAt: string
  code?: string
  delivery: {
    channel: string
  }
  target?: ApprovalChannelTarget
}

export type WorkflowApprovalMediumLinkSession = {
  linkSessionId: string
  nonce: string
  expiresAt: string
  deepLinkUrl: string | null
  target?: ApprovalChannelTarget
}

export type CreateWorkflowApprovalMediumChallengeInput =
  | {
      medium: 'telegram'
      targetId: string
    }
  | {
      medium: string
      providerUserId: string
      providerWorkspaceId?: string | null
      providerChannelId?: string | null
    }

export type CreateWorkflowApprovalMediumLinkSessionInput = {
  medium: 'slack' | 'teams'
  targetId: string
  providerWorkspaceId?: string | null
  replyInThreads?: boolean
}

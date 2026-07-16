import type { Message, ProviderIdentity } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOT_USERNAME_RE = /^[a-z0-9_]{3,64}$/i
const WORKFLOW_DECISION_RE =
  /^[\\/](?<decision>approve|deny)(?:@(?<botUsername>[a-z0-9_]{3,64}))?\s+(?<target>[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i

export type WorkflowApprovalDecisionCommand = {
  recipeName: string
  decision: 'approve' | 'deny'
  providerIdentity: ProviderIdentity
  note?: string | null
}

export type WorkflowApprovalDecisionCallbackCommand = {
  approvalRequestId: string
  decision: 'approve' | 'deny'
  providerIdentity: ProviderIdentity
  note?: string | null
}

function rawString(raw: Record<string, unknown> | undefined, key: string): string | null {
  const value = raw?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeBotUsername(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^@/, '').toLowerCase()
  return normalized && BOT_USERNAME_RE.test(normalized) ? normalized : null
}

export function contentWithoutAddressedBotMention(message: Message): string {
  let content = message.content.trim()
  if (!content) return content

  const botUsername = normalizeBotUsername(
    message.providerIdentity?.providerTarget?.providerBotUsername
  )
  if (!botUsername) return content

  const mentionMatch = /^@([a-z0-9_]{3,64})\s+/i.exec(content)
  if (mentionMatch?.[1]?.toLowerCase() === botUsername) {
    content = content.slice(mentionMatch[0].length).trim()
  }

  return content
}

function workflowApprovalRequestIdFromCallback(message: Message): string | null {
  const value = rawString(message.rawData, 'telegramCallbackApprovalRequestId')
  return value && UUID_RE.test(value) ? value : null
}

function workflowApprovalDecisionFromCallback(message: Message): 'approve' | 'deny' | null {
  const value = rawString(message.rawData, 'telegramCallbackDecision')?.toLowerCase()
  return value === 'approve' || value === 'deny' ? value : null
}

export function providerIdentityFromMessage(message: Message): ProviderIdentity | null {
  if (message.providerIdentity) return message.providerIdentity

  if (message.channelType === 'telegram') {
    return {
      medium: 'telegram',
      providerUserId: message.sender,
      providerWorkspaceId: null,
      providerChannelId: message.channelId,
      providerEventId: `telegram:${message.channelId}:${message.messageId}`,
    }
  }

  if (message.channelType === 'slack') {
    const providerUserId = rawString(message.rawData, 'user') ?? message.sender
    const providerWorkspaceId =
      rawString(message.rawData, 'team') ?? rawString(message.rawData, 'team_id')
    if (!providerWorkspaceId) return null
    return {
      medium: 'slack',
      providerUserId,
      providerWorkspaceId,
      providerChannelId: message.channelId,
      providerEventId: `slack:${providerWorkspaceId}:${message.channelId}:${message.messageId}`,
    }
  }

  if (message.channelType === 'teams') {
    const providerUserId = rawString(message.rawData, 'fromId') ?? message.sender
    const providerWorkspaceId =
      rawString(message.rawData, 'tenantId') ?? rawString(message.rawData, 'providerWorkspaceId')
    if (!providerWorkspaceId) return null
    return {
      medium: 'teams',
      providerUserId,
      providerWorkspaceId,
      providerChannelId: message.channelId,
      providerEventId: `teams:${providerWorkspaceId}:${message.channelId}:${message.messageId}`,
    }
  }

  return null
}

export function parseWorkflowApprovalDecisionCommand(
  message: Message
): WorkflowApprovalDecisionCommand | null {
  const match = WORKFLOW_DECISION_RE.exec(contentWithoutAddressedBotMention(message))
  if (!match?.groups) return null
  const commandBotUsername = normalizeBotUsername(match.groups.botUsername)
  const expectedBotUsername = normalizeBotUsername(
    message.providerIdentity?.providerTarget?.providerBotUsername
  )
  if (commandBotUsername && (!expectedBotUsername || commandBotUsername !== expectedBotUsername)) {
    return null
  }
  const target = match.groups.target.trim()
  if (target.toLowerCase() === 'always' || UUID_RE.test(target)) return null

  const identity = providerIdentityFromMessage(message)
  if (!identity) return null

  const decision: 'approve' | 'deny' =
    match.groups.decision.toLowerCase() === 'approve' ? 'approve' : 'deny'
  const base = {
    decision,
    providerIdentity: identity,
  }
  return { ...base, recipeName: target }
}

export function parseWorkflowApprovalDecisionCallback(
  message: Message
): WorkflowApprovalDecisionCallbackCommand | null {
  const approvalRequestId = workflowApprovalRequestIdFromCallback(message)
  const decision = workflowApprovalDecisionFromCallback(message)
  if (!approvalRequestId || !decision) return null

  const identity = providerIdentityFromMessage(message)
  if (!identity) return null

  return { approvalRequestId, decision, providerIdentity: identity }
}

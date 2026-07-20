import { createHash } from 'node:crypto'
import { WorkflowBrokerClient } from '../core/tools/workflowBrokerClient'
import {
  type EnvGetter,
  type WorkflowCallerContext,
  defaultEnv,
} from '../core/tools/workflowShared'
import { createWorkflowControlTokenProvider } from '../core/tools/workflowTokenProvider'
import type { TraceContextV1 } from '../core/types'
import type { IncomingMessage } from '../server'

const CONVERSATION_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/

function conversationIdForMessage(message: IncomingMessage): string {
  if (message.channelType === 'teams' && message.channelId.trim()) {
    return message.channelId.trim()
  }

  const raw =
    typeof message.threadId === 'string' && message.threadId.trim()
      ? message.threadId.trim()
      : `${message.channelType}:${message.channelId}:${message.sender}`
  if (CONVERSATION_ID_RE.test(raw)) return raw
  return `provider-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`
}

function providerIdentityPayload(message: IncomingMessage): Record<string, unknown> | null {
  const identity = message.providerIdentity
  if (!identity) return null
  if (
    identity.medium !== 'telegram' &&
    identity.medium !== 'slack' &&
    identity.medium !== 'teams'
  ) {
    return null
  }
  if (!identity.providerUserId?.trim()) return null
  if (!identity.providerChannelId?.trim()) return null
  if (
    (identity.medium === 'slack' || identity.medium === 'teams') &&
    !identity.providerWorkspaceId?.trim()
  ) {
    return null
  }
  return {
    medium: identity.medium,
    providerUserId: identity.providerUserId,
    ...(identity.providerWorkspaceId ? { providerWorkspaceId: identity.providerWorkspaceId } : {}),
    providerChannelId: identity.providerChannelId,
    ...(identity.providerChannelType ? { providerChannelType: identity.providerChannelType } : {}),
    ...(identity.providerTarget ? { providerTarget: identity.providerTarget } : {}),
  }
}

export async function resolveProviderWorkflowCallerContext(
  message: IncomingMessage | undefined,
  getEnv: EnvGetter = defaultEnv,
  traceContext?: TraceContextV1 | null
): Promise<WorkflowCallerContext | null> {
  if (
    !message ||
    (message.channelType !== 'telegram' &&
      message.channelType !== 'slack' &&
      message.channelType !== 'teams')
  ) {
    return null
  }

  const providerIdentity = providerIdentityPayload(message)
  if (!providerIdentity) return null

  const client = new WorkflowBrokerClient(getEnv, createWorkflowControlTokenProvider(getEnv))
  const traceBinding =
    traceContext?.origin === 'channel_event' && traceContext.sessionId
      ? {
          runId: traceContext.runId,
          sessionId: traceContext.sessionId,
          origin: traceContext.origin,
        }
      : undefined
  const result = await client.request('/api/v1/workflow-approval-mediums/resolve', {
    method: 'POST',
    body: JSON.stringify({ providerIdentity, ...(traceBinding ? { traceBinding } : {}) }),
  })
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  const userId = typeof record.userId === 'string' ? record.userId.trim() : ''
  if (!userId) return null

  return {
    targetUserId: userId,
    conversationId: conversationIdForMessage(message),
    originChannelType: message.channelType,
    providerUserId: message.providerIdentity?.providerUserId,
    providerWorkspaceId: message.providerIdentity?.providerWorkspaceId ?? null,
    providerChannelId: message.providerIdentity?.providerChannelId,
    providerEventId: message.providerIdentity?.providerEventId,
    ...(message.threadId?.trim() ? { sourceThreadId: message.threadId.trim() } : {}),
    sourceMessageId: message.messageId,
    sourceMessageContent: message.content,
  }
}

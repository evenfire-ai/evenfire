import type { WorkflowCallerContext } from '../core/tools/workflowShared'
import type { Task } from '../queue/types'

/**
 * Provider conversation types that are a 1:1 conversation with the bot, keyed
 * by channel medium. Compared exactly: no trimming or case folding.
 */
export const PERSONAL_CONNECTOR_CONVERSATION_TYPES = {
  teams: 'personal',
  slack: 'im',
  telegram: 'private',
} as const

export type PrincipalDenial = 'unverified' | 'not_direct_message'

/** One-line channel copy shown when personal connectors are withheld. */
export const PRINCIPAL_DENIAL_COPY: Record<PrincipalDenial, string> = {
  unverified: "I couldn't verify your account just now; try again in a moment",
  not_direct_message: 'Personal connectors work in a direct message with me.',
}

type PersonalMedium = keyof typeof PERSONAL_CONNECTOR_CONVERSATION_TYPES

function isPersonalMedium(channelType: string): channelType is PersonalMedium {
  return Object.prototype.hasOwnProperty.call(PERSONAL_CONNECTOR_CONVERSATION_TYPES, channelType)
}

/**
 * Decide which Evenfire user a personal connector runs as. Returns at most one
 * of `userId` (run as this user) or `denial` (withhold personal connectors).
 */
export function chooseConnectorPrincipal(
  task: Task,
  callerContext: WorkflowCallerContext | null | undefined
): { userId?: string; denial?: PrincipalDenial } {
  const message = task.sourceMessage
  if (!message) return {}

  if (message.channelType === 'rpc') {
    return message.sender ? { userId: message.sender } : {}
  }

  if (!isPersonalMedium(message.channelType)) return {}

  const conversationType = message.providerIdentity?.providerChannelType
  if (conversationType !== PERSONAL_CONNECTOR_CONVERSATION_TYPES[message.channelType]) {
    return { denial: 'not_direct_message' }
  }

  const targetUserId = callerContext?.targetUserId
  if (!targetUserId) return { denial: 'unverified' }
  return { userId: targetUserId }
}

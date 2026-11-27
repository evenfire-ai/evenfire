import type { QueuedChatDelete } from '@contexts/AgentChatActionsContext'

export type ConversationActionsProps = {
  /** Agent identifier of the open conversation — the target of every action. */
  agentRef: string
  /** Identifier of the open conversation — the target of every action. */
  chatId: string
  /** Title as the breadcrumb shows it. */
  title: string
}

/** A deletion the user asked for, held until they confirm it. */
export type PendingConversationDelete = {
  chatId: string
  title: string
  deletion: QueuedChatDelete
}

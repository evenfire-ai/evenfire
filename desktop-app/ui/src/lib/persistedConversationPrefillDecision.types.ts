export type PersistedConversationPrefillDecision =
  | 'insert'
  | 'wait'
  | 'preserve-input'
  | 'reject-stale'

export interface PersistedConversationPrefillDecisionInput {
  eventId: number
  currentEventId: number
  authorityScope: string
  currentAuthorityScope: string
  agentRef: string
  currentAgentRef: string | null
  chatId: string
  currentChatId: string | null
  workspaceChatTabId: string
  currentWorkspaceChatTabId: string | null
  resourceUri: string
  currentResourceUri: string | null
  resourceOwnerId: string
  currentResourceOwnerId: string | null
  inputIsVisible: boolean
  inputText: string
  projectedDraft: string
  deletePending: boolean
}

import type {
  PersistedConversationPrefillDecision,
  PersistedConversationPrefillDecisionInput,
} from './persistedConversationPrefillDecision.types'

/** Pure current-owner predicate; all mutable facts remain owned by their stores/controllers. */
export function decidePersistedConversationPrefill(
  input: PersistedConversationPrefillDecisionInput
): PersistedConversationPrefillDecision {
  if (
    input.eventId !== input.currentEventId ||
    input.authorityScope !== input.currentAuthorityScope ||
    input.agentRef !== input.currentAgentRef ||
    input.chatId !== input.currentChatId ||
    input.workspaceChatTabId !== input.currentWorkspaceChatTabId
  ) {
    return 'reject-stale'
  }
  if (input.deletePending || !input.inputIsVisible) return 'wait'
  if (!input.currentResourceUri || !input.currentResourceOwnerId) return 'wait'
  if (
    input.resourceUri !== input.currentResourceUri ||
    input.resourceOwnerId !== input.currentResourceOwnerId
  ) {
    return 'reject-stale'
  }
  if (input.inputText !== '' || input.projectedDraft !== '') return 'preserve-input'
  return 'insert'
}

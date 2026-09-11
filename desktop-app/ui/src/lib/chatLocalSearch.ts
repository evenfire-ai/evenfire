import type { ChatMessageSemanticModel } from './chatMessageSemantics'
import { findChatSemanticMatches } from './chatMessageSemantics'

export type ChatLocalMatch = {
  messageId: string
  occurrence: number
}

export function chatMessageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`
}

export function findLoadedChatMessageMatches(
  models: readonly ChatMessageSemanticModel[],
  query: string
): ChatLocalMatch[] {
  return models.flatMap(model =>
    findChatSemanticMatches(model, query).map(match => ({
      messageId: match.messageId,
      occurrence: match.occurrence,
    }))
  )
}

export function wrapMatchIndex(index: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0
  return (index + delta + total) % total
}

import type { AgentChatMessage } from '../uiTypes'
import { parseChatMessageDisplay } from './chatMessageAttachments'

export type ChatLocalMatch = {
  messageId: string
  occurrence: number
}

export function chatMessageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`
}

export function findLoadedChatMessageMatches(
  messages: AgentChatMessage[],
  query: string
): ChatLocalMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const matches: ChatLocalMatch[] = []
  for (const message of messages) {
    const displayed =
      message.role === 'user'
        ? (parseChatMessageDisplay(message.content)?.content ?? message.content)
        : message.content
    const haystack = displayed.toLocaleLowerCase()
    let offset = 0
    let occurrence = 0
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset)
      if (index < 0) break
      matches.push({ messageId: message.id, occurrence })
      occurrence += 1
      offset = index + Math.max(1, needle.length)
    }
  }
  return matches
}

export function wrapMatchIndex(index: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0
  return (index + delta + total) % total
}

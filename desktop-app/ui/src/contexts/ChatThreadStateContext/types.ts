import type { ReactNode } from 'react'
import type { ChatLocalMatch } from '../../lib/chatLocalSearch'
import type { AgentChatMessage, AgentMessageActivity, TaskProgress } from '../../uiTypes'

/**
 * The conversation transcript plus the per-message streaming maps (the hot path:
 * activity/progress fire on every SSE event). ChatThread is the sole consumer, so
 * isolating this here keeps the streaming storm from re-rendering the composer,
 * sidebar, workspace and fleet board.
 */
export interface ChatThreadStateContextValue {
  activeChatId: string | null
  activeMessages: AgentChatMessage[]
  groupedMessages: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }>
  chatMessagesLoading: boolean
  hasOlderMessages: boolean
  olderMessagesLoading: boolean
  handleLoadOlderMessages: () => Promise<void>
  activityByMessageId: Record<string, AgentMessageActivity>
  progressByMessageId: Record<string, TaskProgress>
  localSearchQuery: string
  localSearchCurrentMatch: ChatLocalMatch | null
}

export interface ChatThreadStateProviderProps {
  value: ChatThreadStateContextValue
  children: ReactNode
}

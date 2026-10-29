import type { ReactNode } from 'react'
import type { ModelStepCheckpointView } from '../../../../src/types'
import type { ChatLocalMatch } from '../../lib/chatLocalSearch'
import type { ChatMessageSemanticModel } from '../../lib/chatMessageSemantics'
import type {
  AgentChatMessage,
  AgentMessageActivity,
  ModelStepRetryState,
  TaskProgress,
} from '../../uiTypes'

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
  semanticModelsByMessageId: ReadonlyMap<string, ChatMessageSemanticModel>
  /** #1044 — the active chat's model-step checkpoint (`null` when the Host reports none). */
  modelStepCheckpoint: ModelStepCheckpointView | null
  /** #1044 — the active chat's **Retry model step** request state. */
  modelStepRetry: ModelStepRetryState | null
}

export interface ChatThreadStateProviderProps {
  value: ChatThreadStateContextValue
  children: ReactNode
}

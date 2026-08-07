import type { ReactNode } from 'react'
import type {
  LatestSidebarChatEntry,
  SessionStateLite,
  SidebarChatEntry,
} from '../../hooks/domain/useAgentChatController'

/**
 * Chat-list / sidebar / session-lifecycle state. Read by AgentWorkspace and
 * SidebarNav. None of these are part of the streaming hot path, so consumers here
 * don't re-render on per-token progress/activity updates.
 */
export interface ChatListContextValue {
  activeChatId: string | null
  chatList: SidebarChatEntry[]
  chatListLoading: boolean
  chatListMoreLoading?: boolean
  chatListHasMoreRemoteSessions?: boolean
  latestChatSessions: LatestSidebarChatEntry[]
  latestChatSessionsLoading: boolean
  loadMoreChatSessions?: () => Promise<void>
  /** Per-chat session lifecycle, keyed by chatId. Drives D.5 badges/banners. */
  sessionStateByChatId: Record<string, SessionStateLite>
  /**
   * Cross-agent per-chat session lifecycle, keyed by `makeTaskKey(agentRef, chatId)`.
   * The sidebar's latest-sessions list spans agents, so it can't use the
   * selected-agent-only `sessionStateByChatId` map.
   */
  sessionStateByChatKey: Record<string, SessionStateLite>
}

export interface ChatListProviderProps {
  value: ChatListContextValue
  children: ReactNode
}

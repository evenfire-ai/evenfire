import type { LatestSidebarChatEntry, SidebarChatEntry } from '@hooks/domain/useAgentChatController'

/** Title shown for an open conversation that no chat list has described yet. */
export const UNKNOWN_CONVERSATION_TITLE = 'Conversation'

/**
 * The entry of the conversation that is currently open.
 *
 * The selected agent's own chat list is the primary source. A session that list
 * has not described yet — a server-only chat opened from the sidebar, before its
 * page loads — is still present in the cross-agent "latest sessions" list, so
 * that list is the fallback, scoped to the agent.
 *
 * Returns `undefined` when no list describes the chat. Callers that render a
 * name use `openConversationTitle`; callers that persist one keep `undefined`.
 */
export function findConversationEntry(
  chatList: readonly SidebarChatEntry[],
  latestChatSessions: readonly LatestSidebarChatEntry[],
  agentRef: string | null,
  chatId: string | null
): SidebarChatEntry | undefined {
  if (!chatId) return undefined
  const listed = chatList.find(chat => chat.id === chatId)
  if (listed) return listed
  if (!agentRef) return undefined
  return latestChatSessions.find(chat => chat.agentRef === agentRef && chat.id === chatId)
}

/** Title to display for the open conversation. */
export function openConversationTitle(
  chatList: readonly SidebarChatEntry[],
  latestChatSessions: readonly LatestSidebarChatEntry[],
  agentRef: string | null,
  chatId: string | null
): string {
  const title = findConversationEntry(chatList, latestChatSessions, agentRef, chatId)?.title.trim()
  return title || UNKNOWN_CONVERSATION_TITLE
}

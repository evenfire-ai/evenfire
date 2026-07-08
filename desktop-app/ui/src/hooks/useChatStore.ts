import { useCallback } from 'react'
import type { ChatMessage } from '../../../src/types'

// The session lifecycle types live in the shared `src/types` (they cross the
// IPC bridge from the server). Re-exported here so existing UI imports from
// `useChatStore` keep working. The `window.clerum` shape is declared canonically
// in `desktop-app/src/renderer.d.ts` (chat + rpc session methods included).
export type {
  ContextBreakdownLite,
  ContextBreakdownResult,
  PendingApprovalLite,
  SessionLifecycleState,
  SessionTokensLite,
} from '../../../src/types'

/**
 * Hook providing typed access to the chat persistence IPC layer.
 * All methods are stable (useCallback) and safe to use in dependency arrays.
 */
export function useChatStore() {
  const listChats = useCallback((agentRef: string) => window.clerum.chat.list(agentRef), [])
  const createChat = useCallback(
    (agentRef: string, chatId: string) => window.clerum.chat.create(agentRef, chatId),
    []
  )
  const renameChat = useCallback(
    (agentRef: string, chatId: string, title: string) =>
      window.clerum.chat.rename(agentRef, chatId, title),
    []
  )
  const deleteChat = useCallback(
    (agentRef: string, chatId: string) => window.clerum.chat.delete(agentRef, chatId),
    []
  )
  const loadMessages = useCallback(
    (agentRef: string, chatId: string, limit?: number, offset?: number) =>
      window.clerum.chat.loadMessages(agentRef, chatId, limit, offset),
    []
  )
  const appendMessages = useCallback(
    (agentRef: string, chatId: string, messages: ChatMessage[]) =>
      window.clerum.chat.appendMessages(agentRef, chatId, messages),
    []
  )
  const replaceMessages = useCallback(
    (agentRef: string, chatId: string, messages: ChatMessage[]) =>
      window.clerum.chat.replaceMessages(agentRef, chatId, messages),
    []
  )
  const markUnreadTerminal = useCallback(
    (agentRef: string, chatId: string) => window.clerum.chat.markUnreadTerminal(agentRef, chatId),
    []
  )
  const clearUnreadTerminal = useCallback(
    (agentRef: string, chatId: string) => window.clerum.chat.clearUnreadTerminal(agentRef, chatId),
    []
  )
  const getLastActive = useCallback(
    (agentRef: string) => window.clerum.chat.getLastActive(agentRef),
    []
  )
  const setLastActive = useCallback(
    (agentRef: string, chatId: string) => window.clerum.chat.setLastActive(agentRef, chatId),
    []
  )
  const getIndex = useCallback((agentRef: string) => window.clerum.chat.getIndex(agentRef), [])
  const dismissOnboarding = useCallback(
    (agentRef: string) => window.clerum.chat.dismissOnboarding(agentRef),
    []
  )

  const listSessions = useCallback((hostRef: string) => window.clerum.rpc.listSessions(hostRef), [])
  const loadSessionMessages = useCallback(
    (hostRef: string, agent: string, chatId: string) =>
      window.clerum.rpc.loadSessionMessages(hostRef, agent, chatId),
    []
  )
  const getContextBreakdown = useCallback(
    (hostRef: string, agent: string, chatId: string) =>
      window.clerum.rpc.getContextBreakdown(hostRef, agent, chatId),
    []
  )

  return {
    listChats,
    createChat,
    renameChat,
    deleteChat,
    loadMessages,
    appendMessages,
    replaceMessages,
    markUnreadTerminal,
    clearUnreadTerminal,
    getLastActive,
    setLastActive,
    getIndex,
    dismissOnboarding,
    listSessions,
    loadSessionMessages,
    getContextBreakdown,
  }
}

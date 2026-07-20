import { useCallback } from 'react'
import type { ChatMessage } from '../../../src/types'

// The session lifecycle types live in the shared `src/types` (they cross the
// IPC bridge from the server). Re-exported here so existing UI imports from
// `useChatStore` keep working. The `window.clerum` shape is declared canonically
// in `desktop-app/src/renderer.d.ts` (chat + rpc session methods included).
export type {
  ContextBreakdownLite,
  ContextBreakdownResult,
  HostModelOption,
  HostModelsResult,
  PendingApprovalLite,
  SessionLifecycleState,
  SessionTokensLite,
  SetHostModelResult,
} from '../../../src/types'

/**
 * Per-chat PENDING model selections (R2 "Option A"). When a user changes the
 * model while the agent host is SUSPENDED (`replicas=0`), the `POST /model`
 * write can't reach the runtime, so the choice can't be persisted server-side.
 * Rather than silently drop it, the selection is held here — keyed by the same
 * `(agentRef, chatId)` pair sessions are keyed by — and PIGGYBACKED onto the
 * next message send, which wakes the host and applies the model to that task.
 *
 * This is a module-level singleton (not React state): it is written by
 * `useHostModels.selectModel` and drained by the send path in
 * `useAgentChatController`, two independent consumers that never share a render
 * tree, and neither needs to re-render when it changes (the optimistic UI is
 * owned by `useHostModels`' own state). Keeping it out of React state avoids a
 * context/provider just to shuttle one imperative value between them.
 */
const pendingModelByChat: Record<string, string> = {}

/**
 * PRE-CHAT model selections (R2 new-chat composer). On the new-chat composer the
 * user can pick a model BEFORE any chat exists, so there is no `chatId` to key a
 * pending entry by (and no server round-trip is possible — there is no session to
 * `POST /model` for). The pick is held here keyed by agent alone, kept purely
 * local so it creates NO stray/empty chat. On the first send the controller
 * migrates it into `pendingModelByChat` under the freshly-created `chatId` and
 * piggybacks it onto the outgoing message. Same module-singleton rationale as
 * `pendingModelByChat`.
 */
const preChatModelByAgent: Record<string, string> = {}

/** Composite key mirroring the session `chatKey` convention (`agentRef::chatId`). */
function pendingModelKey(agentRef: string, chatId: string): string {
  return `${agentRef}::${chatId}`
}

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
  const getHostModels = useCallback(
    (hostRef: string, chatId: string) => window.clerum.rpc.getHostModels(hostRef, chatId),
    []
  )
  const setHostModel = useCallback(
    (hostRef: string, chatId: string, model: string) =>
      window.clerum.rpc.setHostModel(hostRef, chatId, model),
    []
  )

  // --- Pending (unpersisted) model selections — R2 "Option A" (see the
  // `pendingModelByChat` note above). Only UNPERSISTED selections are tracked:
  // a selection accepted by the runtime survives host suspension in the session
  // store and needs no piggybacking.
  const setPendingModel = useCallback((agentRef: string, chatId: string, model: string) => {
    if (!agentRef || !chatId || !model) return
    pendingModelByChat[pendingModelKey(agentRef, chatId)] = model
  }, [])
  const getPendingModel = useCallback(
    (agentRef: string, chatId: string): string | undefined =>
      agentRef && chatId ? pendingModelByChat[pendingModelKey(agentRef, chatId)] : undefined,
    []
  )
  const clearPendingModel = useCallback((agentRef: string, chatId: string) => {
    if (!agentRef || !chatId) return
    delete pendingModelByChat[pendingModelKey(agentRef, chatId)]
  }, [])

  // --- Pre-chat (unpersisted, no chatId yet) model selection — R2 new-chat
  // composer selector. Keyed by agent alone; migrated to a `pendingModelByChat`
  // entry by the send path once the first send creates the chatId.
  const setPreChatModel = useCallback((agentRef: string, model: string) => {
    if (!agentRef || !model) return
    preChatModelByAgent[agentRef] = model
  }, [])
  const getPreChatModel = useCallback(
    (agentRef: string): string | undefined =>
      agentRef ? preChatModelByAgent[agentRef] : undefined,
    []
  )
  const clearPreChatModel = useCallback((agentRef: string) => {
    if (!agentRef) return
    delete preChatModelByAgent[agentRef]
  }, [])

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
    getHostModels,
    setHostModel,
    setPendingModel,
    getPendingModel,
    clearPendingModel,
    setPreChatModel,
    getPreChatModel,
    clearPreChatModel,
  }
}

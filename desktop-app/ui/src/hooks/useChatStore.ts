import { useCallback } from 'react'
import type {
  ChatMessage,
  ReplaceChatMessagesOptions,
  SessionMessagesQuery,
  SessionsListQuery,
  SessionsListResult,
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
import {
  clearPendingModelIntent,
  clearPreChatModelIntent,
  getPendingModelIntent,
  getPreChatModelIntent,
  setPendingModelIntent,
  setPreChatModelIntent,
} from '../lib/hostModelIntentStore'
import {
  markHostModelSelectionChanged,
  resetHostModelSelectionStore,
} from '../lib/hostModelSelectionStore'

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
 * PRE-CHAT model selections (R2 new-chat composer). On the new-chat composer the
 * user can pick a model BEFORE any chat exists, so there is no `chatId` to key a
 * pending entry by (and no server round-trip is possible — there is no session to
 * `POST /model` for). The pick is held here keyed by agent alone, kept purely
 * local so it creates NO stray/empty chat. On the first send the controller
 * migrates it into `pendingModelByChat` under the freshly-created `chatId` and
 * piggybacks it onto the outgoing message. Same module-singleton rationale as
 * `pendingModelByChat`.
 */
const SESSION_CATALOG_TTL_MS = 5_000

type CachedRequest<T> = {
  expiresAt: number
  promise: Promise<T>
}

const sessionCatalogRequests = new Map<string, CachedRequest<SessionsListResult>>()
let sessionCatalogSource: typeof window.clerum.rpc.listSessions | null = null
let remoteCacheScope = 'unknown'

function pruneExpiredSessionCatalogRequests(now = Date.now()): void {
  for (const [key, cached] of sessionCatalogRequests) {
    if (cached.expiresAt <= now) {
      sessionCatalogRequests.delete(key)
    }
  }
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
  const backfillCounters = useCallback(
    (agentRef: string, chatId: string, messages: ChatMessage[]) => {
      const backfill = window.clerum.chat.backfillCounters
      return typeof backfill === 'function'
        ? backfill(agentRef, chatId, messages)
        : Promise.resolve()
    },
    []
  )
  const replaceMessages = useCallback(
    (
      agentRef: string,
      chatId: string,
      messages: ChatMessage[],
      options?: ReplaceChatMessagesOptions
    ) =>
      options
        ? window.clerum.chat.replaceMessages(agentRef, chatId, messages, options)
        : window.clerum.chat.replaceMessages(agentRef, chatId, messages),
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
  const reconcileServerSessions = useCallback(
    (agentRef: string, sessions: Array<{ chatId: string; lastActivityAt?: string }>) =>
      window.clerum.chat.reconcileServerSessions(agentRef, sessions),
    []
  )
  const dismissOnboarding = useCallback(
    (agentRef: string) => window.clerum.chat.dismissOnboarding(agentRef),
    []
  )

  const listSessions = useCallback(
    (hostRef: string, query: SessionsListQuery = {}, options: { force?: boolean } = {}) => {
      const source = window.clerum.rpc.listSessions
      if (sessionCatalogSource !== source) {
        sessionCatalogRequests.clear()
        sessionCatalogSource = source
      }
      const key = [
        remoteCacheScope,
        hostRef,
        query.agent ?? '',
        query.limit ?? 'all',
        query.cursor ?? '',
      ].join(':')
      pruneExpiredSessionCatalogRequests()
      const cached = sessionCatalogRequests.get(key)
      if (!options.force && cached && cached.expiresAt > Date.now()) return cached.promise

      const promise = source(hostRef, undefined, query).catch(error => {
        sessionCatalogRequests.delete(key)
        throw error
      })
      sessionCatalogRequests.set(key, {
        expiresAt: Date.now() + SESSION_CATALOG_TTL_MS,
        promise,
      })
      return promise
    },
    []
  )
  const loadSessionMessages = useCallback(
    (hostRef: string, agent: string, chatId: string, query: SessionMessagesQuery = {}) =>
      window.clerum.rpc.loadSessionMessages(hostRef, agent, chatId, undefined, query),
    []
  )
  const getContextBreakdown = useCallback(
    (hostRef: string, agent: string, chatId: string) =>
      window.clerum.rpc.getContextBreakdown(hostRef, agent, chatId),
    []
  )
  // #654 M12 — no cache layer here. `hostModelSelectionStore` owns request
  // deduplication AND revision ordering; a second TTL cache in front of it could
  // only serve a response fetched before a write, which is exactly the stale
  // revision the CAS must not be armed with. Both call sites already bypassed
  // it with `force: true`, so the layer had no reader left.
  const getHostModels = useCallback(
    (hostRef: string, chatId: string) => window.clerum.rpc.getHostModels(hostRef, chatId),
    []
  )
  const setHostModel = useCallback(
    (hostRef: string, chatId: string, model: string, expectedRevision?: number) =>
      window.clerum.rpc.setHostModel(hostRef, chatId, model, undefined, expectedRevision),
    []
  )
  // Spec 15 Fase B — propagate an explicit user rename to the server. In this app
  // hostRef === agent === agentRef (same key used by listSessions). Rejections
  // propagate so the pending-rename queue can branch on the HTTP status.
  const renameSession = useCallback(
    (agentRef: string, chatId: string, title: string) =>
      window.clerum.rpc.renameSession(agentRef, agentRef, chatId, title),
    []
  )
  const clearCachedRemoteData = useCallback(() => {
    sessionCatalogRequests.clear()
    sessionCatalogSource = null
  }, [])
  const setRemoteCacheScope = useCallback((scope: string) => {
    if (remoteCacheScope === scope) return
    remoteCacheScope = scope
    sessionCatalogRequests.clear()
    // Pending selections are session-owned even though they are not remote
    // responses. Never carry an unpersisted model choice across logout, user,
    // or team boundaries where the same agent/chat identifiers may reappear.
    resetHostModelSelectionStore()
  }, [])

  // --- Pending (unpersisted) model selections — R2 "Option A" (see the
  // `pendingModelByChat` note above). Only UNPERSISTED selections are tracked:
  // a selection accepted by the runtime survives host suspension in the session
  // store and needs no piggybacking.
  const setPendingModel = useCallback((agentRef: string, chatId: string, model: string) => {
    setPendingModelIntent(agentRef, chatId, model)
    markHostModelSelectionChanged(agentRef, chatId)
  }, [])
  const getPendingModel = useCallback(
    (agentRef: string, chatId: string): string | undefined =>
      getPendingModelIntent(agentRef, chatId),
    []
  )
  const clearPendingModel = useCallback((agentRef: string, chatId: string) => {
    clearPendingModelIntent(agentRef, chatId)
    markHostModelSelectionChanged(agentRef, chatId)
  }, [])

  // --- Pre-chat (unpersisted, no chatId yet) model selection — R2 new-chat
  // composer selector. Keyed by agent alone; migrated to a `pendingModelByChat`
  // entry by the send path once the first send creates the chatId.
  const setPreChatModel = useCallback((agentRef: string, model: string) => {
    setPreChatModelIntent(agentRef, model)
    markHostModelSelectionChanged(agentRef, null)
  }, [])
  const getPreChatModel = useCallback(
    (agentRef: string): string | undefined => getPreChatModelIntent(agentRef),
    []
  )
  const clearPreChatModel = useCallback((agentRef: string) => {
    clearPreChatModelIntent(agentRef)
    markHostModelSelectionChanged(agentRef, null)
  }, [])

  return {
    listChats,
    createChat,
    renameChat,
    deleteChat,
    loadMessages,
    appendMessages,
    replaceMessages,
    backfillCounters,
    markUnreadTerminal,
    clearUnreadTerminal,
    getLastActive,
    setLastActive,
    getIndex,
    reconcileServerSessions,
    dismissOnboarding,
    listSessions,
    loadSessionMessages,
    getContextBreakdown,
    getHostModels,
    setHostModel,
    renameSession,
    clearCachedRemoteData,
    setRemoteCacheScope,
    setPendingModel,
    getPendingModel,
    clearPendingModel,
    setPreChatModel,
    getPreChatModel,
    clearPreChatModel,
  }
}

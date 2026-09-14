import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { agentChatPlaceholder, remotePlaceholder } from '@lib/chatTitle'
import { type PendingRename, resolveSessionTitle } from '@lib/resolveSessionTitle'
import type { ChatIndex, ChatMetadata, SessionsListResult } from '../../../../src/types'
import { scheduleAfterFirstPaint } from '../scheduleAfterFirstPaint'
import type { useChatStore } from '../useChatStore'
import { type SessionFsmEvent, type SessionFsmStore, seedSessionSnapshots } from './sessionFsm'

const SESSION_CATALOG_PAGE_LIMIT = 50

// R1-M1: an 'offline' pending rename (a genuine network / 5xx failure) retries on
// every listSessions poll and every `window 'online'` event. A deterministic 5xx
// / 501 would otherwise re-issue the PATCH forever, so cap the auto-retries per
// entry: 5 rides out a transient blip and a few poll cycles before giving up,
// while keeping the request volume bounded. Only 'offline' failures count toward
// this budget — a 404 ('in-flight', waiting for the session to materialize) is a
// wait, not a failure, and is bounded instead by the flush gate (it only retries
// when a poll reports its session present), so a never-materializing session
// simply stops PATCHing without ever exhausting a budget. On exhaustion the
// optimistic local title is KEPT (no rollback, no more PATCH); an explicit fresh
// user rename replaces the entry and starts a new budget.
export const MAX_RENAME_SYNC_ATTEMPTS = 5

/**
 * useChatListController (spec-v2 §4.4) — owns the whole sidebar chat-list
 * subsystem extracted from the god-hook:
 *
 *  - the per-agent `chatList` (+ `chatListLoading`) for the SELECTED agent and
 *    its loader (`loadChatList`, which seeds the badge FSM via SERVER_SNAPSHOT);
 *  - the cross-agent "Latest sessions" list (`latestChatSessions`) and its own
 *    periodic loader;
 *  - the pending per-agent chat selection ref consumed by the parent's
 *    agent-selection effect;
 *  - chat CRUD (create / rename / delete) and the narrow mutation API the
 *    parent's remaining flows (reconciler branches, unread effects, switchToChat,
 *    sendAgentMessage, the agent-selection effect) call to keep both lists in
 *    sync.
 *
 * Design (Fase 5d): the controller is the SINGLE owner of both lists' STATE and
 * exposes semantic imperative operations (never a raw `setChatList`). The
 * active-chat flows stay in the parent and call these ops. The few parent-side
 * concerns the CRUD needs (switchToChat, scrollChatToBottom, dispatchSession,
 * clearComposerDraft, the live activeChatId) are injected through a stable
 * `host` ref the parent fills each render — the same ref-indirection idiom the
 * god-hook already uses for its live callbacks.
 */

export interface SidebarChatEntry extends ChatMetadata {
  remote?: boolean
}

/** Cross-agent sidebar entry (dev's `latestChatSessions`): a chat plus its owning agent. */
export interface LatestSidebarChatEntry extends SidebarChatEntry {
  agentRef: string
}

/** The pending selection requested for an agent before its chats have loaded. */
export type PendingChatSelection =
  | { mode: 'latest'; chatId: null }
  | { mode: 'none'; chatId: null }
  | { mode: 'specific'; chatId: string; title?: string; isRemote?: boolean }

/**
 * Parent-owned collaborators the CRUD flows need. The parent fills this ref each
 * render (after switchToChat & friends are defined) so the controller's stable
 * callbacks always reach the latest closures without recreating themselves.
 */
export interface ChatListControllerHost {
  switchToChat: (agentRef: string, chatId: string) => Promise<void>
  scrollChatToBottom: () => void
  dispatchSession: (chatKey: string, event: SessionFsmEvent) => void
  clearComposerDraft: (chatId: string) => void
  getActiveChatId: () => string | null
  getAutoSelectedChatId: () => string | null
  markAutoSelectedChat: (chatId: string | null) => void
  shouldAutoSelectLatest: () => boolean
  /**
   * Transient feedback for a rename that genuinely failed (spec 15 §2.5). The
   * parent owns the toast stack; the controller reaches it through this ref
   * rather than taking `pushToast` as a param (its callers don't have it).
   */
  pushToast: (message: string, tone: 'success' | 'error' | 'info') => void
}

interface UseChatListControllerParams {
  selectedAgent: string | null
  agentNames: string[]
  isAuthenticated: boolean
  scopeKey: string
  /**
   * The USER portion of the scope (`currentUserId ?? 'unknown-user'`), passed
   * explicitly rather than split from `scopeKey` (which is `${userId}:${teamId}`).
   * The pending-rename queue is per-user (sessions are keyed by userId server-side),
   * so it must be dropped when the user identity changes but PRESERVED across a
   * team-switch of the same user — see the teardown effect below.
   */
  authUserKey: string
  loadMenuData: boolean
  chatStore: ReturnType<typeof useChatStore>
  fsm: SessionFsmStore
  host: MutableRefObject<ChatListControllerHost | null>
}

function sortableTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

const byUpdatedDesc = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  sortableTimestamp(b.updatedAt) - sortableTimestamp(a.updatedAt)

const byLastActivityDesc = (a: { lastActivityAt: string }, b: { lastActivityAt: string }) =>
  sortableTimestamp(b.lastActivityAt) - sortableTimestamp(a.lastActivityAt)

function isRecoverableCatalogCursorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b4\d\d\b/.test(message) || message.toLowerCase().includes('invalid')
}

/**
 * Classify a failed rename RPC for the pending-rename queue (spec 15 §2.5). The
 * HTTP status rides the error message as `(NNN)` (see rpcProxyClient.renameSession
 * — the raw title is never in the message). A missing status (a bare transport
 * error) is treated as a network failure.
 *  - 'not-found' (404): session not materialized server-side yet → keep pending,
 *    retry once it appears in listSessions. NOT an error; no rollback.
 *  - 'client-error' (other 4xx: 400 invalid title, 401/403 access): a genuine
 *    rejection → roll the optimistic title back and toast.
 *  - 'network' (5xx / no status): transient → queue offline, retry on reconnect.
 */
function classifyRenameError(error: unknown): 'not-found' | 'client-error' | 'network' {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\((\d{3})\)/)
  const status = match ? Number(match[1]) : null
  if (status === 404) return 'not-found'
  if (status !== null && status >= 400 && status < 500) return 'client-error'
  return 'network'
}

function dedupeSidebarChats<T extends SidebarChatEntry>(chats: T[]): T[] {
  const seen = new Set<string>()
  return chats.filter(chat => {
    if (seen.has(chat.id)) return false
    seen.add(chat.id)
    return true
  })
}

function knownServerMessageCount(session: SessionsListResult['items'][number]): number {
  const count = session.messageCount
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

export function useChatListController({
  selectedAgent,
  agentNames,
  isAuthenticated,
  scopeKey,
  authUserKey,
  loadMenuData,
  chatStore,
  fsm,
  host,
}: UseChatListControllerParams) {
  // Per-agent list for the SELECTED agent (the sidebar's chat list).
  const [chatList, setChatList] = useState<SidebarChatEntry[]>([])
  const [chatListLoading, setChatListLoading] = useState(false)
  const [chatListMoreLoading, setChatListMoreLoading] = useState(false)
  const [chatListHasMoreRemoteSessions, setChatListHasMoreRemoteSessions] = useState(false)
  // Cross-agent "Latest sessions" list (badges live in the FSM, seeded below).
  const [latestChatSessions, setLatestChatSessions] = useState<LatestSidebarChatEntry[]>([])
  const [latestChatSessionsLoading, setLatestChatSessionsLoading] = useState(false)
  // Selection requested for an agent before its chats have loaded, consumed by
  // the parent's agent-selection effect. Ref (not state): imperative, per-agent.
  const pendingChatSelectionByAgentRef = useRef<Record<string, PendingChatSelection>>({})
  const suppressAutoSelectionByAgentRef = useRef<Map<string, number>>(new Map())
  const suppressAutoSelectionSequenceRef = useRef(0)
  const chatListNextCursorByAgentRef = useRef<Record<string, string | null | undefined>>({})
  const chatListLoadingMoreByAgentRef = useRef<Set<string>>(new Set())
  const requestGenerationRef = useRef(0)

  // Spec 15 §2.5 (B21) — pending-rename queue. A user rename is optimistic-local
  // first, then synced by RPC; while unconfirmed the local title wins over the
  // server (§2.2 cases E/F). Kept in a ref (NOT on the persisted ChatMetadata):
  // it must live in memory only and survive list rebuilds + retries. Keyed by
  // `${agentRef}:${chatId}`. `state` maps directly to `resolveSessionTitle`'s
  // `pendingRename`: 'in-flight' (PATCH sent / awaiting the session to exist
  // server-side after a 404) or 'offline' (network failure, retry on reconnect).
  const pendingRenamesRef = useRef<
    Map<
      string,
      {
        agentRef: string
        chatId: string
        title: string
        // Title BEFORE the first rename of the current pending chain (the last
        // non-pending value) — the rollback target. Preserved across a re-rename
        // so a rollback never restores an unconfirmed optimistic title (FIX 2).
        previousTitle: string
        state: PendingRename
        // A PATCH for this exact entry is in flight right now (FIX 1). Distinct
        // from `state` (which is the durable 'in-flight'/'offline' pending kind):
        // this gates re-entrancy so a flush poll never fires a duplicate PATCH.
        sending: boolean
        // R1-M1: count of GENUINE ('offline' network / 5xx) failed sync attempts
        // for THIS entry (never reset while the entry lives). A 404 ('in-flight')
        // does NOT increment it — that is a wait for materialization, not a
        // failure. Drives the retry budget below.
        failureCount: number
        // R1-M1: budget exhausted — keep the optimistic local title but stop
        // auto-retrying on polls/online. Only 'offline' entries can reach this;
        // a fresh user rename makes a new entry.
        retriesExhausted: boolean
      }
    >
  >(new Map())

  const pendingRenameKey = (agentRef: string, chatId: string): string => `${agentRef}:${chatId}`

  const pendingRenameStateFor = useCallback((agentRef: string, chatId: string): PendingRename => {
    return pendingRenamesRef.current.get(pendingRenameKey(agentRef, chatId))?.state ?? 'none'
  }, [])

  // Indirection so the catalog loaders (defined above the queue) can trigger a
  // retry of pending renames after a listSessions poll without depending on the
  // queue's identity. Wired in an effect once the queue is defined.
  const flushPendingRenamesRef = useRef<(serverChatKeys?: Set<string>) => void>(() => {})

  useEffect(() => {
    requestGenerationRef.current += 1
  }, [isAuthenticated, scopeKey])

  // R1-H1 — the pending-rename queue is per-USER identity. mcp-host keys a chat
  // session by userId (`${userSub}:rpc:${agent}:${chatId}`) and filters by
  // `conversation.user_id === userId`, so a queued rename stays legitimate across
  // a TEAM-switch of the same user and must keep syncing. Only a change of user
  // identity (logout, or login as someone else) makes the queued renames belong to
  // a foreign identity — drop them so a later flush/poll/online never PATCHes them
  // under the new user's token. Keyed on the user portion ONLY, never the combined
  // `scopeKey`: clearing on a team-switch would strip the pending marker and let
  // the server title overwrite the user's own optimistic rename on the next poll
  // (resolveSessionTitle case C). This hook is never unmounted on logout/team-switch
  // (it lives at App's root), so this effect is the queue's only identity teardown.
  // A PATCH still in flight when this runs no-ops on completion without re-inserting
  // (attemptRenameRpc's `pendingRenamesRef.current.get(key) !== entry` guard).
  useEffect(() => {
    pendingRenamesRef.current.clear()
  }, [authUserKey])

  // Live `selectedAgent` for the stable callbacks below (they gate a chatList
  // write on "is this the selected agent"). A ref keeps the callbacks stable
  // while always reading the committed value at call time.
  const selectedAgentRef = useRef(selectedAgent)
  useEffect(() => {
    selectedAgentRef.current = selectedAgent
    setChatListHasMoreRemoteSessions(
      Boolean(selectedAgent && chatListNextCursorByAgentRef.current[selectedAgent])
    )
    setChatListMoreLoading(
      Boolean(selectedAgent && chatListLoadingMoreByAgentRef.current.has(selectedAgent))
    )
    return () => {
      if (selectedAgentRef.current === selectedAgent) {
        selectedAgentRef.current = null
      }
    }
  }, [selectedAgent])

  // ─── Cross-agent latest-sessions mutators ───

  const upsertLatestChatSession = useCallback((agentRef: string, chat: SidebarChatEntry) => {
    setLatestChatSessions(previous => {
      const next = [
        { ...chat, agentRef },
        ...previous.filter(item => item.agentRef !== agentRef || item.id !== chat.id),
      ]
      return next.sort(byUpdatedDesc)
    })
  }, [])

  const removeLatestChatSession = useCallback((agentRef: string, chatId: string) => {
    setLatestChatSessions(previous =>
      previous.filter(item => item.agentRef !== agentRef || item.id !== chatId)
    )
  }, [])

  // ─── chatList loader (agent-scoped) ───

  const loadChatListOnce = useCallback(
    async (
      agentRef: string,
      requestGeneration: number
    ): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] }> => {
      chatListNextCursorByAgentRef.current[agentRef] = null
      if (selectedAgentRef.current === agentRef) {
        setChatListHasMoreRemoteSessions(false)
        setChatListMoreLoading(chatListLoadingMoreByAgentRef.current.has(agentRef))
      }
      const index = await chatStore.getIndex(agentRef)
      const merged = [...index.chats].sort(byUpdatedDesc)
      if (
        selectedAgentRef.current !== agentRef ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return { index, merged }
      }
      setChatList(merged)

      const suppressionMarkerAtRequest = suppressAutoSelectionByAgentRef.current.get(agentRef)
      scheduleAfterFirstPaint(async () => {
        const serverResult = await chatStore
          .listSessions(agentRef, { agent: agentRef, limit: SESSION_CATALOG_PAGE_LIMIT })
          .catch((): SessionsListResult => ({ items: [] }))
        if (
          selectedAgentRef.current !== agentRef ||
          requestGenerationRef.current !== requestGeneration
        ) {
          if (
            suppressionMarkerAtRequest !== undefined &&
            suppressAutoSelectionByAgentRef.current.get(agentRef) === suppressionMarkerAtRequest
          ) {
            suppressAutoSelectionByAgentRef.current.delete(agentRef)
          }
          return
        }

        // New hosts scope the page server-side. Keep this boundary check for
        // older hosts and malformed proxy responses so another agent's catalog
        // entry can never leak into the selected agent's sidebar.
        const serverSessions = serverResult.items
          .filter(s => s.agent === agentRef)
          .sort(byLastActivityDesc)
        chatListNextCursorByAgentRef.current[agentRef] = serverResult.nextCursor ?? null
        setChatListHasMoreRemoteSessions(Boolean(serverResult.nextCursor))

        // Seed sidebar session state (state/activeTaskId/pendingApproval/tokens)
        // for badges via SERVER_SNAPSHOT (D4 / §4.1 R2 owns "never degrade a live
        // task").
        seedSessionSnapshots(fsm, agentRef, serverSessions)

        // Chats the server knows but the local cache doesn't (e.g. created on
        // another device). Post-§7.1 wipe these are normal entries — no
        // "Remote ·" label, no isRemote branch; switchToChat's unified path
        // hydrates them.
        setChatList(previous => {
          const dedupedPrevious = dedupeSidebarChats(previous)
          const serverById = new Map(serverSessions.map(s => [s.chatId, s]))
          const knownIds = new Set(dedupedPrevious.map(c => c.id))
          // Cases C/D/E/F (§2.2): the server is authoritative for a cached chat's
          // title when it reports one AND no local rename is pending; a pending
          // rename (in-flight / offline) keeps the local title until it lands.
          const reconciled = dedupedPrevious.map(chat => {
            const server = serverById.get(chat.id)
            if (!server) return chat
            const { title } = resolveSessionTitle({
              inCache: true,
              localTitle: chat.title,
              serverTitle: server.title,
              pendingRename: pendingRenameStateFor(agentRef, chat.id),
              placeholder: agentChatPlaceholder(chat.id),
            })
            return title === chat.title ? chat : { ...chat, title }
          })
          // Cases A/B (§2.2): a server-only chat shows the server title when the
          // host reports one, else the "Chat <id>" placeholder.
          const fromServerOnly: SidebarChatEntry[] = serverSessions
            .filter(s => !knownIds.has(s.chatId))
            .map(s => ({
              id: s.chatId,
              title: resolveSessionTitle({
                inCache: false,
                serverTitle: s.title,
                pendingRename: pendingRenameStateFor(agentRef, s.chatId),
                placeholder: agentChatPlaceholder(s.chatId),
              }).title,
              createdAt: s.lastActivityAt,
              updatedAt: s.lastActivityAt,
              // Older hosts omit messageCount. Keep that unknown value at zero
              // instead of fabricating two messages per turn and overstating
              // Activity totals when tool/system messages vary by session.
              messageCount: knownServerMessageCount(s),
              remote: true,
            }))
          return [...reconciled, ...fromServerOnly].sort(byUpdatedDesc)
        })

        // §2.5: a rename that 404'd (session not yet server-side) retries now that
        // the poll reports which sessions exist.
        flushPendingRenamesRef.current(new Set(serverSessions.map(s => `${agentRef}:${s.chatId}`)))

        const latestServerSession = serverSessions[0]
        // A mode:none request suppresses this one deferred catalog result. Consume
        // it here, after the post-paint continuation reaches the auto-select gate,
        // instead of clearing it with the synchronous local-index selection.
        const suppressAutoSelection = suppressAutoSelectionByAgentRef.current.delete(agentRef)
        const currentHost = host.current
        const activeChatId = currentHost?.getActiveChatId() ?? null
        const autoSelectedChatId = currentHost?.getAutoSelectedChatId() ?? null
        const selectedLocalChat = activeChatId
          ? merged.find(chat => chat.id === activeChatId)
          : undefined
        const serverIsNewerThanSelection =
          !selectedLocalChat ||
          Date.parse(latestServerSession?.lastActivityAt ?? '') >
            Date.parse(selectedLocalChat.updatedAt)
        if (
          currentHost &&
          latestServerSession &&
          (activeChatId === null || activeChatId === autoSelectedChatId) &&
          activeChatId !== latestServerSession.chatId &&
          serverIsNewerThanSelection &&
          currentHost.shouldAutoSelectLatest() &&
          !suppressAutoSelection
        ) {
          currentHost.markAutoSelectedChat(latestServerSession.chatId)
          void currentHost.switchToChat(agentRef, latestServerSession.chatId)
        }

        // Persist server freshness into the local index (spec §5.3): keeps the
        // durable sidebar order aligned with the source of truth. Best-effort:
        // must never block or fail the visible local-cache render.
        try {
          void chatStore
            .reconcileServerSessions(
              agentRef,
              serverSessions.map(s => ({ chatId: s.chatId, lastActivityAt: s.lastActivityAt }))
            )
            .catch(() => undefined)
        } catch {
          // ignore — reconciliation is best-effort freshness only
        }
      })

      return { index, merged }
    },
    [chatStore.getIndex, chatStore.listSessions, chatStore.reconcileServerSessions, fsm]
  )

  const loadMoreChatSessions = useCallback(async () => {
    const agentRef = selectedAgentRef.current
    if (!agentRef) return

    const cursor = chatListNextCursorByAgentRef.current[agentRef]
    if (!cursor) {
      setChatListHasMoreRemoteSessions(false)
      return
    }
    if (chatListLoadingMoreByAgentRef.current.has(agentRef)) return

    chatListLoadingMoreByAgentRef.current.add(agentRef)
    const requestGeneration = requestGenerationRef.current
    setChatListMoreLoading(true)
    try {
      let serverResult: SessionsListResult
      try {
        serverResult = await chatStore.listSessions(
          agentRef,
          { agent: agentRef, limit: SESSION_CATALOG_PAGE_LIMIT, cursor },
          { force: true }
        )
      } catch (error) {
        if (
          requestGenerationRef.current === requestGeneration &&
          selectedAgentRef.current === agentRef
        ) {
          if (isRecoverableCatalogCursorError(error)) {
            chatListNextCursorByAgentRef.current[agentRef] = null
            setChatListHasMoreRemoteSessions(false)
          } else {
            setChatListHasMoreRemoteSessions(true)
          }
        }
        return
      }
      if (requestGenerationRef.current !== requestGeneration) return

      const serverSessions = serverResult.items.filter(s => s.agent === agentRef)
      if (selectedAgentRef.current !== agentRef) return

      chatListNextCursorByAgentRef.current[agentRef] = serverResult.nextCursor ?? null
      setChatListHasMoreRemoteSessions(Boolean(serverResult.nextCursor))
      seedSessionSnapshots(fsm, agentRef, serverSessions)
      setChatList(previous => {
        const dedupedPrevious = dedupeSidebarChats(previous)
        const serverById = new Map(serverSessions.map(s => [s.chatId, s]))
        const knownIds = new Set(dedupedPrevious.map(c => c.id))
        // Cases C/D/E/F (§2.2): reconcile the title of any cached chat this page
        // also reports; server wins when it has a title and no rename is pending.
        const reconciled = dedupedPrevious.map(chat => {
          const server = serverById.get(chat.id)
          if (!server) return chat
          const { title } = resolveSessionTitle({
            inCache: true,
            localTitle: chat.title,
            serverTitle: server.title,
            pendingRename: pendingRenameStateFor(agentRef, chat.id),
            placeholder: agentChatPlaceholder(chat.id),
          })
          return title === chat.title ? chat : { ...chat, title }
        })
        // Cases A/B (§2.2): server-only page entries.
        const fromServerOnly: SidebarChatEntry[] = serverSessions
          .filter(s => !knownIds.has(s.chatId))
          .map(s => ({
            id: s.chatId,
            title: resolveSessionTitle({
              inCache: false,
              serverTitle: s.title,
              pendingRename: pendingRenameStateFor(agentRef, s.chatId),
              placeholder: agentChatPlaceholder(s.chatId),
            }).title,
            createdAt: s.lastActivityAt,
            updatedAt: s.lastActivityAt,
            messageCount: knownServerMessageCount(s),
            remote: true,
          }))
        return [...reconciled, ...fromServerOnly].sort(byUpdatedDesc)
      })

      try {
        void chatStore
          .reconcileServerSessions(
            agentRef,
            serverSessions.map(s => ({ chatId: s.chatId, lastActivityAt: s.lastActivityAt }))
          )
          .catch(() => undefined)
      } catch {
        // ignore — reconciliation is best-effort freshness only
      }
    } finally {
      chatListLoadingMoreByAgentRef.current.delete(agentRef)
      if (selectedAgentRef.current === agentRef) {
        setChatListMoreLoading(false)
      }
    }
  }, [chatStore.listSessions, chatStore.reconcileServerSessions, fsm])

  const loadChatList = useCallback(
    async (agentRef: string): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] } | null> => {
      const requestGeneration = ++requestGenerationRef.current
      // One retry with a short backoff: during boot a concurrent team-switch /
      // access-catalog refresh can momentarily rebind the main-process chat
      // store, rejecting `getIndex` with "Not authenticated". Swallowing that
      // transient into an empty list blanks "Latest sessions" until the agent
      // is re-selected, so give the store one chance to settle.
      for (let attempt = 0; ; attempt++) {
        try {
          return await loadChatListOnce(agentRef, requestGeneration)
        } catch (err) {
          if (attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 300))
            if (
              selectedAgentRef.current !== agentRef ||
              requestGenerationRef.current !== requestGeneration
            ) {
              return null
            }
            continue
          }
          console.warn('[loadChatList] failed after retry, clearing list', { agentRef, err })
          if (
            selectedAgentRef.current === agentRef &&
            requestGenerationRef.current === requestGeneration
          ) {
            setChatList([])
          }
          return null
        }
      }
    },
    [loadChatListOnce]
  )

  // ─── Narrow chatList mutation API (called by the parent's remaining flows) ───

  /** Reset the selected agent's list (logout teardown / load failure). */
  const clearList = useCallback(() => {
    pendingChatSelectionByAgentRef.current = {}
    chatListNextCursorByAgentRef.current = {}
    chatListLoadingMoreByAgentRef.current.clear()
    suppressAutoSelectionByAgentRef.current.clear()
    setChatList([])
    setChatListMoreLoading(false)
    setChatListHasMoreRemoteSessions(false)
  }, [])

  /** Sidebar badge mirror: mark/clear the `unreadTerminal` flag by chat id. */
  const markUnreadInList = useCallback((chatId: string) => {
    setChatList(prev => prev.map(c => (c.id === chatId ? { ...c, unreadTerminal: true } : c)))
  }, [])
  const clearUnreadInList = useCallback((chatId: string) => {
    setChatList(prev =>
      prev.map(c => (c.id === chatId && c.unreadTerminal ? { ...c, unreadTerminal: false } : c))
    )
  }, [])

  /**
   * Optimistic provisional entry for a chat opened before its list loads (a
   * notification/deeplink `specific` selection): prepend if absent, else refresh
   * its title. chatList only — `latestChatSessions` is untouched (parity).
   */
  const upsertProvisionalEntry = useCallback((chatId: string, title: string, isRemote: boolean) => {
    const now = new Date().toISOString()
    setChatList(previous => {
      if (previous.some(chat => chat.id === chatId)) {
        return previous.map(chat =>
          chat.id === chatId ? { ...chat, title: title || chat.title } : chat
        )
      }
      return [
        {
          id: chatId,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          remote: isRemote,
        },
        ...previous,
      ]
    })
  }, [])

  /** Re-apply a title to an existing entry after the list load (no insert). */
  const applyEntryTitle = useCallback((chatId: string, title: string) => {
    setChatList(previous =>
      previous.map(chat => (chat.id === chatId ? { ...chat, title: title || chat.title } : chat))
    )
  }, [])

  /** Latest-sessions-only title re-map (hydrate auto-title, S4). */
  const applyLatestTitle = useCallback((agentRef: string, chatId: string, title: string) => {
    setLatestChatSessions(prev =>
      prev.map(c => (c.agentRef === agentRef && c.id === chatId ? { ...c, title } : c))
    )
  }, [])

  /**
   * S4 hydrate upsert: a chat opened via a notification for the already-selected
   * agent may not be in chatList yet — append it with the resolved title, else
   * just refresh the title on the existing entry.
   */
  const upsertHydratedEntry = useCallback((meta: ChatMetadata, title: string) => {
    setChatList(prev =>
      prev.some(c => c.id === meta.id)
        ? prev.map(c => (c.id === meta.id ? { ...c, ...meta, title, remote: false } : c))
        : [...prev, { ...meta, title }]
    )
  }, [])

  /** Evict a chat the server 404s from the selected agent's list (chatList only). */
  const removeFromList = useCallback((chatId: string) => {
    setChatList(prev => prev.filter(c => c.id !== chatId))
  }, [])

  /**
   * Sidebar freshness on send: bump this chat's updatedAt/messageCount so both
   * lists re-sort it to the top. Touches both lists (the dual-sync this
   * controller exists to own).
   */
  const bumpActivity = useCallback((agentRef: string, chatId: string, updatedAt: string) => {
    setLatestChatSessions(previous =>
      previous
        .map(chat =>
          chat.agentRef === agentRef && chat.id === chatId
            ? { ...chat, updatedAt, messageCount: chat.messageCount + 1 }
            : chat
        )
        .sort(byUpdatedDesc)
    )
    setChatList(previous =>
      previous.map(chat =>
        chat.id === chatId ? { ...chat, updatedAt, messageCount: chat.messageCount + 1 } : chat
      )
    )
  }, [])

  /** Append a freshly-created chat to both lists (create / send auto-create). */
  const appendNewEntry = useCallback(
    (agentRef: string, meta: ChatMetadata) => {
      setChatList(prev => {
        const next = prev.some(chat => chat.id === meta.id) ? prev : [...prev, meta]
        return dedupeSidebarChats(next)
      })
      upsertLatestChatSession(agentRef, meta)
    },
    [upsertLatestChatSession]
  )

  // ─── Pending selection API (consumed by the parent's agent-selection effect) ───

  const readPendingSelection = useCallback(
    (agentName: string): PendingChatSelection | undefined =>
      pendingChatSelectionByAgentRef.current[agentName],
    []
  )
  const writePendingSelection = useCallback(
    (agentName: string, selection: PendingChatSelection) => {
      pendingChatSelectionByAgentRef.current[agentName] = selection
      if (selection.mode === 'none') {
        suppressAutoSelectionSequenceRef.current += 1
        suppressAutoSelectionByAgentRef.current.set(
          agentName,
          suppressAutoSelectionSequenceRef.current
        )
      } else {
        suppressAutoSelectionByAgentRef.current.delete(agentName)
      }
    },
    []
  )
  const clearPendingSelection = useCallback((agentName: string) => {
    delete pendingChatSelectionByAgentRef.current[agentName]
  }, [])

  // ─── Chat CRUD ───

  const handleCreateChat = useCallback(async () => {
    const agentRef = selectedAgentRef.current
    if (!agentRef) return
    const requestGeneration = requestGenerationRef.current
    const chatId = crypto.randomUUID()
    const meta = await chatStore.createChat(agentRef, chatId)
    chatStore.clearCachedRemoteData()
    if (
      selectedAgentRef.current !== agentRef ||
      requestGenerationRef.current !== requestGeneration
    ) {
      return
    }
    appendNewEntry(agentRef, meta)
    host.current?.markAutoSelectedChat(null)
    await host.current?.switchToChat(agentRef, chatId)
    host.current?.scrollChatToBottom()
  }, [chatStore, appendNewEntry, host])

  /**
   * Optimistic LOCAL-only title update (spec 15 §2.5 / B19). Persists to the
   * local index and both sidebar lists WITHOUT firing the rename RPC. Used by
   * the first-turn auto-title path (which must NOT sync an un-redacted client
   * title that would race the server's COALESCE) and, internally, by the
   * user-rename handler before it syncs.
   */
  const applyLocalTitleOnly = useCallback(
    async (agentRef: string, chatId: string, newTitle: string) => {
      if (!agentRef) return
      const requestGeneration = requestGenerationRef.current
      const updatedAt = new Date().toISOString()
      await chatStore.renameChat(agentRef, chatId, newTitle)
      if (requestGenerationRef.current !== requestGeneration) return
      setLatestChatSessions(prev =>
        prev
          .map(chat =>
            chat.agentRef === agentRef && chat.id === chatId
              ? { ...chat, title: newTitle, updatedAt }
              : chat
          )
          .sort(byUpdatedDesc)
      )
      if (selectedAgentRef.current === agentRef) {
        setChatList(prev =>
          prev.map(c => (c.id === chatId ? { ...c, title: newTitle, updatedAt } : c))
        )
      }
    },
    [chatStore]
  )

  /**
   * Sync one pending rename to the server (spec 15 §2.5). 200 confirms and clears
   * the marker; a 404 (session not materialized yet) or a network/5xx failure
   * keeps it pending — 'in-flight' (retried when the session appears in
   * listSessions) or 'offline' (retried on reconnect) — so the local title keeps
   * winning over the server (§2.2 E/F) until it lands. A genuine 4xx rejection
   * rolls the optimistic title back and toasts. Never logs the raw title.
   */
  const attemptRenameRpc = useCallback(
    async (entry: {
      agentRef: string
      chatId: string
      title: string
      previousTitle: string
      state: PendingRename
      sending: boolean
      failureCount: number
      retriesExhausted: boolean
    }) => {
      const key = pendingRenameKey(entry.agentRef, entry.chatId)
      // FIX 1: never fire a duplicate PATCH for a key whose entry is already
      // sending (a flush poll landing during the initial/awaited attempt), and
      // FIX 2: only act on the entry that is STILL the current pending entry for
      // this key — a newer rename may have replaced it, and that newer attempt
      // owns the key from here on. Both guards use object identity.
      if (entry.sending) return
      if (pendingRenamesRef.current.get(key) !== entry) return
      entry.sending = true
      try {
        await chatStore.renameSession(entry.agentRef, entry.chatId, entry.title)
        // Only clear if this attempt still owns the key (a stale 200 must never
        // delete a newer rename's marker — that would drop its case-E protection).
        if (pendingRenamesRef.current.get(key) === entry) {
          pendingRenamesRef.current.delete(key)
        }
      } catch (error) {
        // A newer rename superseded this one: leave the key entirely to it — no
        // rollback, no re-mark (FIX 2).
        if (pendingRenamesRef.current.get(key) !== entry) return
        const kind = classifyRenameError(error)
        if (kind === 'client-error') {
          pendingRenamesRef.current.delete(key)
          // FIX 3: never roll back to an empty title (would blank the sidebar for
          // a chat that had no local cache entry). Clear the marker and let the
          // next poll's merge re-resolve from the server title / placeholder.
          if (entry.previousTitle) {
            await applyLocalTitleOnly(entry.agentRef, entry.chatId, entry.previousTitle)
          }
          host.current?.pushToast(
            'Could not rename the chat. Please try a different name.',
            'error'
          )
          return
        }
        // 404 → keep 'in-flight' (retry once the session exists server-side);
        // network / 5xx → 'offline' (retry on reconnect). Never rolled back.
        entry.state = kind === 'network' ? 'offline' : 'in-flight'
        // R1-M1: bound the auto-retry, but count ONLY genuine failures (network /
        // 5xx → 'offline'). A 404 ('in-flight') is not a failure — it is a WAIT
        // for the session to materialize server-side, and it must survive for as
        // long as that takes; counting it would retire a legitimate slow-to-
        // materialize rename before its PATCH could be accepted (a silent rename
        // loss). On the budget's last genuine failure, stop the entry
        // auto-retrying on future polls/online while keeping its optimistic title
        // (case E/F keeps resolving local until a fresh rename replaces it).
        if (kind === 'network') {
          entry.failureCount += 1
          if (entry.failureCount >= MAX_RENAME_SYNC_ATTEMPTS) {
            entry.retriesExhausted = true
          }
        }
      } finally {
        // Clearing on the entry object is safe even if it was deleted from the
        // Map (a superseding rename owns a different object).
        entry.sending = false
      }
    },
    [chatStore, applyLocalTitleOnly, host]
  )

  /**
   * Retry pending renames (spec 15 §2.5). An 'in-flight' entry (a 404 awaiting the
   * session to materialize server-side) is retried ONLY when a listSessions poll
   * reports its session present (`serverChatKeys` has the key) — a reconnect does
   * not make the session exist, so a bare `window 'online'` event (no keys) never
   * retries it. 'offline' entries (a network / 5xx failure) retry unconditionally,
   * which is exactly the reconnect case.
   */
  const flushPendingRenames = useCallback(
    async (serverChatKeys?: Set<string>) => {
      for (const entry of [...pendingRenamesRef.current.values()]) {
        // FIX 1: skip a key with a PATCH already in flight (attemptRenameRpc
        // guards this too, but skipping avoids spawning a no-op).
        if (entry.sending) continue
        // R1-M1: skip an entry whose retry budget is spent — its optimistic title
        // stays, but it no longer PATCHes on polls/online. Only 'offline' entries
        // can ever reach this state (in-flight never counts toward the budget).
        if (entry.retriesExhausted) continue
        const key = pendingRenameKey(entry.agentRef, entry.chatId)
        // An 'in-flight' (404 waiting for materialization) retries ONLY when this
        // flush is a poll that reports its session present. `online` (no keys) and
        // a poll that does not list the session both skip it — a 404 is not
        // resolved by reconnecting, only by the session existing server-side.
        // Deliberately NOT budgeted: counting the 404 is what silently dropped a
        // legitimate slow-to-materialize rename. The accepted trade is that a
        // session which IS listed yet whose rename keeps 404ing (a backend
        // list-vs-rename inconsistency) re-PATCHes once per poll unbounded — a
        // pathological, self-resolving state, preferred over dropping the rename.
        if (entry.state === 'in-flight' && !serverChatKeys?.has(key)) continue
        await attemptRenameRpc(entry)
      }
    },
    [attemptRenameRpc]
  )

  /**
   * Explicit user rename (spec 15 §2.5 / B19): optimistic local first, then sync
   * to the server via the pending-rename queue. This is the ONLY rename path that
   * fires RPC (the auto-title path uses `applyLocalTitleOnly`).
   */
  const handleRenameChatForAgent = useCallback(
    async (agentRef: string, chatId: string, newTitle: string) => {
      if (!agentRef) return
      const key = pendingRenameKey(agentRef, chatId)
      // FIX 2: the rollback target is the title BEFORE the pending chain began.
      // If a rename is already pending for this key, preserve its `previousTitle`
      // (the last non-pending value) rather than re-reading the index — which now
      // holds the earlier rename's UNCONFIRMED optimistic title.
      const existing = pendingRenamesRef.current.get(key)
      let previousTitle: string
      if (existing) {
        previousTitle = existing.previousTitle
      } else {
        const index = await chatStore.getIndex(agentRef)
        previousTitle = index.chats.find(c => c.id === chatId)?.title ?? ''
      }
      await applyLocalTitleOnly(agentRef, chatId, newTitle)
      // Replace any prior entry: this is now the current rename for the key. A
      // still-in-flight older attempt will no-op on completion (identity guard).
      const entry = {
        agentRef,
        chatId,
        title: newTitle,
        previousTitle,
        state: 'in-flight' as PendingRename,
        sending: false,
        failureCount: 0,
        retriesExhausted: false,
      }
      pendingRenamesRef.current.set(key, entry)
      await attemptRenameRpc(entry)
    },
    [chatStore, applyLocalTitleOnly, attemptRenameRpc]
  )

  const handleRenameChat = useCallback(
    async (chatId: string, newTitle: string) => {
      const agentRef = selectedAgentRef.current
      if (!agentRef) return
      await handleRenameChatForAgent(agentRef, chatId, newTitle)
    },
    [handleRenameChatForAgent]
  )

  // Retry offline (and best-effort in-flight) pending renames when connectivity
  // returns (spec 15 §2.5 case F).
  useEffect(() => {
    const handleOnline = () => {
      void flushPendingRenames()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [flushPendingRenames])

  useEffect(() => {
    flushPendingRenamesRef.current = (serverChatKeys?: Set<string>) => {
      void flushPendingRenames(serverChatKeys)
    }
  }, [flushPendingRenames])

  const handleDeleteChatForAgent = useCallback(
    async (agentRef: string, chatId: string) => {
      if (!agentRef) return
      const requestGeneration = requestGenerationRef.current
      // Stop following any in-flight task for this chat first: ack tears down the
      // SSE + connect/watchdog timers, so a later terminal can't fire onTerminal
      // and resurrect the just-deleted chat file via appendAssistantMessage.
      const deletedKey = makeTaskKey(agentRef, chatId)
      // R5 teardown: CHAT_DELETED removes the FSM entry AND emits the
      // `coordinator_release` effect (tracker.ack) — so a later terminal can't
      // fire onTerminal and resurrect the just-deleted chat file. Dispatched
      // FIRST (before the delete), preserving the ack-before-delete ordering.
      host.current?.dispatchSession(deletedKey, { type: 'CHAT_DELETED' })
      await chatStore.deleteChat(agentRef, chatId)
      chatStore.clearCachedRemoteData()
      if (requestGenerationRef.current !== requestGeneration) return
      host.current?.clearComposerDraft(chatId)
      removeLatestChatSession(agentRef, chatId)
      // Post-await guards read the LIVE committed values (selectedAgentRef /
      // getActiveChatId), intentionally — if the user switched agent during the
      // delete IPC we must not yank a reselection into the agent they just left.
      if (selectedAgentRef.current !== agentRef) return

      // Functional updater: a concurrent chatList update during the delete IPC
      // await (e.g. a fresh cross-agent sessions load) must not be clobbered by a
      // stale pre-await closure snapshot. `remaining` below is only the local
      // navigation hint (best-effort), not the committed source of truth.
      setChatList(prev => prev.filter(c => c.id !== chatId))
      const remaining = chatList.filter(c => c.id !== chatId)

      if (host.current?.getActiveChatId() === chatId) {
        if (remaining.length > 0) {
          const sorted = [...remaining].sort(byUpdatedDesc)
          await host.current?.switchToChat(agentRef, sorted[0]!.id)
        } else {
          await handleCreateChat()
        }
      }
    },
    [chatList, chatStore, removeLatestChatSession, handleCreateChat, host]
  )

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      const agentRef = selectedAgentRef.current
      if (!agentRef) return
      await handleDeleteChatForAgent(agentRef, chatId)
    },
    [handleDeleteChatForAgent]
  )

  // ─── Cross-agent latest-sessions loader (seeds badges via SERVER_SNAPSHOT) ───

  useEffect(() => {
    if (!isAuthenticated || !loadMenuData || !agentNames.length) {
      setLatestChatSessions([])
      setLatestChatSessionsLoading(false)
      return
    }

    let cancelled = false
    setLatestChatSessionsLoading(true)
    ;(async () => {
      try {
        const localGroups = await Promise.all(
          agentNames.map(async agentRef => {
            try {
              const index = await chatStore.getIndex(agentRef)
              return {
                agentRef,
                entries: index.chats.map(chat => ({
                  ...chat,
                  agentRef,
                })),
              }
            } catch {
              return {
                agentRef,
                entries: [] as LatestSidebarChatEntry[],
              }
            }
          })
        )
        if (cancelled) return
        setLatestChatSessions(localGroups.flatMap(group => group.entries).sort(byUpdatedDesc))
        setLatestChatSessionsLoading(false)

        const sessionGroups = await Promise.all(
          agentNames.map(async agentRef => {
            // This feeds only the cross-agent sidebar preview. Do not follow
            // cursors here; the selected-agent session list exposes explicit
            // on-demand pagination through `loadMoreChatSessions`.
            const serverResult: SessionsListResult = await chatStore
              .listSessions(agentRef, {
                agent: agentRef,
                limit: SESSION_CATALOG_PAGE_LIMIT,
              })
              .catch((): SessionsListResult => ({ items: [] }))
            return {
              agentRef,
              sessions: serverResult.items.filter(session => session.agent === agentRef),
            }
          })
        )
        if (cancelled) return
        for (const group of sessionGroups) {
          seedSessionSnapshots(fsm, group.agentRef, group.sessions)
        }
        setLatestChatSessions(previous => {
          const serverByKey = new Map<string, SessionsListResult['items'][number]>()
          for (const group of sessionGroups) {
            for (const session of group.sessions) {
              serverByKey.set(`${group.agentRef}:${session.chatId}`, session)
            }
          }
          // Cases C/D/E/F (§2.2): server-authoritative title for cached entries,
          // unless a local rename is pending for that (agentRef, chatId).
          const reconciled = previous.map(item => {
            const server = serverByKey.get(`${item.agentRef}:${item.id}`)
            if (!server) return item
            const { title } = resolveSessionTitle({
              inCache: true,
              localTitle: item.title,
              serverTitle: server.title,
              pendingRename: pendingRenameStateFor(item.agentRef, item.id),
              placeholder: remotePlaceholder(item.id),
            })
            return title === item.title ? item : { ...item, title }
          })
          const knownKeys = new Set(previous.map(item => `${item.agentRef}:${item.id}`))
          const remoteOnly: LatestSidebarChatEntry[] = []
          for (const group of sessionGroups) {
            for (const session of group.sessions) {
              const key = `${group.agentRef}:${session.chatId}`
              if (knownKeys.has(key)) continue
              knownKeys.add(key)
              // Cases A/B (§2.2): server title, else "Remote · <id>" placeholder.
              remoteOnly.push({
                id: session.chatId,
                title: resolveSessionTitle({
                  inCache: false,
                  serverTitle: session.title,
                  pendingRename: pendingRenameStateFor(group.agentRef, session.chatId),
                  placeholder: remotePlaceholder(session.chatId),
                }).title,
                createdAt: session.lastActivityAt,
                updatedAt: session.lastActivityAt,
                messageCount: knownServerMessageCount(session),
                remote: true,
                agentRef: group.agentRef,
              })
            }
          }
          return [...reconciled, ...remoteOnly].sort(byUpdatedDesc)
        })

        // §2.5: retry any rename that 404'd, now that this cross-agent poll
        // reports which sessions exist server-side.
        flushPendingRenamesRef.current(
          new Set(
            sessionGroups.flatMap(group =>
              group.sessions.map(session => `${group.agentRef}:${session.chatId}`)
            )
          )
        )
      } finally {
        if (!cancelled) {
          setLatestChatSessionsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    agentNames,
    chatStore.getIndex,
    chatStore.listSessions,
    isAuthenticated,
    loadMenuData,
    scopeKey,
    fsm,
  ])

  return {
    // State (public contract, re-exported unchanged by the parent).
    chatList,
    chatListLoading,
    chatListMoreLoading,
    chatListHasMoreRemoteSessions,
    latestChatSessions,
    latestChatSessionsLoading,
    // CRUD (public contract).
    handleCreateChat,
    handleRenameChat,
    handleRenameChatForAgent,
    applyLocalTitleOnly,
    handleDeleteChat,
    handleDeleteChatForAgent,
    // Loader + list-loading control (parent agent-selection effect).
    loadChatList,
    loadMoreChatSessions,
    setChatListLoading,
    clearList,
    // Narrow chatList ops (parent flows).
    markUnreadInList,
    clearUnreadInList,
    upsertProvisionalEntry,
    applyEntryTitle,
    applyLatestTitle,
    upsertHydratedEntry,
    removeFromList,
    bumpActivity,
    appendNewEntry,
    // Pending selection.
    readPendingSelection,
    writePendingSelection,
    clearPendingSelection,
  }
}

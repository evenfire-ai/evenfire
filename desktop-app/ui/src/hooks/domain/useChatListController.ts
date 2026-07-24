import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { ChatIndex, ChatMetadata, SessionsListResult } from '../../../../src/types'
import { scheduleAfterFirstPaint } from '../scheduleAfterFirstPaint'
import type { useChatStore } from '../useChatStore'
import { type SessionFsmEvent, type SessionFsmStore, seedSessionSnapshots } from './sessionFsm'

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
  turnCount?: number
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
}

interface UseChatListControllerParams {
  selectedAgent: string | null
  agentNames: string[]
  isAuthenticated: boolean
  loadMenuData: boolean
  chatStore: ReturnType<typeof useChatStore>
  fsm: SessionFsmStore
  host: MutableRefObject<ChatListControllerHost | null>
}

const byUpdatedDesc = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()

export function useChatListController({
  selectedAgent,
  agentNames,
  isAuthenticated,
  loadMenuData,
  chatStore,
  fsm,
  host,
}: UseChatListControllerParams) {
  // Per-agent list for the SELECTED agent (the sidebar's chat list).
  const [chatList, setChatList] = useState<SidebarChatEntry[]>([])
  const [chatListLoading, setChatListLoading] = useState(false)
  // Cross-agent "Latest sessions" list (badges live in the FSM, seeded below).
  const [latestChatSessions, setLatestChatSessions] = useState<LatestSidebarChatEntry[]>([])
  const [latestChatSessionsLoading, setLatestChatSessionsLoading] = useState(false)
  // Selection requested for an agent before its chats have loaded, consumed by
  // the parent's agent-selection effect. Ref (not state): imperative, per-agent.
  const pendingChatSelectionByAgentRef = useRef<Record<string, PendingChatSelection>>({})

  // Live `selectedAgent` for the stable callbacks below (they gate a chatList
  // write on "is this the selected agent"). A ref keeps the callbacks stable
  // while always reading the committed value at call time.
  const selectedAgentRef = useRef(selectedAgent)
  useEffect(() => {
    selectedAgentRef.current = selectedAgent
    return () => {
      if (selectedAgentRef.current === selectedAgent) {
        selectedAgentRef.current = null
      }
    }
  }, [selectedAgent])

  const loadRemainingServerSessions = useCallback(
    async (
      agentRef: string,
      initialCursor: string | undefined
    ): Promise<Awaited<ReturnType<typeof chatStore.listSessions>>['items']> => {
      const items: Awaited<ReturnType<typeof chatStore.listSessions>>['items'] = []
      const seenCursors = new Set<string>()
      let cursor = initialCursor
      while (cursor && !seenCursors.has(cursor)) {
        seenCursors.add(cursor)
        const page = await chatStore.listSessions(agentRef, { limit: 50, cursor })
        items.push(...page.items)
        cursor = page.nextCursor
      }
      return items
    },
    [chatStore.listSessions]
  )

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
    async (agentRef: string): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] }> => {
      const [index, serverResult]: [ChatIndex, SessionsListResult] = await Promise.all([
        chatStore.getIndex(agentRef),
        chatStore.listSessions(agentRef, { limit: 50 }).catch(() => ({ items: [] })),
      ])

      const localChats: SidebarChatEntry[] = index.chats
      const localIds = new Set(localChats.map(c => c.id))
      const serverSessions = serverResult.items.filter(s => s.agent === agentRef)

      // Seed sidebar session state (state/activeTaskId/pendingApproval/tokens) for
      // badges via SERVER_SNAPSHOT (D4 / §4.1 R2 owns "never degrade a live task").
      seedSessionSnapshots(fsm, agentRef, serverSessions)

      // Chats the server knows but the local cache doesn't (e.g. created on
      // another device). Post-§7.1 wipe these are normal entries — no "Remote ·"
      // label, no isRemote branch; switchToChat's unified path hydrates them.
      const fromServerOnly: SidebarChatEntry[] = serverSessions
        .filter(s => !localIds.has(s.chatId))
        .map(s => ({
          id: s.chatId,
          title: `Chat ${s.chatId.slice(0, 8)}`,
          createdAt: s.lastActivityAt,
          updatedAt: s.lastActivityAt,
          messageCount: s.turnCount * 2,
          turnCount: s.turnCount,
        }))

      const merged = [...localChats, ...fromServerOnly].sort(byUpdatedDesc)
      setChatList(merged)

      if (serverResult.nextCursor) {
        scheduleAfterFirstPaint(async () => {
          if (selectedAgentRef.current !== agentRef) return
          const additionalItems = await loadRemainingServerSessions(
            agentRef,
            serverResult.nextCursor
          )
          const additionalSessions = additionalItems.filter(session => session.agent === agentRef)
          if (!additionalSessions.length) return
          seedSessionSnapshots(fsm, agentRef, additionalSessions)
          if (selectedAgentRef.current !== agentRef) return
          setChatList(previous => {
            const knownIds = new Set(previous.map(chat => chat.id))
            const additionalChats: SidebarChatEntry[] = additionalSessions
              .filter(session => !knownIds.has(session.chatId))
              .map(session => ({
                id: session.chatId,
                title: `Chat ${session.chatId.slice(0, 8)}`,
                createdAt: session.lastActivityAt,
                updatedAt: session.lastActivityAt,
                messageCount: session.turnCount * 2,
                turnCount: session.turnCount,
              }))
            return [...previous, ...additionalChats].sort(byUpdatedDesc)
          })
        })
      }

      // Persist server freshness into the local index (spec §5.3): keeps the
      // durable sidebar order aligned with the source of truth. A pure tail
      // effect that does NOT affect this render — the merge above sorts local
      // chats by their (possibly stale) local `updatedAt`, so a chat whose
      // server `lastActivityAt` is newer only re-sorts on the next cold start
      // from this persisted reconcile. Best-effort: must never block or fail the
      // load (fully swallowed).
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

      return { index, merged }
    },
    [
      chatStore.getIndex,
      chatStore.listSessions,
      chatStore.reconcileServerSessions,
      fsm,
      loadRemainingServerSessions,
    ]
  )

  const loadChatList = useCallback(
    async (agentRef: string): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] } | null> => {
      // One retry with a short backoff: during boot a concurrent team-switch /
      // access-catalog refresh can momentarily rebind the main-process chat
      // store, rejecting `getIndex` with "Not authenticated". Swallowing that
      // transient into an empty list blanks "Latest sessions" until the agent
      // is re-selected, so give the store one chance to settle.
      for (let attempt = 0; ; attempt++) {
        try {
          return await loadChatListOnce(agentRef)
        } catch (err) {
          if (attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 300))
            continue
          }
          console.warn('[loadChatList] failed after retry, clearing list', { agentRef, err })
          setChatList([])
          return null
        }
      }
    },
    [loadChatListOnce]
  )

  // ─── Narrow chatList mutation API (called by the parent's remaining flows) ───

  /** Reset the selected agent's list (logout teardown / load failure). */
  const clearList = useCallback(() => setChatList([]), [])

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
        ? prev.map(c => (c.id === meta.id ? { ...c, title } : c))
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
      setChatList(prev => [...prev, meta])
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
    const chatId = crypto.randomUUID()
    const meta = await chatStore.createChat(agentRef, chatId)
    appendNewEntry(agentRef, meta)
    await host.current?.switchToChat(agentRef, chatId)
    host.current?.scrollChatToBottom()
  }, [chatStore, appendNewEntry, host])

  const handleRenameChatForAgent = useCallback(
    async (agentRef: string, chatId: string, newTitle: string) => {
      if (!agentRef) return
      const updatedAt = new Date().toISOString()
      await chatStore.renameChat(agentRef, chatId, newTitle)
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

  const handleRenameChat = useCallback(
    async (chatId: string, newTitle: string) => {
      const agentRef = selectedAgentRef.current
      if (!agentRef) return
      await handleRenameChatForAgent(agentRef, chatId, newTitle)
    },
    [handleRenameChatForAgent]
  )

  const handleDeleteChatForAgent = useCallback(
    async (agentRef: string, chatId: string) => {
      if (!agentRef) return
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
        const sessionGroups = await Promise.all(
          agentNames.map(async agentRef => {
            try {
              const [index, serverResult]: [ChatIndex, SessionsListResult] = await Promise.all([
                chatStore.getIndex(agentRef),
                chatStore.listSessions(agentRef, { limit: 50 }).catch(() => ({ items: [] })),
              ])
              const localChats: LatestSidebarChatEntry[] = index.chats.map(chat => ({
                ...chat,
                agentRef,
              }))
              const localIds = new Set(localChats.map(chat => chat.id))
              const remoteOnly: LatestSidebarChatEntry[] = serverResult.items
                .filter(session => session.agent === agentRef && !localIds.has(session.chatId))
                .map(session => ({
                  id: session.chatId,
                  title: `Remote · ${session.chatId.slice(0, 8)}`,
                  createdAt: session.lastActivityAt,
                  updatedAt: session.lastActivityAt,
                  messageCount: session.turnCount * 2,
                  remote: true,
                  turnCount: session.turnCount,
                  agentRef,
                }))
              // Seed this agent's session state from its server snapshot; the outer
              // agentNames.map gives the cross-agent coverage the navbar badges
              // (Running / Awaiting approval / Completed-unread) need.
              // D4 (§4.1 R2): the "snapshot never degrades a live task" rule that
              // used to live in `mergeSeededSessionStates` is now the reducer's.
              const sessions = serverResult.items.filter(session => session.agent === agentRef)
              return {
                agentRef,
                entries: [...localChats, ...remoteOnly],
                sessions,
                nextCursor: serverResult.nextCursor,
              }
            } catch {
              return {
                agentRef,
                entries: [] as LatestSidebarChatEntry[],
                sessions: [] as Awaited<ReturnType<typeof chatStore.listSessions>>['items'],
                nextCursor: undefined,
              }
            }
          })
        )
        if (cancelled) return
        setLatestChatSessions(sessionGroups.flatMap(group => group.entries).sort(byUpdatedDesc))
        for (const group of sessionGroups) {
          seedSessionSnapshots(fsm, group.agentRef, group.sessions)
        }
        void Promise.all(
          sessionGroups.map(async group => ({
            agentRef: group.agentRef,
            sessions: await loadRemainingServerSessions(group.agentRef, group.nextCursor),
          }))
        )
          .then(remainingGroups => {
            if (cancelled) return
            setLatestChatSessions(previous => {
              const knownKeys = new Set(previous.map(item => `${item.agentRef}:${item.id}`))
              const additional: LatestSidebarChatEntry[] = []
              for (const group of remainingGroups) {
                const sessions = group.sessions.filter(session => session.agent === group.agentRef)
                seedSessionSnapshots(fsm, group.agentRef, sessions)
                for (const session of sessions) {
                  const key = `${group.agentRef}:${session.chatId}`
                  if (knownKeys.has(key)) continue
                  knownKeys.add(key)
                  additional.push({
                    id: session.chatId,
                    title: `Chat ${session.chatId.slice(0, 8)}`,
                    createdAt: session.lastActivityAt,
                    updatedAt: session.lastActivityAt,
                    messageCount: session.turnCount * 2,
                    turnCount: session.turnCount,
                    remote: true,
                    agentRef: group.agentRef,
                  })
                }
              }
              return [...previous, ...additional].sort(byUpdatedDesc)
            })
          })
          .catch(() => undefined)
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
    fsm,
    loadRemainingServerSessions,
  ])

  return {
    // State (public contract, re-exported unchanged by the parent).
    chatList,
    chatListLoading,
    latestChatSessions,
    latestChatSessionsLoading,
    // CRUD (public contract).
    handleCreateChat,
    handleRenameChat,
    handleRenameChatForAgent,
    handleDeleteChat,
    handleDeleteChatForAgent,
    // Loader + list-loading control (parent agent-selection effect).
    loadChatList,
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

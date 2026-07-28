import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { ChatIndex, ChatMetadata, SessionsListResult } from '../../../../src/types'
import { scheduleAfterFirstPaint } from '../scheduleAfterFirstPaint'
import type { useChatStore } from '../useChatStore'
import { type SessionFsmEvent, type SessionFsmStore, seedSessionSnapshots } from './sessionFsm'

const SESSION_CATALOG_PAGE_LIMIT = 50

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
  shouldAutoSelectLatest: () => boolean
}

interface UseChatListControllerParams {
  selectedAgent: string | null
  agentNames: string[]
  isAuthenticated: boolean
  scopeKey: string
  loadMenuData: boolean
  chatStore: ReturnType<typeof useChatStore>
  fsm: SessionFsmStore
  host: MutableRefObject<ChatListControllerHost | null>
}

const byUpdatedDesc = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()

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
  const suppressAutoSelectionByAgentRef = useRef<Set<string>>(new Set())
  const chatListNextCursorByAgentRef = useRef<Record<string, string | null | undefined>>({})
  const chatListLoadingMoreByAgentRef = useRef<Set<string>>(new Set())
  const requestGenerationRef = useRef(0)

  useEffect(() => {
    requestGenerationRef.current += 1
  }, [isAuthenticated, scopeKey])

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
    async (agentRef: string): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] }> => {
      chatListNextCursorByAgentRef.current[agentRef] = null
      if (selectedAgentRef.current === agentRef) {
        setChatListHasMoreRemoteSessions(false)
        setChatListMoreLoading(false)
      }
      const index = await chatStore.getIndex(agentRef)
      const merged = [...index.chats].sort(byUpdatedDesc)
      setChatList(merged)

      const requestGeneration = requestGenerationRef.current
      scheduleAfterFirstPaint(async () => {
        const serverResult = await chatStore
          .listSessions(agentRef, { limit: SESSION_CATALOG_PAGE_LIMIT })
          .catch((): SessionsListResult => ({ items: [] }))
        if (
          selectedAgentRef.current !== agentRef ||
          requestGenerationRef.current !== requestGeneration
        ) {
          return
        }

        const serverSessions = serverResult.items.filter(s => s.agent === agentRef)
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
          const knownIds = new Set(dedupedPrevious.map(c => c.id))
          const fromServerOnly: SidebarChatEntry[] = serverSessions
            .filter(s => !knownIds.has(s.chatId))
            .map(s => ({
              id: s.chatId,
              title: `Chat ${s.chatId.slice(0, 8)}`,
              createdAt: s.lastActivityAt,
              updatedAt: s.lastActivityAt,
              // Older hosts omit messageCount. Keep that unknown value at zero
              // instead of fabricating two messages per turn and overstating
              // Activity totals when tool/system messages vary by session.
              messageCount: knownServerMessageCount(s),
              turnCount: s.turnCount,
            }))
          return [...dedupedPrevious, ...fromServerOnly].sort(byUpdatedDesc)
        })

        const latestServerSession = serverSessions[0]
        // A mode:none request suppresses this one deferred catalog result. Consume
        // it here, after the post-paint continuation reaches the auto-select gate,
        // instead of clearing it with the synchronous local-index selection.
        const suppressAutoSelection = suppressAutoSelectionByAgentRef.current.delete(agentRef)
        if (
          latestServerSession &&
          host.current?.getActiveChatId() === null &&
          host.current.shouldAutoSelectLatest() &&
          !suppressAutoSelection
        ) {
          void host.current.switchToChat(agentRef, latestServerSession.chatId)
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
      const serverResult = await chatStore
        .listSessions(agentRef, { limit: SESSION_CATALOG_PAGE_LIMIT, cursor }, { force: true })
        .catch(() => null)
      if (!serverResult || requestGenerationRef.current !== requestGeneration) return

      const serverSessions = serverResult.items.filter(s => s.agent === agentRef)
      if (selectedAgentRef.current !== agentRef) return

      chatListNextCursorByAgentRef.current[agentRef] = serverResult.nextCursor ?? null
      setChatListHasMoreRemoteSessions(Boolean(serverResult.nextCursor))
      seedSessionSnapshots(fsm, agentRef, serverSessions)
      setChatList(previous => {
        const dedupedPrevious = dedupeSidebarChats(previous)
        const knownIds = new Set(dedupedPrevious.map(c => c.id))
        const fromServerOnly: SidebarChatEntry[] = serverSessions
          .filter(s => !knownIds.has(s.chatId))
          .map(s => ({
            id: s.chatId,
            title: `Chat ${s.chatId.slice(0, 8)}`,
            createdAt: s.lastActivityAt,
            updatedAt: s.lastActivityAt,
            messageCount: knownServerMessageCount(s),
            turnCount: s.turnCount,
          }))
        return [...dedupedPrevious, ...fromServerOnly].sort(byUpdatedDesc)
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
  const clearList = useCallback(() => {
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
      if (selection.mode === 'none') suppressAutoSelectionByAgentRef.current.add(agentName)
      else suppressAutoSelectionByAgentRef.current.delete(agentName)
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
              .listSessions(agentRef, { limit: SESSION_CATALOG_PAGE_LIMIT })
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
          const knownKeys = new Set(previous.map(item => `${item.agentRef}:${item.id}`))
          const remoteOnly: LatestSidebarChatEntry[] = []
          for (const group of sessionGroups) {
            for (const session of group.sessions) {
              const key = `${group.agentRef}:${session.chatId}`
              if (knownKeys.has(key)) continue
              knownKeys.add(key)
              remoteOnly.push({
                id: session.chatId,
                title: `Remote · ${session.chatId.slice(0, 8)}`,
                createdAt: session.lastActivityAt,
                updatedAt: session.lastActivityAt,
                messageCount: knownServerMessageCount(session),
                remote: true,
                turnCount: session.turnCount,
                agentRef: group.agentRef,
              })
            }
          }
          return [...previous, ...remoteOnly].sort(byUpdatedDesc)
        })
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

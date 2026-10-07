import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { byUpdatedDesc, mergeCatalogPage } from '@lib/catalogMerge'
import { agentChatPlaceholder, remotePlaceholder } from '@lib/chatTitle'
import type { PendingRename } from '@lib/resolveSessionTitle'
import type {
  ChatAuthorityScope,
  ChatDeleteFence,
  ChatIndex,
  ChatMetadata,
  SessionsListResult,
} from '../../../../src/types'
import {
  httpErrorStatus,
  isAuthorizationError,
  isConfirmedHostAccessRevoked,
  isHostAvailabilityError,
  isHttpServerError,
  isInvalidSessionsCursorError,
  isNetworkError,
} from '../../lib/format'
import { scheduleAfterFirstPaint } from '../scheduleAfterFirstPaint'
import type { useChatStore } from '../useChatStore'
import { type SessionFsmEvent, type SessionFsmStore, seedSessionSnapshots } from './sessionFsm'

const SESSION_CATALOG_PAGE_LIMIT = 50

async function readSessionCatalog(
  chatStore: ReturnType<typeof useChatStore>,
  agentRef: string,
  query: Parameters<ReturnType<typeof useChatStore>['listSessions']>[1],
  options: { force?: boolean } = {}
): Promise<SessionsListResult> {
  try {
    return await chatStore.listSessions(agentRef, query, options)
  } catch (error) {
    // listSessions in the main process already refreshes an expired RPC token
    // and retries once on 401. A second uncached read also distinguishes a
    // catalog-specific denial from loss of Host authority.
    if (!isAuthorizationError(error) || isConfirmedHostAccessRevoked(error)) throw error
    return chatStore.listSessions(agentRef, query, { force: true })
  }
}

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
  beginSelectionIntent: () => number
  getSelectionIntentRevision: () => number
  clearPendingSelection: (agentRef: string, preserveSpecificChatId?: string) => void
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
  /** The catalog display name for an agent reference, used in user-facing copy. */
  agentDisplayName: (agentRef: string) => string
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
  authorityScope: ChatAuthorityScope
  loadMenuData: boolean
  chatStore: ReturnType<typeof useChatStore>
  fsm: SessionFsmStore
  host: MutableRefObject<ChatListControllerHost | null>
  isHostAccessBlocked: (agentRef: string) => boolean
  getHostAuthorityEpoch: (agentRef: string) => number
  /** Changes whenever `isHostAccessBlocked` may answer differently. */
  hostAuthorityRevision: number
  onHostAccessRevoked: (agentRef: string) => void
  onHostAuthorityUncertain: (agentRef: string) => void
}

function sortableTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

const byLastActivityDesc = (a: { lastActivityAt: string }, b: { lastActivityAt: string }) =>
  sortableTimestamp(b.lastActivityAt) - sortableTimestamp(a.lastActivityAt)

/**
 * A load-more failure the same cursor can never recover from: any client error
 * other than an authorization status (handled as authority), a request timeout
 * or a rate limit (both retryable, RFC 9110), plus the main process's own
 * status-less cursor refusal. Re-sending the cursor after a 400/404/409/410
 * only repeats the rejection, so the page chain ends here.
 */
function isTerminalCatalogCursorError(error: unknown): boolean {
  const status = httpErrorStatus(error)
  if (status === undefined) return isInvalidSessionsCursorError(error)
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 429
  )
}

function isCatalogOutageError(error: unknown): boolean {
  if (isHostAvailabilityError(error)) return false
  const status = httpErrorStatus(error)
  if (status !== undefined) return isHttpServerError(error)
  return isNetworkError(error)
}

/**
 * Classify a failed rename RPC for the pending-rename queue (spec 15 §2.5). The
 * HTTP status rides the error message as `(NNN)` (see rpcProxyClient.renameSession
 * — the raw title is never in the message). A missing status (a bare transport
 * error) is treated as a network failure.
 *  - 'not-found' (404): session not materialized server-side yet → keep pending,
 *    retry once it appears in listSessions. NOT an error; no rollback.
 *  - 'client-error' (other 4xx, such as 400 invalid title): a genuine rejection
 *    → roll the optimistic title back and toast. Authorization failures are
 *    handled separately because a generic 401/403 does not prove revocation.
 *  - 'network' (5xx / no status): transient → queue offline, retry on reconnect.
 */
function classifyRenameError(error: unknown): 'not-found' | 'client-error' | 'network' {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\((\d{3})\)/)
  const status = match ? Number(match[1]) : null
  if (status === 404) return 'not-found'
  if (status === 401 || status === 403) return 'network'
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

/** A cross-agent catalog session tagged with the agent whose page reported it. */
type LatestCatalogSession = SessionsListResult['items'][number] & { agentRef: string }

/** The selected agent's sidebar: entries keyed by chat id, "Chat <id>" placeholder. */
function mergeSelectedAgentCatalogPage(
  cached: SidebarChatEntry[],
  sessions: SessionsListResult['items'],
  agentRef: string,
  pendingRenameStateFor: (agentRef: string, chatId: string) => PendingRename
): SidebarChatEntry[] {
  return mergeCatalogPage<SidebarChatEntry, SessionsListResult['items'][number]>({
    cached,
    sessions,
    entryKey: entry => entry.id,
    sessionKey: session => session.chatId,
    entryPendingRename: entry => pendingRenameStateFor(agentRef, entry.id),
    sessionPendingRename: session => pendingRenameStateFor(agentRef, session.chatId),
    placeholderFor: agentChatPlaceholder,
    serverOnlyEntry: (session, title) => ({
      id: session.chatId,
      title,
      createdAt: session.lastActivityAt,
      updatedAt: session.lastActivityAt,
      // Older hosts omit messageCount. Keep that unknown value at zero instead
      // of fabricating two messages per turn and overstating Activity totals
      // when tool/system messages vary by session.
      messageCount: knownServerMessageCount(session),
      remote: true,
    }),
  })
}

function sameAuthorityScope(left: ChatAuthorityScope, right: ChatAuthorityScope): boolean {
  return (
    left.environmentKey === right.environmentKey &&
    left.userId === right.userId &&
    left.teamId === right.teamId
  )
}

/**
 * The identity a local deletion is bound to, identical to main's
 * `sameChatDeletionIdentity`: environment + user. The team is not part of it,
 * so a confirmed deletion keeps holding after a team switch.
 */
function sameChatDeletionIdentity(left: ChatAuthorityScope, right: ChatAuthorityScope): boolean {
  return left.environmentKey === right.environmentKey && left.userId === right.userId
}

export function deletedChatIdsForScope(index: ChatIndex, scope: ChatAuthorityScope): string[] {
  return [
    ...new Set(
      (index.deletedChatTombstones ?? [])
        .filter(tombstone => sameChatDeletionIdentity(tombstone.authorityScope, scope))
        .map(tombstone => tombstone.chatId)
    ),
  ]
}

export function useChatListController({
  selectedAgent,
  agentNames,
  isAuthenticated,
  scopeKey,
  authUserKey,
  authorityScope,
  loadMenuData,
  chatStore,
  fsm,
  host,
  isHostAccessBlocked,
  getHostAuthorityEpoch,
  hostAuthorityRevision,
  onHostAccessRevoked,
  onHostAuthorityUncertain,
}: UseChatListControllerParams) {
  // Per-agent list for the SELECTED agent (the sidebar's chat list).
  const [chatList, setChatList] = useState<SidebarChatEntry[]>([])
  const [chatListLoading, setChatListLoading] = useState(false)
  const [chatListMoreLoading, setChatListMoreLoading] = useState(false)
  const [chatListHasMoreRemoteSessions, setChatListHasMoreRemoteSessions] = useState(false)
  // Cross-agent "Latest sessions" list (badges live in the FSM, seeded below).
  const [latestChatSessions, setLatestChatSessions] = useState<LatestSidebarChatEntry[]>([])
  const [latestChatSessionsLoading, setLatestChatSessionsLoading] = useState(false)
  const catalogOfflineByAgentRef = useRef(new Set<string>())
  const catalogOfflineToastShownRef = useRef(false)
  const catalogOfflineToastQueuedRef = useRef(false)
  const catalogOfflineToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [latestCatalogMutationRevision, setLatestCatalogMutationRevision] = useState(0)
  // Selection requested for an agent before its chats have loaded, consumed by
  // the parent's agent-selection effect. Ref (not state): imperative, per-agent.
  const pendingChatSelectionByAgentRef = useRef<Record<string, PendingChatSelection>>({})
  const suppressAutoSelectionByAgentRef = useRef<Map<string, number>>(new Map())
  const suppressAutoSelectionSequenceRef = useRef(0)
  const chatListNextCursorByAgentRef = useRef<Record<string, string | null | undefined>>({})
  const chatListLoadingMoreByAgentRef = useRef<Set<string>>(new Set())
  const deletedChatIdsByAgentRef = useRef(new Map<string, Set<string>>())
  const requestGenerationRef = useRef(0)
  const authorityScopeGenerationRef = useRef(0)
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames
  const agentNamesKey = agentNames.join('\n')
  const currentAuthorityScopeRef = useRef(`${isAuthenticated}:${scopeKey}`)
  currentAuthorityScopeRef.current = `${isAuthenticated}:${scopeKey}`

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
  const authUserKeyRef = useRef(authUserKey)

  useEffect(() => {
    authUserKeyRef.current = authUserKey
  }, [authUserKey])

  const pendingRenameStateFor = useCallback((agentRef: string, chatId: string): PendingRename => {
    return pendingRenamesRef.current.get(pendingRenameKey(agentRef, chatId))?.state ?? 'none'
  }, [])

  // Indirection so the catalog loaders (defined above the queue) can trigger a
  // retry of pending renames after a listSessions poll without depending on the
  // queue's identity. Wired in an effect once the queue is defined.
  const flushPendingRenamesRef = useRef<(serverChatKeys?: Set<string>) => void>(() => {})

  useEffect(() => {
    requestGenerationRef.current += 1
    authorityScopeGenerationRef.current += 1
    deletedChatIdsByAgentRef.current.clear()
    catalogOfflineByAgentRef.current.clear()
    catalogOfflineToastShownRef.current = false
    // A toast queued for this scope must never flush into the next scope or
    // after unmount: the cleanup runs on both.
    return () => {
      if (catalogOfflineToastTimerRef.current !== null) {
        clearTimeout(catalogOfflineToastTimerRef.current)
        catalogOfflineToastTimerRef.current = null
      }
      catalogOfflineToastQueuedRef.current = false
    }
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

  const reportCatalogOffline = (agentRef: string) => {
    if (!catalogOfflineByAgentRef.current.has(agentRef)) {
      catalogOfflineByAgentRef.current.add(agentRef)
    }
    if (catalogOfflineToastShownRef.current || catalogOfflineToastQueuedRef.current) return
    catalogOfflineToastQueuedRef.current = true
    const authorityScopeGeneration = authorityScopeGenerationRef.current
    catalogOfflineToastTimerRef.current = setTimeout(() => {
      catalogOfflineToastTimerRef.current = null
      catalogOfflineToastQueuedRef.current = false
      if (authorityScopeGenerationRef.current !== authorityScopeGeneration) return
      const affectedAgents = [...catalogOfflineByAgentRef.current]
      const currentHost = host.current
      if (!currentHost || !affectedAgents.length) return
      catalogOfflineToastShownRef.current = true
      const names = affectedAgents.map(ref => currentHost.agentDisplayName(ref)).join(', ')
      currentHost.pushToast(`Chat list for ${names} is offline. Showing saved chats.`, 'info')
    }, 0)
  }

  /** A success from an earlier authority scope says nothing about this one. */
  const reportCatalogOnline = (agentRef: string, authorityScopeGeneration: number) => {
    if (authorityScopeGenerationRef.current !== authorityScopeGeneration) return
    catalogOfflineByAgentRef.current.delete(agentRef)
    if (catalogOfflineByAgentRef.current.size === 0) {
      catalogOfflineToastShownRef.current = false
    }
  }

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

  const upsertLatestChatSession = useCallback(
    (agentRef: string, chat: SidebarChatEntry) => {
      if (
        isHostAccessBlocked(agentRef) ||
        deletedChatIdsByAgentRef.current.get(agentRef)?.has(chat.id)
      )
        return
      setLatestChatSessions(previous => {
        if (deletedChatIdsByAgentRef.current.get(agentRef)?.has(chat.id)) return previous
        const next = [
          { ...chat, agentRef },
          ...previous.filter(item => item.agentRef !== agentRef || item.id !== chat.id),
        ]
        return next.sort(byUpdatedDesc)
      })
    },
    [isHostAccessBlocked]
  )

  const hideAgent = useCallback((agentRef: string) => {
    setLatestChatSessions(previous => previous.filter(chat => chat.agentRef !== agentRef))
  }, [])

  const removeLatestChatSession = useCallback((agentRef: string, chatId: string) => {
    setLatestChatSessions(previous =>
      previous.filter(item => item.agentRef !== agentRef || item.id !== chatId)
    )
  }, [])

  // A catalog request can resolve with a pre-delete snapshot just as its owning
  // component commit lands. Tombstones are imperative truth, so reproject them
  // onto the published list after every confirmed destructive mutation.
  useEffect(() => {
    setLatestChatSessions(previous =>
      previous.filter(item => !deletedChatIdsByAgentRef.current.get(item.agentRef)?.has(item.id))
    )
  }, [latestCatalogMutationRevision])

  // ─── chatList loader (agent-scoped) ───

  const loadChatListOnce = useCallback(
    async (
      agentRef: string,
      requestGeneration: number,
      selectionIntentRevisionAtRequest: number
    ): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] }> => {
      const authorityScopeGeneration = authorityScopeGenerationRef.current
      const authorityScopeAtRequest = currentAuthorityScopeRef.current
      const hostAuthorityEpoch = getHostAuthorityEpoch(agentRef)
      chatListNextCursorByAgentRef.current[agentRef] = null
      if (selectedAgentRef.current === agentRef) {
        setChatListHasMoreRemoteSessions(false)
        setChatListMoreLoading(chatListLoadingMoreByAgentRef.current.has(agentRef))
      }
      const index = await chatStore.getIndex(agentRef)
      if (
        getHostAuthorityEpoch(agentRef) !== hostAuthorityEpoch ||
        currentAuthorityScopeRef.current !== authorityScopeAtRequest ||
        isHostAccessBlocked(agentRef)
      ) {
        return { index, merged: [] }
      }
      if (
        selectedAgentRef.current !== agentRef ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return { index, merged: [...index.chats].sort(byUpdatedDesc) }
      }
      const deleted = deletedChatIdsByAgentRef.current.get(agentRef) ?? new Set<string>()
      for (const chatId of deletedChatIdsForScope(index, authorityScope)) deleted.add(chatId)
      deletedChatIdsByAgentRef.current.set(agentRef, deleted)
      const merged = index.chats.filter(chat => !deleted.has(chat.id)).sort(byUpdatedDesc)
      setChatList(merged)

      const suppressionMarkerAtRequest = suppressAutoSelectionByAgentRef.current.get(agentRef)
      scheduleAfterFirstPaint(async () => {
        let serverResult: SessionsListResult
        try {
          serverResult = await readSessionCatalog(chatStore, agentRef, {
            agent: agentRef,
            limit: SESSION_CATALOG_PAGE_LIMIT,
          })
        } catch (error) {
          if (
            authorityScopeGenerationRef.current === authorityScopeGeneration &&
            getHostAuthorityEpoch(agentRef) === hostAuthorityEpoch &&
            currentAuthorityScopeRef.current === authorityScopeAtRequest &&
            !isHostAccessBlocked(agentRef)
          ) {
            if (isConfirmedHostAccessRevoked(error)) onHostAccessRevoked(agentRef)
            else if (isAuthorizationError(error)) onHostAuthorityUncertain(agentRef)
            if (
              !isConfirmedHostAccessRevoked(error) &&
              !isAuthorizationError(error) &&
              isCatalogOutageError(error)
            )
              reportCatalogOffline(agentRef)
          }
          return
        }
        reportCatalogOnline(agentRef, authorityScopeGeneration)
        if (
          selectedAgentRef.current !== agentRef ||
          requestGenerationRef.current !== requestGeneration ||
          getHostAuthorityEpoch(agentRef) !== hostAuthorityEpoch ||
          currentAuthorityScopeRef.current !== authorityScopeAtRequest ||
          isHostAccessBlocked(agentRef)
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
          .filter(
            s =>
              s.agent === agentRef && !deletedChatIdsByAgentRef.current.get(agentRef)?.has(s.chatId)
          )
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
          if (isHostAccessBlocked(agentRef)) return []
          const visibleSessions = serverSessions.filter(
            session => !deletedChatIdsByAgentRef.current.get(agentRef)?.has(session.chatId)
          )
          const dedupedPrevious = dedupeSidebarChats(previous).filter(
            chat => !deletedChatIdsByAgentRef.current.get(agentRef)?.has(chat.id)
          )
          // §2.2 precedence (cases A-F) lives in `mergeCatalogPage`.
          return mergeSelectedAgentCatalogPage(
            dedupedPrevious,
            visibleSessions,
            agentRef,
            pendingRenameStateFor
          )
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
          currentHost.getSelectionIntentRevision() === selectionIntentRevisionAtRequest &&
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
    [
      authorityScope,
      chatStore.getIndex,
      chatStore.listSessions,
      chatStore.reconcileServerSessions,
      fsm,
      getHostAuthorityEpoch,
      isHostAccessBlocked,
      onHostAccessRevoked,
      host,
    ]
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
    const authorityScopeGeneration = authorityScopeGenerationRef.current
    const authorityScopeAtRequest = currentAuthorityScopeRef.current
    const hostAuthorityEpoch = getHostAuthorityEpoch(agentRef)
    setChatListMoreLoading(true)
    try {
      let serverResult: SessionsListResult
      try {
        serverResult = await readSessionCatalog(
          chatStore,
          agentRef,
          { agent: agentRef, limit: SESSION_CATALOG_PAGE_LIMIT, cursor },
          { force: true }
        )
      } catch (error) {
        // The sidebar's "Load more" state belongs to whichever agent is selected
        // now; a late rejection for another agent may only touch its own cursor.
        const stillShowingRequest = () =>
          selectedAgentRef.current === agentRef &&
          requestGenerationRef.current === requestGeneration
        if (
          authorityScopeGenerationRef.current === authorityScopeGeneration &&
          getHostAuthorityEpoch(agentRef) === hostAuthorityEpoch &&
          currentAuthorityScopeRef.current === authorityScopeAtRequest &&
          !isHostAccessBlocked(agentRef)
        ) {
          if (isConfirmedHostAccessRevoked(error)) onHostAccessRevoked(agentRef)
          else if (isAuthorizationError(error)) onHostAuthorityUncertain(agentRef)
          else if (isTerminalCatalogCursorError(error)) {
            chatListNextCursorByAgentRef.current[agentRef] = null
            if (stillShowingRequest()) setChatListHasMoreRemoteSessions(false)
          } else if (stillShowingRequest() && host.current) {
            // 429, 5xx, a waking Host or a transport failure: the cursor stays
            // valid and the user retries with the same button. No automatic
            // retry is scheduled.
            const currentHost = host.current
            currentHost.pushToast(
              `Couldn't load more chats for ${currentHost.agentDisplayName(agentRef)}. Try again shortly.`,
              'info'
            )
          }
          return
        }
        if (
          requestGenerationRef.current === requestGeneration &&
          getHostAuthorityEpoch(agentRef) === hostAuthorityEpoch &&
          currentAuthorityScopeRef.current === authorityScopeAtRequest &&
          selectedAgentRef.current === agentRef
        ) {
          if (isTerminalCatalogCursorError(error)) {
            chatListNextCursorByAgentRef.current[agentRef] = null
            setChatListHasMoreRemoteSessions(false)
          } else {
            setChatListHasMoreRemoteSessions(true)
          }
        }
        return
      }
      reportCatalogOnline(agentRef, authorityScopeGeneration)
      if (
        requestGenerationRef.current !== requestGeneration ||
        getHostAuthorityEpoch(agentRef) !== hostAuthorityEpoch ||
        currentAuthorityScopeRef.current !== authorityScopeAtRequest
      ) {
        return
      }

      const serverSessions = serverResult.items.filter(
        s => s.agent === agentRef && !deletedChatIdsByAgentRef.current.get(agentRef)?.has(s.chatId)
      )
      if (
        selectedAgentRef.current !== agentRef ||
        isHostAccessBlocked(agentRef) ||
        getHostAuthorityEpoch(agentRef) !== hostAuthorityEpoch ||
        currentAuthorityScopeRef.current !== authorityScopeAtRequest
      ) {
        return
      }

      chatListNextCursorByAgentRef.current[agentRef] = serverResult.nextCursor ?? null
      setChatListHasMoreRemoteSessions(Boolean(serverResult.nextCursor))
      seedSessionSnapshots(fsm, agentRef, serverSessions)
      setChatList(previous => {
        if (isHostAccessBlocked(agentRef)) return []
        const visibleSessions = serverSessions.filter(
          session => !deletedChatIdsByAgentRef.current.get(agentRef)?.has(session.chatId)
        )
        const dedupedPrevious = dedupeSidebarChats(previous).filter(
          chat => !deletedChatIdsByAgentRef.current.get(agentRef)?.has(chat.id)
        )
        // §2.2 precedence (cases A-F) lives in `mergeCatalogPage`.
        return mergeSelectedAgentCatalogPage(
          dedupedPrevious,
          visibleSessions,
          agentRef,
          pendingRenameStateFor
        )
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
  }, [
    chatStore.listSessions,
    chatStore.reconcileServerSessions,
    fsm,
    getHostAuthorityEpoch,
    isHostAccessBlocked,
    onHostAccessRevoked,
  ])

  const loadChatList = useCallback(
    async (
      agentRef: string,
      selectionIntentRevisionAtRequest: number
    ): Promise<{ index: ChatIndex; merged: SidebarChatEntry[] } | null> => {
      const requestGeneration = ++requestGenerationRef.current
      // A retry remains part of this logical load, so it must keep the selection
      // authority captured before the first attempt rather than adopt a newer intent.
      // One retry with a short backoff: during boot a concurrent team-switch /
      // access-catalog refresh can momentarily rebind the main-process chat
      // store, rejecting `getIndex` with "Not authenticated". Swallowing that
      // transient into an empty list blanks "Latest sessions" until the agent
      // is re-selected, so give the store one chance to settle.
      for (let attempt = 0; ; attempt++) {
        try {
          return await loadChatListOnce(
            agentRef,
            requestGeneration,
            selectionIntentRevisionAtRequest
          )
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
    [host, loadChatListOnce]
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
    const agentRef = selectedAgentRef.current
    if (agentRef && deletedChatIdsByAgentRef.current.get(agentRef)?.has(meta.id)) return
    setChatList(prev =>
      agentRef && deletedChatIdsByAgentRef.current.get(agentRef)?.has(meta.id)
        ? prev
        : prev.some(c => c.id === meta.id)
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
      if (deletedChatIdsByAgentRef.current.get(agentRef)?.has(meta.id)) return
      setChatList(prev => {
        if (deletedChatIdsByAgentRef.current.get(agentRef)?.has(meta.id)) return prev
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
  const clearPendingSelection = useCallback(
    (agentName: string, preserveSpecificChatId?: string) => {
      const pendingSelection = pendingChatSelectionByAgentRef.current[agentName]
      // Keep a matching intent for the agent-selection effect when a direct
      // switch and route change are committed in the same turn.
      if (
        pendingSelection?.mode === 'specific' &&
        pendingSelection.chatId === preserveSpecificChatId
      )
        return
      delete pendingChatSelectionByAgentRef.current[agentName]
    },
    []
  )
  const isChatDeleted = useCallback(
    (agentRef: string, chatId: string) =>
      deletedChatIdsByAgentRef.current.get(agentRef)?.has(chatId) ?? false,
    []
  )

  // ─── Chat CRUD ───

  const handleCreateChat = useCallback(async () => {
    const agentRef = selectedAgentRef.current
    if (!agentRef) return
    const pendingSelection = readPendingSelection(agentRef)
    const selectionIntentRevision = host.current?.beginSelectionIntent()
    host.current?.clearPendingSelection(agentRef)
    const requestGeneration = requestGenerationRef.current
    const chatId = crypto.randomUUID()
    let meta: ChatMetadata
    try {
      meta = await chatStore.createChat(agentRef, chatId)
    } catch (error) {
      // The blank New chat intent invalidated an older specific load. If creation
      // failed without a newer navigation or scope taking ownership, restore the
      // requested conversation through the controller's authorized switch path.
      if (
        pendingSelection?.mode === 'specific' &&
        selectedAgentRef.current === agentRef &&
        requestGenerationRef.current === requestGeneration &&
        selectionIntentRevision !== undefined &&
        host.current?.getSelectionIntentRevision() === selectionIntentRevision
      ) {
        try {
          await host.current?.switchToChat(agentRef, pendingSelection.chatId)
        } catch {
          // Preserve the original create error for the caller.
        }
      }
      throw error
    }
    chatStore.clearCachedRemoteData()
    if (selectedAgentRef.current !== agentRef || requestGenerationRef.current !== requestGeneration)
      return
    appendNewEntry(agentRef, meta)
    if (
      selectionIntentRevision !== undefined &&
      host.current?.getSelectionIntentRevision() !== selectionIntentRevision
    )
      return
    host.current?.markAutoSelectedChat(null)
    await host.current?.switchToChat(agentRef, chatId)
    host.current?.scrollChatToBottom()
  }, [chatStore, appendNewEntry, host, readPendingSelection])

  /**
   * Optimistic LOCAL-only title update (spec 15 §2.5 / B19). Persists to the
   * local index and both sidebar lists WITHOUT firing the rename RPC. Used by
   * the first-turn auto-title path (which must NOT sync an un-redacted client
   * title that would race the server's COALESCE) and, internally, by the
   * user-rename handler before it syncs.
   */
  const applyLocalTitleOnly = useCallback(
    async (agentRef: string, chatId: string, newTitle: string) => {
      if (!agentRef || !isAuthenticated) return
      const requestGeneration = requestGenerationRef.current
      const authorityScopeGeneration = authorityScopeGenerationRef.current
      const authorityScopeAtDelete = currentAuthorityScopeRef.current
      const stillOwned = () =>
        authorityScopeGenerationRef.current === authorityScopeGeneration &&
        currentAuthorityScopeRef.current === authorityScopeAtDelete
      const bindingGeneration = await chatStore.getBindingGeneration()
      if (!stillOwned()) return
      const updatedAt = new Date().toISOString()
      await chatStore.renameChat(agentRef, chatId, newTitle, bindingGeneration)
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
      const authorityScopeGeneration = authorityScopeGenerationRef.current
      const hostAuthorityEpoch = getHostAuthorityEpoch(entry.agentRef)
      const requestStillCurrent = () =>
        authorityScopeGenerationRef.current === authorityScopeGeneration &&
        getHostAuthorityEpoch(entry.agentRef) === hostAuthorityEpoch
      try {
        await chatStore.renameSession(entry.agentRef, entry.chatId, entry.title)
        // Only clear if this attempt still owns the key (a stale 200 must never
        // delete a newer rename's marker — that would drop its case-E protection).
        if (pendingRenamesRef.current.get(key) === entry) {
          pendingRenamesRef.current.delete(key)
        }
      } catch (error) {
        if (
          isConfirmedHostAccessRevoked(error) &&
          requestStillCurrent() &&
          !isHostAccessBlocked(entry.agentRef)
        ) {
          onHostAccessRevoked(entry.agentRef)
          if (pendingRenamesRef.current.get(key) === entry) {
            pendingRenamesRef.current.delete(key)
          }
          return
        }
        if (isAuthorizationError(error)) {
          if (
            !requestStillCurrent() ||
            isHostAccessBlocked(entry.agentRef) ||
            pendingRenamesRef.current.get(key) !== entry
          ) {
            return
          }
          let readSucceeded = false
          try {
            await chatStore.listSessions(
              entry.agentRef,
              { agent: entry.agentRef, limit: 1 },
              { force: true }
            )
            readSucceeded = true
          } catch (readError) {
            if (!requestStillCurrent() || isHostAccessBlocked(entry.agentRef)) return
            if (isConfirmedHostAccessRevoked(readError)) {
              onHostAccessRevoked(entry.agentRef)
              if (pendingRenamesRef.current.get(key) === entry) {
                pendingRenamesRef.current.delete(key)
              }
              return
            }
          }
          if (
            !requestStillCurrent() ||
            isHostAccessBlocked(entry.agentRef) ||
            pendingRenamesRef.current.get(key) !== entry
          ) {
            return
          }
          if (readSucceeded) {
            if (pendingRenamesRef.current.get(key) === entry) {
              pendingRenamesRef.current.delete(key)
              if (entry.previousTitle) {
                await applyLocalTitleOnly(entry.agentRef, entry.chatId, entry.previousTitle)
              }
            }
            host.current?.pushToast('You do not have permission to rename this chat.', 'error')
            return
          }
          // Only the structured host denial proves revocation. A generic 403
          // may be a stale/missing write capability. If the read check also
          // fails, preserve the existing uncertain-authority handling.
          onHostAuthorityUncertain(entry.agentRef)
          if (pendingRenamesRef.current.get(key) === entry) {
            entry.state = 'offline'
            entry.failureCount += 1
            if (entry.failureCount >= MAX_RENAME_SYNC_ATTEMPTS) {
              entry.retriesExhausted = true
            }
          }
          return
        }
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
    [
      chatStore,
      applyLocalTitleOnly,
      getHostAuthorityEpoch,
      host,
      isHostAccessBlocked,
      onHostAccessRevoked,
      onHostAuthorityUncertain,
    ]
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
        if (isHostAccessBlocked(entry.agentRef)) continue
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
    [attemptRenameRpc, isHostAccessBlocked]
  )

  /**
   * Explicit user rename (spec 15 §2.5 / B19): optimistic local first, then sync
   * to the server via the pending-rename queue. This is the ONLY rename path that
   * fires RPC (the auto-title path uses `applyLocalTitleOnly`).
   */
  const handleRenameChatForAgent = useCallback(
    async (agentRef: string, chatId: string, newTitle: string) => {
      if (!agentRef) return
      const authUserKeyAtRequest = authUserKeyRef.current
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
        if (authUserKeyRef.current !== authUserKeyAtRequest) return
        previousTitle = index.chats.find(c => c.id === chatId)?.title ?? ''
      }
      await applyLocalTitleOnly(agentRef, chatId, newTitle)
      if (authUserKeyRef.current !== authUserKeyAtRequest) return
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
    [authUserKey, chatStore, applyLocalTitleOnly, attemptRenameRpc]
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

  const captureChatDeleteFence = useCallback(
    async (
      agentRef: string
    ): Promise<{ agentRef: string; fence: ChatDeleteFence; hostAuthorityEpoch: number }> => {
      if (!agentRef || isHostAccessBlocked(agentRef)) {
        throw new Error('Chat deletion is unavailable while host access is blocked')
      }
      const hostAuthorityEpoch = getHostAuthorityEpoch(agentRef)
      try {
        const fence = await chatStore.captureDeleteFence(authorityScope)
        if (
          !sameAuthorityScope(fence.authorityScope, authorityScope) ||
          hostAuthorityEpoch !== getHostAuthorityEpoch(agentRef) ||
          isHostAccessBlocked(agentRef)
        ) {
          throw new Error('Chat deletion authority changed before confirmation')
        }
        return { agentRef, fence, hostAuthorityEpoch }
      } catch (error) {
        host.current?.pushToast('Could not confirm chat access. Please try again.', 'error')
        throw error
      }
    },
    [authorityScope, chatStore.captureDeleteFence, getHostAuthorityEpoch, host, isHostAccessBlocked]
  )

  const handleDeleteChatForAgent = useCallback(
    async (
      agentRef: string,
      chatId: string,
      deletion: { agentRef: string; fence: ChatDeleteFence; hostAuthorityEpoch: number }
    ) => {
      if (!agentRef) return
      if (
        deletion.agentRef !== agentRef ||
        !sameAuthorityScope(deletion.fence.authorityScope, authorityScope) ||
        deletion.hostAuthorityEpoch !== getHostAuthorityEpoch(agentRef) ||
        isHostAccessBlocked(agentRef)
      ) {
        host.current?.pushToast(
          'Delete cancelled because chat access changed. Please try again.',
          'error'
        )
        return
      }
      const requestGeneration = requestGenerationRef.current
      const authorityScopeGeneration = authorityScopeGenerationRef.current
      const authorityScopeAtDelete = currentAuthorityScopeRef.current
      const stillOwned = () =>
        authorityScopeGenerationRef.current === authorityScopeGeneration &&
        currentAuthorityScopeRef.current === authorityScopeAtDelete
      // Stop following any in-flight task for this chat first: ack tears down the
      // SSE + connect/watchdog timers, so a later terminal can't fire onTerminal
      // and resurrect the just-deleted chat file via appendAssistantMessage.
      const deletedKey = makeTaskKey(agentRef, chatId)
      // R5 teardown: CHAT_DELETED removes the FSM entry AND emits the
      // `coordinator_release` effect (tracker.ack) — so a later terminal can't
      // fire onTerminal and resurrect the just-deleted chat file. Dispatched
      // FIRST (before the delete), preserving the ack-before-delete ordering.
      host.current?.dispatchSession(deletedKey, { type: 'CHAT_DELETED' })
      let result: Awaited<ReturnType<typeof chatStore.deleteChat>>
      try {
        result = await chatStore.deleteChat(agentRef, chatId, deletion.fence)
      } catch {
        host.current?.pushToast('Could not delete the chat. Please try again.', 'error')
        return
      }
      if (!stillOwned()) return
      const deleted = deletedChatIdsByAgentRef.current.get(agentRef) ?? new Set<string>()
      deleted.add(chatId)
      deletedChatIdsByAgentRef.current.set(agentRef, deleted)
      setLatestCatalogMutationRevision(value => value + 1)
      chatStore.clearCachedRemoteData()
      host.current?.clearComposerDraft(chatId)
      removeLatestChatSession(agentRef, chatId)
      if (result.cleanupPending) {
        host.current?.pushToast(
          'Chat removed. Local transcript cleanup will retry when this team is active.',
          'info'
        )
      }
      if (requestGenerationRef.current !== requestGeneration) return
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
    [
      authorityScope,
      chatList,
      chatStore,
      getHostAuthorityEpoch,
      isHostAccessBlocked,
      removeLatestChatSession,
      handleCreateChat,
      host,
      isAuthenticated,
    ]
  )

  const handleDeleteChat = useCallback(
    async (
      chatId: string,
      deletion: { agentRef: string; fence: ChatDeleteFence; hostAuthorityEpoch: number }
    ) => {
      await handleDeleteChatForAgent(deletion.agentRef, chatId, deletion)
    },
    [handleDeleteChatForAgent]
  )

  // A hold is enforced synchronously (the published list below filters held
  // Hosts, and every in-flight read compares its Host's epoch), so holding a
  // Host needs no reload. Releasing one does: its sessions were dropped while
  // it was held, so the cross-agent list reloads when a held Host comes back.
  const [latestReloadRevision, setLatestReloadRevision] = useState(0)
  const heldAgentsRef = useRef(new Set<string>())
  useEffect(() => {
    const held = new Set(agentNamesRef.current.filter(agentRef => isHostAccessBlocked(agentRef)))
    const released = [...heldAgentsRef.current].some(
      agentRef => !held.has(agentRef) && agentNamesRef.current.includes(agentRef)
    )
    heldAgentsRef.current = held
    if (released) setLatestReloadRevision(revision => revision + 1)
  }, [agentNamesKey, hostAuthorityRevision, isHostAccessBlocked])

  // ─── Cross-agent latest-sessions loader (seeds badges via SERVER_SNAPSHOT) ───

  useEffect(() => {
    const requestedAgentNames = agentNamesRef.current
    if (!isAuthenticated || !loadMenuData || !requestedAgentNames.length) {
      setLatestChatSessions([])
      setLatestChatSessionsLoading(false)
      return
    }

    let cancelled = false
    const authorityScopeGeneration = authorityScopeGenerationRef.current
    const authorityScopeAtRequest = currentAuthorityScopeRef.current
    const hostAuthorityEpochByAgent = new Map(
      requestedAgentNames.map(agentRef => [agentRef, getHostAuthorityEpoch(agentRef)])
    )
    setLatestChatSessionsLoading(true)
    ;(async () => {
      try {
        const localGroups = await Promise.all(
          requestedAgentNames.map(async agentRef => {
            try {
              const index = await chatStore.getIndex(agentRef)
              if (
                currentAuthorityScopeRef.current !== authorityScopeAtRequest ||
                getHostAuthorityEpoch(agentRef) !== hostAuthorityEpochByAgent.get(agentRef) ||
                isHostAccessBlocked(agentRef)
              ) {
                return {
                  agentRef,
                  entries: [] as LatestSidebarChatEntry[],
                  deletedChatIds: [] as string[],
                }
              }
              return {
                agentRef,
                entries: index.chats.map(chat => ({
                  ...chat,
                  agentRef,
                })),
                deletedChatIds: deletedChatIdsForScope(index, authorityScope),
              }
            } catch {
              return {
                agentRef,
                entries: [] as LatestSidebarChatEntry[],
                deletedChatIds: [] as string[],
              }
            }
          })
        )
        if (cancelled || currentAuthorityScopeRef.current !== authorityScopeAtRequest) return
        for (const group of localGroups) {
          if (
            getHostAuthorityEpoch(group.agentRef) !==
              hostAuthorityEpochByAgent.get(group.agentRef) ||
            isHostAccessBlocked(group.agentRef)
          ) {
            continue
          }
          const deleted = deletedChatIdsByAgentRef.current.get(group.agentRef) ?? new Set<string>()
          for (const chatId of group.deletedChatIds) deleted.add(chatId)
          deletedChatIdsByAgentRef.current.set(group.agentRef, deleted)
        }
        setLatestChatSessions(
          localGroups
            .flatMap(group => group.entries)
            .filter(
              chat =>
                !isHostAccessBlocked(chat.agentRef) &&
                !deletedChatIdsByAgentRef.current.get(chat.agentRef)?.has(chat.id)
            )
            .sort(byUpdatedDesc)
        )
        setLatestChatSessionsLoading(false)

        const sessionGroups = await Promise.all(
          requestedAgentNames.map(async agentRef => {
            // This feeds only the cross-agent sidebar preview. Do not follow
            // cursors here; the selected-agent session list exposes explicit
            // on-demand pagination through `loadMoreChatSessions`.
            let serverResult: SessionsListResult
            try {
              serverResult = await readSessionCatalog(chatStore, agentRef, {
                agent: agentRef,
                limit: SESSION_CATALOG_PAGE_LIMIT,
              })
            } catch (error) {
              if (
                !cancelled &&
                authorityScopeGenerationRef.current === authorityScopeGeneration &&
                currentAuthorityScopeRef.current === authorityScopeAtRequest &&
                getHostAuthorityEpoch(agentRef) === hostAuthorityEpochByAgent.get(agentRef) &&
                !isHostAccessBlocked(agentRef)
              ) {
                if (isConfirmedHostAccessRevoked(error)) onHostAccessRevoked(agentRef)
                else if (isAuthorizationError(error)) onHostAuthorityUncertain(agentRef)
                if (
                  !isConfirmedHostAccessRevoked(error) &&
                  !isAuthorizationError(error) &&
                  isCatalogOutageError(error)
                ) {
                  reportCatalogOffline(agentRef)
                }
              }
              return { agentRef, sessions: [] as SessionsListResult['items'] }
            }
            if (
              cancelled ||
              authorityScopeGenerationRef.current !== authorityScopeGeneration ||
              currentAuthorityScopeRef.current !== authorityScopeAtRequest ||
              getHostAuthorityEpoch(agentRef) !== hostAuthorityEpochByAgent.get(agentRef) ||
              isHostAccessBlocked(agentRef)
            ) {
              return { agentRef, sessions: [] as SessionsListResult['items'] }
            }
            reportCatalogOnline(agentRef, authorityScopeGeneration)
            return {
              agentRef,
              sessions: serverResult.items.filter(
                session =>
                  session.agent === agentRef &&
                  !isHostAccessBlocked(agentRef) &&
                  !deletedChatIdsByAgentRef.current.get(agentRef)?.has(session.chatId)
              ),
            }
          })
        )
        if (cancelled || currentAuthorityScopeRef.current !== authorityScopeAtRequest) return
        for (const group of sessionGroups) {
          if (
            getHostAuthorityEpoch(group.agentRef) !==
              hostAuthorityEpochByAgent.get(group.agentRef) ||
            isHostAccessBlocked(group.agentRef)
          )
            continue
          seedSessionSnapshots(
            fsm,
            group.agentRef,
            group.sessions.filter(
              session => !deletedChatIdsByAgentRef.current.get(group.agentRef)?.has(session.chatId)
            )
          )
        }
        setLatestChatSessions(previous => {
          const sessions: LatestCatalogSession[] = []
          for (const group of sessionGroups) {
            if (
              getHostAuthorityEpoch(group.agentRef) !==
                hostAuthorityEpochByAgent.get(group.agentRef) ||
              isHostAccessBlocked(group.agentRef)
            )
              continue
            for (const session of group.sessions) {
              if (deletedChatIdsByAgentRef.current.get(group.agentRef)?.has(session.chatId))
                continue
              sessions.push({ ...session, agentRef: group.agentRef })
            }
          }
          const cached = previous.filter(
            item =>
              getHostAuthorityEpoch(item.agentRef) ===
                hostAuthorityEpochByAgent.get(item.agentRef) &&
              !isHostAccessBlocked(item.agentRef) &&
              !deletedChatIdsByAgentRef.current.get(item.agentRef)?.has(item.id)
          )
          // §2.2 precedence (cases A-F) lives in `mergeCatalogPage`; Latest keys
          // entries by (agentRef, chatId) and uses the "Remote · <id>" placeholder.
          return mergeCatalogPage<LatestSidebarChatEntry, LatestCatalogSession>({
            cached,
            sessions,
            entryKey: item => `${item.agentRef}:${item.id}`,
            sessionKey: session => `${session.agentRef}:${session.chatId}`,
            entryPendingRename: item => pendingRenameStateFor(item.agentRef, item.id),
            sessionPendingRename: session =>
              pendingRenameStateFor(session.agentRef, session.chatId),
            placeholderFor: remotePlaceholder,
            serverOnlyEntry: (session, title) => ({
              id: session.chatId,
              title,
              createdAt: session.lastActivityAt,
              updatedAt: session.lastActivityAt,
              messageCount: knownServerMessageCount(session),
              remote: true,
              agentRef: session.agentRef,
            }),
          })
        })

        // §2.5: retry any rename that 404'd, now that this cross-agent poll
        // reports which sessions exist server-side.
        flushPendingRenamesRef.current(
          new Set(
            sessionGroups.flatMap(group =>
              isHostAccessBlocked(group.agentRef)
                ? []
                : group.sessions
                    .filter(
                      session =>
                        !deletedChatIdsByAgentRef.current.get(group.agentRef)?.has(session.chatId)
                    )
                    .map(session => `${group.agentRef}:${session.chatId}`)
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
    agentNamesKey,
    chatStore.getIndex,
    chatStore.listSessions,
    isAuthenticated,
    loadMenuData,
    scopeKey,
    fsm,
    getHostAuthorityEpoch,
    isHostAccessBlocked,
    onHostAccessRevoked,
    latestReloadRevision,
  ])

  // Stable across renders whose inputs did not change, so consumers keyed on the
  // list identity do not recompute on every parent render (R1-M10).
  const visibleLatestChatSessions = useMemo(
    () => latestChatSessions.filter(session => !isHostAccessBlocked(session.agentRef)),
    // `isHostAccessBlocked` reads mutable authority state; the revision is what
    // changes when its answers do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [latestChatSessions, isHostAccessBlocked, hostAuthorityRevision]
  )

  return {
    // State (public contract, re-exported unchanged by the parent).
    chatList: selectedAgent && isHostAccessBlocked(selectedAgent) ? [] : chatList,
    chatListLoading,
    chatListMoreLoading,
    chatListHasMoreRemoteSessions,
    latestChatSessions: visibleLatestChatSessions,
    latestChatSessionsLoading,
    hideAgent,
    // CRUD (public contract).
    handleCreateChat,
    handleRenameChat,
    handleRenameChatForAgent,
    applyLocalTitleOnly,
    captureChatDeleteFence,
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
    isChatDeleted,
  }
}

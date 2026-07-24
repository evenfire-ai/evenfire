import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  type TaskKey,
  type TaskState,
  makeTaskKey,
  parseTaskKey,
  useAgentTaskTracker,
} from '@contexts/AgentTaskTrackerContext'
import {
  buildChatMessageAttachments,
  buildResponseFileAttachments,
} from '@lib/chatMessageAttachments'
import { buildComposerRequestContent } from '@lib/composerReferencesPrompt'
import type {
  ChatMessageAttachment,
  HostActivityEvent,
  HostActivityStreamEvent,
  HostMessageAttachment,
  MessageToolStep,
  SessionMessagesQuery,
} from '../../../../src/types'
import type { SessionMessagesResult } from '../../../../src/types'
import { DESKTOP_ROUTES } from '../../constants/navigation'
import {
  classifyErrorKind,
  errorRecoveryHint,
  extractAssistantReply,
  isHttp404,
  isNetworkError,
} from '../../lib/format'
import type {
  AgentApprovalNotificationTarget,
  AgentChatMessage,
  AgentConversationNotificationTarget,
  AgentMessageActivity,
  ComposerImageAttachment,
  ComposerReferenceAttachment,
  DesktopNotificationPayload,
  DesktopNotificationPermission,
  FailedAgentSend,
  NavItem,
  ProgressStep,
  TaskProgress,
  Tone,
} from '../../uiTypes'
import { turnsToChatMessages } from '../sessionAdapter'
import { useChatStore } from '../useChatStore'
import {
  type ReconcileChat,
  type ReconcileChatArgs,
  type ReconcileChatDeps,
  createReconcileChat,
} from './reconcileChat'
import {
  type SessionFsmEffect,
  type SessionFsmEvent,
  type SessionFsmStore,
  type SessionStateProjection,
  createSessionFsmStore,
  projectSessionState,
} from './sessionFsm'
import { mapTrackerStatusToProgress } from './trackerToProgress'
import type { PushNotificationInput } from './types'
import {
  type ChatListControllerHost,
  type LatestSidebarChatEntry,
  type PendingChatSelection,
  type SidebarChatEntry,
  useChatListController,
} from './useChatListController'
import { type ActiveChatVisibility, useChatNotifications } from './useChatNotifications'
import { useChatScroll } from './useChatScroll'
import { useComposerAttachments } from './useComposerAttachments'

// Re-exported from `useChatListController` (§4.4) so external importers
// (useWorkspaceController, useActivityController) keep their import site.
export type { SidebarChatEntry, LatestSidebarChatEntry }

/**
 * Per-chat session lifecycle snapshot, keyed by `makeTaskKey(agentRef, chatId)`.
 * Populated from the server (D.1 fields via listSessions / loadSessionMessages)
 * and consumed by the UI (D.5 badges/syncing/offline indicators). `syncing` is
 * true while a Phase-2 reconcile is in flight for that chat.
 *
 * Single source of truth: this is a re-exported alias of the FSM's
 * `SessionStateProjection` (sessionFsm.ts) — `projectSessionState` produces it and
 * the many existing importers keep this name.
 */
export type SessionStateLite = SessionStateProjection

const MAX_ACTIVITY_EVENTS_PER_MESSAGE = 100

/**
 * B14 cap: max number of per-message activity/progress entries retained per agent.
 * On a task terminal (§4.1 cleanup transition) the oldest entries beyond this cap
 * are pruned so the two maps can't grow unbounded across a long-lived session. The
 * most-recent N (insertion order) are kept — any still-in-flight message is among
 * them — and an evicted completed message's stepper still reloads from its
 * persisted `toolSteps` (#582 fallback in ChatThread).
 */
const MAX_MESSAGES_WITH_ACTIVITY_PER_AGENT = 50
const MESSAGE_PAGE_SIZE = 80

function serverTurnNumber(message: AgentChatMessage): number | undefined {
  if (message.serverTurnNumber !== undefined) return message.serverTurnNumber
  const match = /^turn-(\d+)-(?:user|assistant)$/.exec(message.id)
  return match ? Number(match[1]) : undefined
}

function mergeUniqueMessages(
  existing: AgentChatMessage[],
  incoming: AgentChatMessage[],
  position: 'before' | 'after' = 'after'
): AgentChatMessage[] {
  const source = position === 'before' ? [...incoming, ...existing] : [...existing, ...incoming]
  const seen = new Set<string>()
  return source.filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

/** Keep only the last `n` insertion-ordered keys of a per-message map. Returns the
 *  same reference when already within the cap (so React state stays identity-stable). */
function pruneToLastN<T>(map: Record<string, T>, n: number): Record<string, T> {
  const keys = Object.keys(map)
  if (keys.length <= n) return map
  const next: Record<string, T> = {}
  for (const key of keys.slice(keys.length - n)) next[key] = map[key]!
  return next
}

/**
 * Downsample the tracker's live `ProgressStep[]` to the minimal, serializable
 * `MessageToolStep[]` persisted on the assistant message (#582), so the progress
 * stepper's "N tools" view survives a reload. Mirrors the server projection in
 * `/messages`. Drops in-flight steps and raw previews/args.
 */
function toMessageToolSteps(steps: ProgressStep[]): MessageToolStep[] | undefined {
  const done = steps
    .filter(s => s.state === 'completed' || s.state === 'error')
    .map(s => ({
      toolName: s.toolName,
      displayName: s.displayName,
      state: s.state as 'completed' | 'error',
      ...(s.durationMs != null ? { durationMs: s.durationMs } : {}),
      ...(s.errorSummary ? { errorSummary: s.errorSummary } : {}),
    }))
  return done.length ? done : undefined
}

function withResponseFileAttachments(
  messages: AgentChatMessage[],
  attachments: ChatMessageAttachment[]
): AgentChatMessage[] {
  if (!attachments.length) return messages
  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return messages
  const existingAttachments = messages[assistantIndex]?.attachments ?? []
  const existingIds = new Set(existingAttachments.map(attachment => attachment.id))
  const newAttachments = attachments.filter(attachment => !existingIds.has(attachment.id))
  if (!newAttachments.length) return messages
  return messages.map((message, index) =>
    index === assistantIndex
      ? { ...message, attachments: [...existingAttachments, ...newAttachments] }
      : message
  )
}

async function loadTaskResultResponseFileAttachments(
  agentRef: string,
  taskId: string
): Promise<ChatMessageAttachment[]> {
  try {
    const result = await window.clerum.rpc.getTaskResult(agentRef, taskId, [agentRef])
    return buildResponseFileAttachments(result)
  } catch {
    return []
  }
}

// Shared empty maps so the selected-agent activity/progress slices keep a STABLE
// identity when the agent has no entries yet (R-F3): returning a fresh `{}` each
// render made every consumer re-render on unrelated updates (a B4 amplifier).
const EMPTY_ACTIVITY_MAP: Record<string, AgentMessageActivity> = Object.freeze({})
const EMPTY_PROGRESS_MAP: Record<string, TaskProgress> = Object.freeze({})

interface UseAgentChatControllerParams {
  selectedAgent: string | null
  agentNames: string[]
  currentTeamId: string
  currentTeamName: string
  isAuthenticated: boolean
  loadMenuData: boolean
  navItem: NavItem
  pushToast: (msg: string, tone: Tone) => void
  pushNotification: (n: PushNotificationInput) => void
  canDeliverChatResponseNotification: (
    channel: 'inApp' | 'desktop',
    context: { activeChatVisible: boolean }
  ) => boolean
  showDesktopNotification: (
    payload: DesktopNotificationPayload
  ) => Promise<DesktopNotificationPermission>
  openAgentConversationFromNotification: (
    target: AgentConversationNotificationTarget
  ) => Promise<void>
  decideApprovalFromNotification: (target: AgentApprovalNotificationTarget) => Promise<void>
}

export function useAgentChatController({
  selectedAgent,
  agentNames,
  currentTeamId,
  currentTeamName,
  isAuthenticated,
  loadMenuData,
  navItem,
  pushToast,
  pushNotification,
  canDeliverChatResponseNotification,
  showDesktopNotification,
  openAgentConversationFromNotification,
  decideApprovalFromNotification,
}: UseAgentChatControllerParams) {
  const chatStore = useChatStore()
  const tracker = useAgentTaskTracker()

  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  // Fase 2b (§4.1): the SessionFSM is now the SINGLE writer of the per-chat
  // session projection. `sessionStateByChatKey` (the public contract) is derived
  // from the reducer's map via `useSyncExternalStore` + `projectSessionState`.
  // The store instance is stable for the hook's lifetime (per-mount, so test
  // renders stay isolated).
  const fsmStore = useRef<SessionFsmStore | null>(null)
  if (!fsmStore.current) fsmStore.current = createSessionFsmStore()
  const fsm = fsmStore.current
  const fsmMap = useSyncExternalStore(fsm.subscribe, fsm.getSnapshot)
  // §4.4 / §5d: the whole sidebar chat-list subsystem — the per-agent `chatList`
  // (+loading) and its loader, the cross-agent "Latest sessions" list, the
  // pending-selection ref, chat CRUD, and the narrow mutation API the flows below
  // call — lives in useChatListController. The active-chat concerns CRUD needs
  // (switchToChat/scrollChatToBottom/dispatchSession/clearComposerDraft/the live
  // activeChatId) are injected through `chatListHostRef`, filled each render once
  // those parent callbacks are defined (created here so the hook can receive it).
  const chatListHostRef = useRef<ChatListControllerHost | null>(null)
  const chatListCtl = useChatListController({
    selectedAgent,
    agentNames,
    isAuthenticated,
    loadMenuData,
    chatStore,
    fsm,
    host: chatListHostRef,
  })
  const {
    chatList,
    chatListLoading,
    latestChatSessions,
    latestChatSessionsLoading,
    loadChatList,
    setChatListLoading,
    clearList,
    markUnreadInList,
    clearUnreadInList,
    upsertProvisionalEntry,
    applyEntryTitle,
    applyLatestTitle,
    upsertHydratedEntry,
    removeFromList,
    bumpActivity,
    appendNewEntry,
    readPendingSelection,
    writePendingSelection,
    clearPendingSelection,
  } = chatListCtl
  const [chatMessages, setChatMessages] = useState<AgentChatMessage[]>([])
  const [chatMessagesLoading, setChatMessagesLoading] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false)
  const loadedLocalMessageCountRef = useRef(0)

  const [activityByAgentMessage, setActivityByAgentMessage] = useState<
    Record<string, Record<string, AgentMessageActivity>>
  >({})
  const [progressByAgentMessage, setProgressByAgentMessage] = useState<
    Record<string, Record<string, TaskProgress>>
  >({})

  const [agentSending, setAgentSending] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [failedAgentSend, setFailedAgentSend] = useState<FailedAgentSend | null>(null)

  const activityUnsubByAgentRef = useRef<Record<string, () => Promise<void>>>({})
  const activityInFlightByAgentRef = useRef<Record<string, string[]>>({})
  const activityTaskToMessageByAgentRef = useRef<Record<string, Record<string, string>>>({})
  const agentSendInFlightRef = useRef(false)
  // (Phase-2 AbortController + `recoveringTaskIdByKeyRef` removed in Fase 5b: the
  // reconcile gate's per-call `isRelevant` covers the A→B→A abort, and the
  // epoch-anchored zombie-ack in `settleIdle` (R2) covers the residual-recreated-
  // during-await case without taskId bookkeeping.)
  // D.5 / D.4-AC11: the user input behind each in-flight task (so a "ghost"
  // terminal can offer a one-click Resend) now lives in the coordinator with an
  // explicit lifecycle (spec §4.2, B15) — `tracker.setResend`/`getResend`, cleared
  // on `release`. No longer a hook-owned ref (B15/B16 shed one of the two refs).
  const activeChatVisibilityRef = useRef<ActiveChatVisibility>({
    activeChatId: null,
    currentTeamId,
    navItem,
    selectedAgent,
  })
  // Latest `pushToast` for the hoisted tracker callbacks (onTrackerTerminal reads
  // it) so that `tracker.setCallbacks` can run once (cross-ref D.3 M1) without
  // closing over a stale toast fn. Assigned in an effect, not the render body
  // (closes R-F12): the `useRef` initializer already holds the mount-time value
  // and onTrackerTerminal can only fire after the tracker callbacks are
  // registered in a later effect, so no read ever precedes the first assignment.
  const liveDepsRef = useRef({ pushToast })
  useEffect(() => {
    liveDepsRef.current = { pushToast }
  }, [pushToast])

  // §4.3 single-flight reconciler. Created ONCE (its single-flight/coalescing
  // state must survive re-renders), reading live branch callbacks through a ref
  // (assigned in an effect, not the render body — R-F12) so the instance stays
  // stable while the closures it calls track the latest state.
  const reconcileBranchesRef = useRef<{
    loadSessionMessages: (
      agentRef: string,
      chatId: string,
      query?: SessionMessagesQuery
    ) => Promise<SessionMessagesResult>
    attachLiveTask: ReconcileChatDeps['attachLiveTask']
    settleIdle: ReconcileChatDeps['settleIdle']
    evictChat: ReconcileChatDeps['evictChat']
  } | null>(null)
  const reconcileChatRef = useRef<ReconcileChat | null>(null)
  if (!reconcileChatRef.current) {
    reconcileChatRef.current = createReconcileChat({
      fsm,
      loadSessionMessages: (agentRef, chatId, query) =>
        reconcileBranchesRef.current!.loadSessionMessages(agentRef, chatId, query),
      attachLiveTask: (chatKey, resp, epoch, stillRelevant) =>
        reconcileBranchesRef.current!.attachLiveTask(chatKey, resp, epoch, stillRelevant),
      settleIdle: (chatKey, resp, epoch, hint, stillRelevant) =>
        reconcileBranchesRef.current!.settleIdle(chatKey, resp, epoch, hint, stillRelevant),
      evictChat: chatKey => reconcileBranchesRef.current!.evictChat(chatKey),
      isNetworkError,
      isHttp404,
      telemetry: (event, data) => console.log(`[telemetry] ${event}`, data),
    })
  }
  const reconcileChat = useCallback(
    (chatKey: string, args: ReconcileChatArgs) => reconcileChatRef.current!(chatKey, args),
    []
  )

  // GAP-D1 (§4.5-4): OS sleep/resume or screen-unlock leaves SSE sockets dead
  // before the 30s watchdog or the bridge reconnect notices. On the `system:resume`
  // tick, reconcile every chat whose FSM phase is not `idle` (matrix §5:
  // "reconcile de todos los chats con phase !== idle") — a single-flight,
  // idempotent `reconcileChat` that re-attaches a still-live task or settles a
  // finished one. `offline` chats are included: resume is exactly when the network
  // is likely back, and the reconcile falls back to offline on its own if it is
  // still down. Subscribed once: `fsm` and `reconcileChatRef` are render-stable
  // refs, read live at fire time.
  useEffect(() => {
    const unsub = window.clerum.system?.onResume?.(() => {
      const snapshot = fsm.getSnapshot()
      for (const [chatKey, entry] of Object.entries(snapshot)) {
        if (entry.phase === 'idle') continue
        void reconcileChatRef.current?.(chatKey, {
          reason: 'system_resume',
          taskIdHint: entry.activeTaskId,
        })
      }
    })
    return () => unsub?.()
  }, [fsm])

  // Per-chat view state: clearing a stale send-error/resend banner as the user
  // resumes typing OR adds/updates a composer attachment. Defined before the
  // composer hook so it can be handed in as `clearSendError`.
  const clearComposerSendError = useCallback(() => {
    if (agentError) setAgentError(null)
    if (failedAgentSend) setFailedAgentSend(null)
  }, [agentError, failedAgentSend])

  // Selected-agent activity/progress slices — memoized with a shared EMPTY
  // constant so an agent with no entries keeps a stable identity (R-F3).
  const activityByMessageId = useMemo(
    () =>
      selectedAgent
        ? (activityByAgentMessage[selectedAgent] ?? EMPTY_ACTIVITY_MAP)
        : EMPTY_ACTIVITY_MAP,
    [activityByAgentMessage, selectedAgent]
  )
  const progressByMessageId = useMemo(
    () =>
      selectedAgent
        ? (progressByAgentMessage[selectedAgent] ?? EMPTY_PROGRESS_MAP)
        : EMPTY_PROGRESS_MAP,
    [progressByAgentMessage, selectedAgent]
  )

  const {
    composerImageAttachments,
    composerReferenceAttachments,
    resetComposerAttachments,
    clearComposerAfterSend,
    clearComposerDraft,
    handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment,
  } = useComposerAttachments({ selectedAgent, clearSendError: clearComposerSendError })

  const { chatEndRef, scrollChatToBottom } = useChatScroll({
    selectedAgent,
    chatMessages,
    agentSending,
    activeChatProgress: progressByMessageId,
  })

  const { pushAssistantReplyNotification, pushApprovalNotification, resetReplyNotificationDedupe } =
    useChatNotifications({
      activeChatVisibilityRef,
      currentTeamId,
      currentTeamName,
      pushNotification,
      canDeliverChatResponseNotification,
      showDesktopNotification,
      openAgentConversationFromNotification,
      decideApprovalFromNotification,
    })

  // Public projection (§4.1): the sidebar/header read `sessionStateByChatKey`
  // exactly as before — it is now derived from the FSM map, keeping the shape.
  const sessionStateByChatKey = useMemo<Record<string, SessionStateLite>>(() => {
    const out: Record<string, SessionStateLite> = {}
    for (const [key, entry] of Object.entries(fsmMap)) {
      out[key] = projectSessionState(entry)
    }
    return out
  }, [fsmMap])

  // Effects module (§4.1 / §4.7): the ONLY place that acts on the reducer's pure
  // effect descriptors — unread mirror to disk (GAP-N2), approval-notification
  // emission with (taskId,requestId) dedupe (GAP-N3), coordinator release (R5).
  const runSessionEffects = useCallback(
    (chatKey: string, effects: SessionFsmEffect[]) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'mark_unread': {
            const { agentRef, chatId } = parseTaskKey(chatKey)
            void chatStore.markUnreadTerminal(agentRef, chatId)
            markUnreadInList(chatId)
            break
          }
          case 'clear_unread': {
            const { agentRef, chatId } = parseTaskKey(chatKey)
            void chatStore.clearUnreadTerminal(agentRef, chatId)
            clearUnreadInList(chatId)
            break
          }
          case 'emit_approval_notification': {
            const { agentRef, chatId } = parseTaskKey(chatKey)
            pushApprovalNotification({
              agentName: agentRef,
              chatId,
              taskId: effect.taskId,
              requestId: effect.requestId,
              text: effect.displayName,
              displayName: effect.displayName,
            })
            break
          }
          case 'coordinator_release':
            tracker.ack(chatKey as TaskKey)
            break
          case 'schedule_reconcile':
            // §4.3: the FSM's reconcile order routes to the single-flight
            // `reconcileChat` gate. Fires for events dispatched through THIS effects
            // runner that emit `schedule_reconcile` — the `window 'online'` →
            // BACK_ONLINE recovery above. The approval-decision path reconciles via
            // `decideApproval`'s own `reconcile` dep (approvalDecision.ts).
            void reconcileChatRef.current?.(chatKey, { reason: effect.reason })
            break
        }
      }
    },
    [
      chatStore.markUnreadTerminal,
      chatStore.clearUnreadTerminal,
      markUnreadInList,
      clearUnreadInList,
      pushApprovalNotification,
      tracker,
    ]
  )

  const dispatchSession = useCallback(
    (chatKey: string, event: SessionFsmEvent) => {
      const effects = fsm.dispatch(chatKey, event)
      if (effects.length) runSessionEffects(chatKey, effects)
      // B14 (§4.1 cleanup): a task terminal is the natural GC point — prune the
      // agent's per-message activity/progress maps back under the cap.
      if (event.type === 'STREAM_TERMINAL') {
        const { agentRef } = parseTaskKey(chatKey)
        setActivityByAgentMessage(prev => {
          const byMessage = prev[agentRef]
          if (!byMessage) return prev
          const pruned = pruneToLastN(byMessage, MAX_MESSAGES_WITH_ACTIVITY_PER_AGENT)
          return pruned === byMessage ? prev : { ...prev, [agentRef]: pruned }
        })
        setProgressByAgentMessage(prev => {
          const byMessage = prev[agentRef]
          if (!byMessage) return prev
          const pruned = pruneToLastN(byMessage, MAX_MESSAGES_WITH_ACTIVITY_PER_AGENT)
          return pruned === byMessage ? prev : { ...prev, [agentRef]: pruned }
        })
      }
    },
    [fsm, runSessionEffects]
  )

  // §4.1 BACK_ONLINE dispatcher: when the OS reports the network is back, dispatch
  // BACK_ONLINE for every chat currently parked `offline`. The event's
  // `schedule_reconcile` effect runs through `dispatchSession` → `runSessionEffects`
  // → reconcileChat, re-deriving server truth and lifting the offline banner. This
  // is the "auto-recovery" the reconcile 'offline' branch relies on.
  useEffect(() => {
    const handleOnline = () => {
      for (const [chatKey, entry] of Object.entries(fsm.getSnapshot())) {
        if (entry.phase === 'offline') {
          dispatchSession(chatKey, { type: 'BACK_ONLINE' })
        }
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [fsm, dispatchSession])

  useEffect(() => {
    activeChatVisibilityRef.current = {
      activeChatId,
      currentTeamId,
      navItem,
      selectedAgent,
    }
  }, [activeChatId, currentTeamId, navItem, selectedAgent])

  // Cleanup activity streams on unmount
  useEffect(() => {
    return () => {
      const streams = Object.values(activityUnsubByAgentRef.current)
      for (const stop of streams) {
        void stop().catch(() => undefined)
      }
      activityUnsubByAgentRef.current = {}
      activityInFlightByAgentRef.current = {}
      activityTaskToMessageByAgentRef.current = {}
    }
  }, [])

  // Clear the per-chat error/resend banner on agent change. Composer attachments
  // are cleared by `useComposerAttachments`' own selectedAgent effect.
  useEffect(() => {
    setAgentError(null)
    setFailedAgentSend(null)
  }, [selectedAgent])

  const stopAllActivityStreams = useCallback(async () => {
    const streams = Object.values(activityUnsubByAgentRef.current)
    await Promise.all(streams.map(stop => stop().catch(() => undefined)))
    activityUnsubByAgentRef.current = {}
    activityInFlightByAgentRef.current = {}
    activityTaskToMessageByAgentRef.current = {}
  }, [])

  const resetChat = useCallback(() => {
    setActivityByAgentMessage({})
    setProgressByAgentMessage({})
    resetComposerAttachments()
    activeChatVisibilityRef.current = {
      ...activeChatVisibilityRef.current,
      activeChatId: null,
    }
    setActiveChatId(null)
    clearList()
    // R-F13 renderer half (spec §4.5-3): tear down EVERY tracked task so a late
    // terminal (a stream that reconnects post-logout and 401s) can't run side
    // effects — append a message, push a toast — after the session is gone. The
    // main-process half (`stopAllStreams` on logout) is Fase 4.
    tracker.releaseAll()
    // Abort any in-flight reconcile so a run mid-backoff can't resurrect a
    // just-cleared tracker/FSM entry after this teardown (security review).
    reconcileChatRef.current?.reset()
    // Drop per-chat session lifecycle so the badge map can't accumulate dead
    // agent/chat keys across login/logout cycles.
    fsm.reset()
    // Clear the reply-notification dedupe set so taskIds don't accumulate across
    // login/logout / team-switch cycles (security review, hygiene).
    resetReplyNotificationDedupe()
    chatStore.clearCachedRemoteData()
    setChatMessages([])
    setChatMessagesLoading(false)
    setHasOlderMessages(false)
    setOlderMessagesLoading(false)
    loadedLocalMessageCountRef.current = 0
    // The error/resend banner is per-chat view state — drop it when the active
    // chat is torn down (logout / unauth boot) so it can't survive into the next.
    setAgentError(null)
    setFailedAgentSend(null)
  }, [
    resetComposerAttachments,
    clearList,
    tracker,
    fsm,
    resetReplyNotificationDedupe,
    chatStore.clearCachedRemoteData,
  ])

  // Unified switch (post-D.4): cache-first render → server reconcile → tracker
  // rejoin. No `isRemote` branch — the server is the source of truth for every
  // chat, and a task in flight is rejoined via the tracker D.3 already mounts.
  const switchToChat = useCallback(
    async (agentRef: string, chatId: string) => {
      activeChatVisibilityRef.current = {
        ...activeChatVisibilityRef.current,
        activeChatId: chatId,
        currentTeamId,
        selectedAgent: agentRef,
      }
      setActiveChatId(chatId)
      setChatMessages([])
      setChatMessagesLoading(true)
      setHasOlderMessages(false)
      loadedLocalMessageCountRef.current = 0
      // The error/resend banner is per-chat view state, not global: clear it on
      // every chat switch (same-agent switches don't trip the selectedAgent
      // cleanup effect, so without this a stream error from chat A would bleed
      // into chat B). The Phase-2 reconcile below re-derives state for this chat.
      setAgentError(null)
      setFailedAgentSend(null)
      await chatStore.setLastActive(agentRef, chatId)

      const key = makeTaskKey(agentRef, chatId)

      // Renderer-local relevance guard for a fast A→B→A switch: THIS switch's
      // reconcile is aborted the moment the user switches away. Passed into
      // `reconcileChat` as a per-call `isRelevant` (replaces the Phase-2
      // AbortController) so a background reconcile — system:resume, or a bell
      // approval on a NON-visible chat — is never subject to an active-chat guard.
      const isStillActive = () => activeChatVisibilityRef.current.activeChatId === chatId

      // PHASE 1 — render only the newest local page. The authoritative reconcile
      // below requests a delta after the newest cached server turn.
      const cached = await chatStore
        .loadMessages(agentRef, chatId, MESSAGE_PAGE_SIZE)
        .catch(() => [])
      if (!isStillActive()) return
      loadedLocalMessageCountRef.current = cached.length
      setHasOlderMessages(cached.length === MESSAGE_PAGE_SIZE)
      setChatMessages(cached as AgentChatMessage[])
      // Phase 1 rendered the cache → clear the blocking spinner. The reconcile
      // runs under the `syncing` indicator (RECONCILE_STARTED, dispatched by the
      // reconcile gate) instead.
      setChatMessagesLoading(false)
      // D.5: opening the chat clears its "completed_unread" badge. CHAT_OPENED
      // resets the FSM's `unreadTerminal` flag so a LATER hidden terminal re-marks
      // (without it the flag is write-once-true and the badge never reappears) and
      // its `clear_unread` effect mirrors the clear to disk+sidebar. The
      // unconditional clear below ALSO runs because on a cold reload the FSM flag
      // is fresh-`false` while the persisted disk badge is `true` — CHAT_OPENED's
      // flag-gated effect wouldn't fire, so the badge must still be cleared here.
      dispatchSession(key, { type: 'CHAT_OPENED' })
      void chatStore.clearUnreadTerminal(agentRef, chatId)
      clearUnreadInList(chatId)
      scrollChatToBottom()

      // A deliberate user re-open grants a fresh re-rejoin quota — the cap only
      // exists to stop the automatic stream-loss → rejoin loop (P1-stall). A
      // capped chat therefore clears its offline banner when reopened + reconciled
      // clean.
      tracker.resetRejoinAttempts(key)

      // PHASE 2/3 — the single reconcile gate (§4.3) owns fetch+retry, 404 evict,
      // offline, the SERVER_SNAPSHOT, the idle replace (auto-title / S4 upsert /
      // epoch-anchored zombie-ack) and the live rejoin (approval re-seed).
      // `taskIdHint` = the pre-await zombie's task, which drives the durable
      // getTaskResult fallback + response-file attachment load; the zombie-ack
      // itself no longer needs a taskId to match (R2's epoch replaces the old
      // `recoveringTaskIdByKeyRef` bookkeeping).
      //
      // The gate re-reads the same bounded local page inside hydrate so an SSE
      // terminal that lands between Phase 1 and reconciliation is included
      // without transferring the complete local transcript over IPC. Note
      // (best-effort): `reconcileChat` is single-flight per key — if a background
      // reconcile is already in flight for THIS key, this call coalesces onto it
      // and its `isRelevant`/`taskIdHint` are ignored; `hydrateActiveChatFromServer`'s
      // own `isActive()` guard still prevents rendering into the wrong chat.
      const zombieBefore = tracker.get(key)
      const latestCachedTurn = cached.reduce<number | undefined>((latest, message) => {
        const current = serverTurnNumber(message as AgentChatMessage)
        return current === undefined ? latest : Math.max(latest ?? 0, current)
      }, undefined)
      await reconcileChat(key, {
        reason: 'switch_to_chat',
        taskIdHint: zombieBefore?.taskId,
        isRelevant: isStillActive,
        messagesQuery: {
          limit: MESSAGE_PAGE_SIZE,
          ...(latestCachedTurn !== undefined ? { afterTurn: latestCachedTurn } : {}),
        },
      })
    },
    [
      currentTeamId,
      dispatchSession,
      tracker,
      reconcileChat,
      scrollChatToBottom,
      clearUnreadInList,
      chatStore.setLastActive,
      chatStore.loadMessages,
      chatStore.clearUnreadTerminal,
    ]
  )

  // §5d: chat CRUD (handleCreateChat / handleRename[ForAgent] / handleDelete[ForAgent])
  // now lives in `useChatListController` — it owns both lists and mutates them
  // in sync. The active-chat concerns it needs (switchToChat, scrollChatToBottom,
  // dispatchSession, clearComposerDraft, the live activeChatId) reach it through
  // `chatListHostRef`, assigned just below now that switchToChat is defined.
  const {
    handleCreateChat,
    handleRenameChat,
    handleRenameChatForAgent,
    handleDeleteChat,
    handleDeleteChatForAgent,
  } = chatListCtl
  useEffect(() => {
    chatListHostRef.current = {
      switchToChat,
      scrollChatToBottom,
      dispatchSession,
      clearComposerDraft,
      getActiveChatId: () => activeChatId,
    }
  })

  const handleSelectChat = useCallback(
    async (chatId: string) => {
      if (!selectedAgent) return
      await switchToChat(selectedAgent, chatId)
    },
    [selectedAgent, switchToChat]
  )

  const handleLoadOlderMessages = useCallback(async () => {
    if (!selectedAgent || !activeChatId || olderMessagesLoading) return
    setOlderMessagesLoading(true)
    try {
      const visibleIds = new Set(chatMessages.map(message => message.id))
      const localPage = (await chatStore
        .loadMessages(
          selectedAgent,
          activeChatId,
          MESSAGE_PAGE_SIZE,
          loadedLocalMessageCountRef.current
        )
        .catch(() => [])) as AgentChatMessage[]
      const unseenLocal = localPage.filter(message => !visibleIds.has(message.id))
      if (unseenLocal.length) {
        loadedLocalMessageCountRef.current += localPage.length
        setChatMessages(previous => mergeUniqueMessages(previous, unseenLocal, 'before'))
        setHasOlderMessages(localPage.length === MESSAGE_PAGE_SIZE)
        return
      }

      const oldestTurn = chatMessages.reduce<number | undefined>((oldest, message) => {
        const current = serverTurnNumber(message)
        return current === undefined ? oldest : Math.min(oldest ?? current, current)
      }, undefined)
      if (oldestTurn === undefined || oldestTurn <= 1) {
        setHasOlderMessages(false)
        return
      }

      const response = await chatStore.loadSessionMessages(
        selectedAgent,
        selectedAgent,
        activeChatId,
        { limit: MESSAGE_PAGE_SIZE, beforeTurn: oldestTurn }
      )
      const older = turnsToChatMessages(response.turns) as AgentChatMessage[]
      const merged = mergeUniqueMessages(chatMessages, older, 'before')
      setChatMessages(merged)
      await chatStore.replaceMessages(selectedAgent, activeChatId, merged)
      loadedLocalMessageCountRef.current = merged.length
      setHasOlderMessages(Boolean(response.hasMoreBefore))
    } catch (error) {
      console.warn('[chat-history] failed to load older messages', {
        agentRef: selectedAgent,
        chatId: activeChatId,
        error,
      })
    } finally {
      setOlderMessagesLoading(false)
    }
  }, [
    activeChatId,
    chatMessages,
    chatStore.loadMessages,
    chatStore.loadSessionMessages,
    chatStore.replaceMessages,
    olderMessagesLoading,
    selectedAgent,
  ])

  // Agent selection → load chats
  useEffect(() => {
    if (!selectedAgent) {
      activeChatVisibilityRef.current = {
        ...activeChatVisibilityRef.current,
        activeChatId: null,
        currentTeamId,
        selectedAgent: null,
      }
      setActiveChatId(null)
      clearList()
      setChatListLoading(false)
      setChatMessages([])
      setChatMessagesLoading(false)
      setHasOlderMessages(false)
      loadedLocalMessageCountRef.current = 0
      return
    }

    let cancelled = false
    const requestedSelection = readPendingSelection(selectedAgent)
    if (requestedSelection?.mode === 'specific') {
      activeChatVisibilityRef.current = {
        ...activeChatVisibilityRef.current,
        activeChatId: requestedSelection.chatId,
        currentTeamId,
        selectedAgent,
      }
      setActiveChatId(requestedSelection.chatId)
      setChatMessages([])
      setChatMessagesLoading(true)
      setHasOlderMessages(false)
      loadedLocalMessageCountRef.current = 0
      if (requestedSelection.title) {
        upsertProvisionalEntry(
          requestedSelection.chatId,
          requestedSelection.title,
          requestedSelection.isRemote === true
        )
      }
    } else {
      activeChatVisibilityRef.current = {
        ...activeChatVisibilityRef.current,
        activeChatId: null,
        currentTeamId,
        selectedAgent,
      }
      setActiveChatId(null)
      setChatMessages([])
      setChatMessagesLoading(false)
      setHasOlderMessages(false)
      loadedLocalMessageCountRef.current = 0
    }
    setChatListLoading(true)
    ;(async () => {
      const result = await loadChatList(selectedAgent)
      if (cancelled) return
      setChatListLoading(false)
      if (!result) {
        setChatMessagesLoading(false)
        return
      }
      const { merged } = result
      const visibleChatId = activeChatVisibilityRef.current.activeChatId
      const visibleAgent = activeChatVisibilityRef.current.selectedAgent
      const staleSpecificSelection =
        requestedSelection?.mode === 'specific' && visibleChatId !== requestedSelection.chatId
      const staleLatestSelection = requestedSelection?.mode === 'latest' && Boolean(visibleChatId)
      const staleImplicitLoad = !requestedSelection
      if (
        visibleAgent === selectedAgent &&
        visibleChatId &&
        (staleSpecificSelection || staleLatestSelection || staleImplicitLoad)
      ) {
        if (requestedSelection) {
          clearPendingSelection(selectedAgent)
        }
        setChatMessagesLoading(false)
        return
      }

      if (requestedSelection?.mode === 'specific' && requestedSelection.title) {
        applyEntryTitle(requestedSelection.chatId, requestedSelection.title)
      }

      clearPendingSelection(selectedAgent)
      if (requestedSelection?.mode === 'none') {
        setChatMessagesLoading(false)
        return
      }
      if (requestedSelection?.mode === 'latest') {
        const latest = merged[0]
        if (latest) {
          await switchToChat(selectedAgent, latest.id)
        }
        setChatMessagesLoading(false)
        return
      }
      if (requestedSelection?.mode === 'specific') {
        const requested = merged.find(chat => chat.id === requestedSelection.chatId)
        if (requested) {
          await switchToChat(selectedAgent, requestedSelection.chatId)
        } else {
          // B9: the pending `specific` selection never appeared in the merged
          // list (e.g. a server-only chat surfaced by a notification while
          // `listSessions` silently failed → items:[]). The spinner was turned
          // on above (`setChatMessagesLoading(true)`); switchToChat — the only
          // thing that clears it — never runs, so the chat pane would spin
          // forever. Clear it here so the consistent empty-state renders instead.
          setChatMessagesLoading(false)
        }
        return
      }
      if (navItem === DESKTOP_ROUTES.chat) {
        const latest = merged[0]
        if (latest) {
          await switchToChat(selectedAgent, latest.id)
        }
      }
      setChatMessagesLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [currentTeamId, navItem, selectedAgent])

  const mapComposerAttachmentsToHostRequest = (
    attachments: ComposerImageAttachment[]
  ): HostMessageAttachment[] =>
    attachments.map(att => ({
      id: att.id,
      kind: 'image',
      mimeType: att.mimeType,
      encoding: 'base64',
      dataBase64: att.dataBase64,
      filename: att.name,
    }))

  // ─── Activity / progress state updaters (hoisted from sendAgentMessage so the
  //     tracker subscription effect and tracker callbacks can share them) ───

  const updateMessageActivity = useCallback(
    (
      agentName: string,
      messageId: string,
      updater: (previous: AgentMessageActivity) => AgentMessageActivity
    ) => {
      setActivityByAgentMessage(previous => {
        const byMessage = previous[agentName] || {}
        const current = byMessage[messageId] || {
          status: 'waiting',
          events: [],
          redactionCount: 0,
        }
        return {
          ...previous,
          [agentName]: { ...byMessage, [messageId]: updater(current) },
        }
      })
    },
    []
  )

  const updateMessageProgress = useCallback(
    (agentName: string, messageId: string, updater: (prev: TaskProgress) => TaskProgress) => {
      setProgressByAgentMessage(prev => {
        const agentProgress = prev[agentName] || {}
        const current = agentProgress[messageId] || {
          status: 'connecting',
          steps: [],
          currentIteration: 0,
        }
        return {
          ...prev,
          [agentName]: { ...agentProgress, [messageId]: updater(current) },
        }
      })
    },
    []
  )

  const resolveActivityMessageId = useCallback(
    (agentName: string, event: HostActivityEvent): string | null => {
      const taskId = typeof event.taskId === 'string' ? event.taskId : ''
      if (taskId && activityTaskToMessageByAgentRef.current[agentName]?.[taskId]) {
        return activityTaskToMessageByAgentRef.current[agentName]?.[taskId] || null
      }
      const inFlight = activityInFlightByAgentRef.current[agentName] || []
      const latest = inFlight[inFlight.length - 1]
      if (!latest) return null
      if (taskId) {
        activityTaskToMessageByAgentRef.current[agentName] = {
          ...(activityTaskToMessageByAgentRef.current[agentName] || {}),
          [taskId]: latest,
        }
      }
      return latest
    },
    []
  )

  const reconcileTaskOwnership = useCallback(
    (agentName: string, taskId: string, ownerMessageId: string) => {
      setActivityByAgentMessage(previous => {
        const byMessage = previous[agentName] || {}
        const nextByMessage: Record<string, AgentMessageActivity> = { ...byMessage }
        const moved: HostActivityEvent[] = []
        for (const [messageId, activity] of Object.entries(byMessage)) {
          if (messageId === ownerMessageId) continue
          const ownedElsewhere = activity.events.filter(event => event.taskId === taskId)
          if (!ownedElsewhere.length) continue
          moved.push(...ownedElsewhere)
          nextByMessage[messageId] = {
            ...activity,
            events: activity.events.filter(event => event.taskId !== taskId),
          }
        }
        if (!moved.length) return previous
        const owner = nextByMessage[ownerMessageId] || {
          status: 'waiting',
          events: [],
          redactionCount: 0,
        }
        nextByMessage[ownerMessageId] = {
          ...owner,
          taskId,
          events: [...owner.events, ...moved].slice(-MAX_ACTIVITY_EVENTS_PER_MESSAGE),
        }
        return { ...previous, [agentName]: nextByMessage }
      })
    },
    []
  )

  const maybeStopAgentActivityStream = useCallback(async (agentName: string) => {
    const inFlight = activityInFlightByAgentRef.current[agentName] || []
    if (inFlight.length) return
    const stop = activityUnsubByAgentRef.current[agentName]
    if (!stop) return
    delete activityUnsubByAgentRef.current[agentName]
    await stop().catch(() => undefined)
  }, [])

  const ensureAgentActivityStream = useCallback(
    async (agentName: string) => {
      if (activityUnsubByAgentRef.current[agentName]) return
      const unsubscribe = await window.clerum.rpc.subscribeHostActivity(
        agentName,
        [agentName],
        event => {
          const typed = event as HostActivityStreamEvent
          const inFlight = activityInFlightByAgentRef.current[agentName] || []
          if (typed.type === 'open') {
            for (const messageId of inFlight) {
              updateMessageActivity(agentName, messageId, previous => ({
                ...previous,
                status: 'streaming',
                errorMessage: undefined,
              }))
            }
            return
          }
          if (typed.type === 'activity') {
            const messageId = resolveActivityMessageId(agentName, typed.activity)
            if (!messageId) return
            updateMessageActivity(agentName, messageId, previous => ({
              ...previous,
              status: 'streaming',
              taskId: typed.activity.taskId || previous.taskId,
              events: [...previous.events, typed.activity].slice(-MAX_ACTIVITY_EVENTS_PER_MESSAGE),
              redactionCount: previous.redactionCount + (typed.activity.redactions?.length || 0),
              errorMessage: undefined,
            }))
            return
          }
          if (typed.type === 'error' || typed.type === 'closed') {
            for (const messageId of inFlight) {
              updateMessageActivity(agentName, messageId, previous => ({
                ...previous,
                status: typed.type === 'closed' ? 'reconnecting' : 'error',
                errorMessage:
                  typed.type === 'error' ? typed.message : 'Stream disconnected, reconnecting.',
              }))
            }
          }
        }
      )
      activityUnsubByAgentRef.current[agentName] = unsubscribe
    },
    [resolveActivityMessageId, updateMessageActivity]
  )

  const appendAssistantMessage = useCallback(
    async (agentName: string, chatId: string | null, message: AgentChatMessage) => {
      // Update the in-memory view FIRST (synchronously), then persist. For a
      // rejoined task the in-flight placeholder hides the moment the tracker
      // emits 'completed'; landing the reply before the await closes the visual
      // gap that would otherwise last a disk-write IPC round-trip (D.5 review #2).
      const view = activeChatVisibilityRef.current
      if (view.selectedAgent === agentName && view.activeChatId === chatId) {
        setChatMessages(previous => [...previous, message])
      }
      if (chatId) {
        try {
          await chatStore.appendMessages(agentName, chatId, [message])
        } catch {
          // persistence is best-effort; the in-memory view already updated
        }
      }
      // Best-effort: keep this from throwing so the sole awaited call in
      // onTrackerTerminal can't escape before its final tracker.ack(key) — a
      // throw here would otherwise leak the tracked (agent, chat) entry.
      try {
        pushAssistantReplyNotification(agentName, message, chatId)
      } catch {
        // notification delivery is best-effort
      }
    },
    [chatStore, pushAssistantReplyNotification]
  )

  // ─── reconcileChat branch callbacks (§4.3) ───
  // The single-flight gate above delegates the side-effectful precedence branches
  // here. These track the latest hook state; the gate reads them through
  // `reconcileBranchesRef` (assigned in the effect below), keeping the gate
  // instance — and its coalescing state — stable across renders.

  // Shared hydration (§4.3 / A.4.4): materialize the server's page into the
  // active view, append a delta when the cache has durable server turn IDs, or
  // replace once when migrating a legacy/random-ID cache. It also auto-titles a
  // fresh hydration from turn one and upserts the sidebar (S4).
  // Both reconcile branches use it: `settleIdle` (idle replace) and
  // `attachLiveTask` (render in-flight turns so a rejoin can anchor to the
  // rendered user bubble — P1-A). Returns the rendered set + whether it replaced,
  // so the live branch can anchor and the idle branch can decide the durable
  // fallback. Replace is guarded on: chat active, server strictly grew, and NO
  // live tracker entry (a running task holds an optimistic turn a replace would
  // drop) — re-checked after every await (TOCTOU).
  const hydrateActiveChatFromServer = useCallback(
    async (
      chatKey: TaskKey,
      resp: SessionMessagesResult,
      taskIdHint: string | undefined
    ): Promise<{ rendered: AgentChatMessage[]; replaced: boolean; cached: AgentChatMessage[] }> => {
      const { agentRef, chatId } = parseTaskKey(chatKey)
      const isActive = () => {
        const v = activeChatVisibilityRef.current
        return v.selectedAgent === agentRef && v.activeChatId === chatId
      }
      const cached = (await chatStore
        .loadMessages(agentRef, chatId, MESSAGE_PAGE_SIZE)
        .catch(() => [])) as AgentChatMessage[]
      if (!isActive() || tracker.get(chatKey)) return { rendered: cached, replaced: false, cached }
      const hydrated = turnsToChatMessages(resp.turns) as AgentChatMessage[]
      if (!hydrated.length) return { rendered: cached, replaced: false, cached }
      const cachedHasServerTurns = cached.some(message => serverTurnNumber(message) !== undefined)
      if (!cachedHasServerTurns) {
        setHasOlderMessages(previous => previous || Boolean(resp.hasMoreBefore))
      }
      if (!cachedHasServerTurns && cached.length > 0) {
        const responseContainsAllTurns =
          resp.totalTurns === undefined || resp.totalTurns === resp.turns.length
        if (responseContainsAllTurns && hydrated.length <= cached.length) {
          return { rendered: cached, replaced: false, cached }
        }
      }
      const newMessages = hydrated.filter(message => !cached.some(item => item.id === message.id))
      if (!newMessages.length) return { rendered: cached, replaced: false, cached }
      const hydratedWithAttachments = withResponseFileAttachments(
        newMessages,
        taskIdHint ? await loadTaskResultResponseFileAttachments(agentRef, taskIdHint) : []
      )
      if (!isActive() || tracker.get(chatKey)) return { rendered: cached, replaced: false, cached }
      const rendered = cachedHasServerTurns
        ? mergeUniqueMessages(cached, hydratedWithAttachments)
        : hydratedWithAttachments
      setChatMessages(rendered)
      const meta = await chatStore.createChat(agentRef, chatId)
      if (cachedHasServerTurns) {
        await chatStore.appendMessages(agentRef, chatId, hydratedWithAttachments)
        loadedLocalMessageCountRef.current += hydratedWithAttachments.length
      } else {
        await chatStore.replaceMessages(agentRef, chatId, rendered)
        loadedLocalMessageCountRef.current = rendered.length
      }
      // Auto-title a fresh hydration (empty cache) from the first user turn, so a
      // server-only chat doesn't keep its "Chat <id>" placeholder (A.4.4 / S4).
      let title = meta.title
      if (cached.length === 0 && (resp.oldestTurnNumber ?? resp.turns[0]?.number) === 1) {
        const firstUserInput = resp.turns.find(t => t.user_input?.trim())?.user_input?.trim() || ''
        const hydratedTitle =
          firstUserInput.length > 60
            ? firstUserInput.substring(0, firstUserInput.lastIndexOf(' ', 60) || 60) + '...'
            : firstUserInput
        if (hydratedTitle) {
          await chatStore.renameChat(agentRef, chatId, hydratedTitle)
          title = hydratedTitle
          applyLatestTitle(agentRef, chatId, hydratedTitle)
        }
      }
      // S4: upsert into the sidebar. A chat opened via a notification for the
      // already-selected agent may not be in chatList yet; a bare `.map` drops it.
      upsertHydratedEntry(meta, title)
      return { rendered, replaced: true, cached }
    },
    [
      tracker,
      chatStore.appendMessages,
      chatStore.loadMessages,
      chatStore.createChat,
      chatStore.replaceMessages,
      chatStore.renameChat,
      applyLatestTitle,
      upsertHydratedEntry,
    ]
  )

  const reconcileAttachLiveTask = useCallback<ReconcileChatDeps['attachLiveTask']>(
    async (chatKey, resp, snapshotEpoch, stillRelevant) => {
      // Staleness guard for the TRACKER (the FSM has R2, the coordinator does not):
      // if a newer local `SEND_STARTED` bumped the epoch since this reconcile's
      // fetch began, the server's `activeTaskId` is stale — calling `attach` would
      // RELEASE the fresher task's live SSE and re-open the old one (attach-clobber
      // race). Bail before touching the tracker; the SERVER_SNAPSHOT below would be
      // R2-dropped anyway. `epoch` only advances on `SEND_STARTED`, so a mismatch
      // is unambiguously "a new send took over".
      if ((fsm.getState(chatKey)?.epoch ?? 0) !== snapshotEpoch) return 'stale_drop'
      // Materialize any in-flight turns into the active view FIRST so the rejoin
      // can anchor to the rendered user bubble (P1-A). No zombie-ack on this path:
      // the residual IS the live task we're (re-)attaching, and the helper's
      // `!tracker.get` guard leaves a genuine live entry's optimistic turn intact.
      // Crucially, hydrate BEFORE the `SERVER_SNAPSHOT` below: the snapshot flips
      // the chat to `awaiting_approval`, which — during hydrate's awaits — would
      // let the sticky re-seed effect race in a `'<unknown>'`-anchored rejoin
      // before this entry exists (P1-A regression).
      const { rendered } = await hydrateActiveChatFromServer(
        chatKey as TaskKey,
        resp,
        resp.activeTaskId
      )
      // R-F13 / spec §4.5-3: the hydrate above yields (IPC round-trip). If a
      // `reset()` (logout / team-switch) or a switch-away landed during that
      // await, bail BEFORE re-opening a live stream — otherwise `tracker.attach`
      // would resurrect a task (and its SSE) in a torn-down session. `isActive`
      // can't cover this: a legitimate background rejoin is also "not active".
      if (!stillRelevant()) return 'stale_drop'
      const anchor = [...rendered].reverse().find(m => m.role === 'user')?.id
      fsm.dispatch(chatKey, {
        type: 'SERVER_SNAPSHOT',
        state: resp.state ?? 'idle',
        activeTaskId: resp.activeTaskId,
        pendingApproval: resp.pendingApproval,
        tokens: resp.tokens,
        snapshotEpoch,
      })
      // reason:'rejoin' → the coordinator consumes the bounded re-rejoin budget
      // (P1-stall guard). Idempotent when the same task is already attached.
      const attached = tracker.attach(
        chatKey as TaskKey,
        resp.activeTaskId!,
        anchor ?? '<unknown>',
        { reason: 'rejoin' }
      )
      if (!attached) {
        fsm.dispatch(chatKey, { type: 'WENT_OFFLINE', underlying: resp.state ?? 'idle' })
        return 'rejoin_capped_offline'
      }
      // No manual re-seed of the approval gate: the `SERVER_SNAPSHOT` above already
      // set the FSM projection's `pendingApproval` (the immediate optimistic paint,
      // §8-R2), which the progress mirror surfaces as `suspendedInfo`; the rejoined
      // SSE's replayed sticky `suspended` (V2) is the definitive gate. `seedSuspended`
      // is gone (§4.7.3 / §8-R2).
      return 'reconcile_rejoined'
    },
    [fsm, tracker, hydrateActiveChatFromServer]
  )

  const reconcileSettleIdle = useCallback<ReconcileChatDeps['settleIdle']>(
    async (chatKey, resp, snapshotEpoch, taskIdHint, stillRelevant) => {
      fsm.dispatch(chatKey, {
        type: 'SERVER_SNAPSHOT',
        state: 'idle',
        tokens: resp.tokens,
        snapshotEpoch,
      })
      const { agentRef, chatId } = parseTaskKey(chatKey)
      // Zombie-ack (epoch-anchored — correction > healing): the server reports
      // idle, so any residual tracker entry is a zombie (a stream-loss reconcile
      // that rejoined a still-`processing` task but whose rejoined SSE never
      // reached a clean terminal) UNLESS a fresher local `SEND_STARTED` bumped the
      // epoch DURING this reconcile's await — in which case the residual is that
      // brand-new live task and must never be torn down (P2 over-heal regression).
      // R2's epoch replaces the old taskId-matching + `recoveringTaskIdByKeyRef`
      // bookkeeping: a re-rejoin during the await does NOT bump the epoch, so its
      // residual is still acked (P2-B); only a real send does.
      const epochUnchanged = (fsm.getState(chatKey)?.epoch ?? 0) === snapshotEpoch
      if (epochUnchanged && tracker.get(chatKey as TaskKey)) tracker.ack(chatKey as TaskKey)

      // Active chat → reflect any newly-persisted server turns into the visible
      // view (replace-never-append parity with switchToChat Phase 2, A.4.4).
      const { replaced, cached } = await hydrateActiveChatFromServer(
        chatKey as TaskKey,
        resp,
        taskIdHint
      )
      if (replaced) return 'reconcile_replaced'

      // GAP-H1 durable fallback (rama 4): a task whose result the server never
      // reflected as a turn (deny pre-executor) is materialized + PERSISTED
      // locally so it survives the 10-min result TTL / host restart. Guarded so a
      // task already covered by an assistant message (turn, or a prior recovery)
      // never double-renders — R3 dedupe by `task_id` (sourceTaskId marker).
      if (!taskIdHint) return 'noop'
      if (cached.some(m => m.role === 'assistant' && m.task_id === taskIdHint)) return 'noop'
      const taskResult = await window.clerum.rpc
        .getTaskResult(agentRef, taskIdHint, [agentRef])
        .catch(() => null)
      if (!taskResult) return 'fell_through_to_resend'
      // Post-await teardown guard (parity with attachLiveTask): a `reset()` during
      // the getTaskResult await must not let the durable materialization persist a
      // message into a torn-down session's chat.
      if (!stillRelevant()) return 'noop'
      const durableError = taskResult.error
      if (durableError) {
        const message = typeof durableError === 'string' ? durableError : durableError.message
        const errorCode = typeof durableError === 'string' ? undefined : durableError.code
        const errorProvider = typeof durableError === 'string' ? undefined : durableError.provider
        await appendAssistantMessage(agentRef, chatId, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: message,
          timestamp: Date.now(),
          task_id: taskIdHint,
          isError: true,
          ...(errorCode ? { errorCode } : {}),
          ...(errorProvider ? { errorProvider } : {}),
        })
        // Loud toast parity with the stream-loss terminal path (SR-7): a durable
        // failure the stream never delivered is still a failed send. Silent on the
        // switch path is not an option — the user asked and it errored.
        liveDepsRef.current.pushToast(`Message to ${agentRef} failed: ${message}`, 'error')
        // Distinct outcome so the loud caller paints the stepper red (not green).
        return 'recovered_error'
      }
      const reply = extractAssistantReply(taskResult)
      const attachments = buildResponseFileAttachments(taskResult)
      const hasResponse =
        typeof taskResult.response === 'string' && taskResult.response.trim().length > 0
      if (hasResponse || attachments.length) {
        await appendAssistantMessage(agentRef, chatId, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
          task_id: taskIdHint,
          ...(attachments.length ? { attachments } : {}),
        })
        return 'recovered_from_task_result'
      }
      return 'fell_through_to_resend'
    },
    [fsm, tracker, hydrateActiveChatFromServer, appendAssistantMessage]
  )

  const reconcileEvictChat = useCallback<ReconcileChatDeps['evictChat']>(
    async chatKey => {
      const { agentRef, chatId } = parseTaskKey(chatKey)
      // The local cache referenced a chat the server 404s. Post-spec this
      // shouldn't happen (every chat originates from a POST the server records) →
      // treat as a stale-cache bug: log + evict locally (parity with the old
      // switchToChat 404 branch, so its characterization pin keeps warning).
      console.warn('[reconcileChat] chat unknown to server, evicting local cache', {
        agentRef,
        chatId,
      })
      tracker.release(chatKey as TaskKey)
      await chatStore.deleteChat(agentRef, chatId).catch(() => undefined)
      removeFromList(chatId)
      const view = activeChatVisibilityRef.current
      if (view.selectedAgent === agentRef && view.activeChatId === chatId) {
        activeChatVisibilityRef.current = { ...view, activeChatId: null }
        setActiveChatId(null)
        setChatMessages([])
      }
    },
    [tracker, chatStore.deleteChat, removeFromList]
  )

  useEffect(() => {
    reconcileBranchesRef.current = {
      loadSessionMessages: async (agentRef, chatId, query) => {
        const requestedQuery = query ?? { limit: MESSAGE_PAGE_SIZE }
        let response = await chatStore.loadSessionMessages(
          agentRef,
          agentRef,
          chatId,
          requestedQuery
        )
        if (requestedQuery.afterTurn === undefined || !response.hasMoreAfter) {
          return response
        }

        const turns = [...response.turns]
        const seenCursors = new Set<number>()
        let cursor = response.latestTurnNumber ?? turns.at(-1)?.number
        while (response.hasMoreAfter && cursor !== undefined && !seenCursors.has(cursor)) {
          seenCursors.add(cursor)
          response = await chatStore.loadSessionMessages(agentRef, agentRef, chatId, {
            limit: requestedQuery.limit ?? MESSAGE_PAGE_SIZE,
            afterTurn: cursor,
          })
          turns.push(...response.turns)
          cursor = response.latestTurnNumber ?? response.turns.at(-1)?.number
        }
        return {
          ...response,
          turns,
          oldestTurnNumber: turns[0]?.number,
          latestTurnNumber: turns.at(-1)?.number,
        }
      },
      attachLiveTask: reconcileAttachLiveTask,
      settleIdle: reconcileSettleIdle,
      evictChat: reconcileEvictChat,
    }
  }, [
    chatStore.loadSessionMessages,
    reconcileAttachLiveTask,
    reconcileSettleIdle,
    reconcileEvictChat,
  ])

  // ─── Tracker callbacks + subscription (the post-D.3 fire & forget glue) ───

  const onTrackerTerminal = useCallback(
    async (key: TaskKey, state: TaskState) => {
      const { agentRef, chatId } = parseTaskKey(key)
      // `task_duration_seconds` telemetry is now emitted by the coordinator
      // (`fireTerminal`, §4.8) — the lifecycle owner — so it is not duplicated here.
      const result = state.terminalResult

      // ── stream-recovery: a lost progress stream is NOT a task failure ──
      // The task is durable server-side (D.1/T2.1), so before surfacing the scary
      // "Progress stream error" + Resend, route through the single reconcile gate
      // (§4.3): rejoin a task that's still alive, replace with the durable reply if
      // it completed, or render the durable per-task result. Only a genuinely-gone
      // task falls through to today's error UX.
      if (result?.kind === 'error' && result.source === 'stream') {
        // Capture the Resend payload BEFORE any release below clears it (B15) — it
        // must outlive the reconcile so `applyFallback` (and, on a NON-visible
        // chat, the reopen reconcile) can still offer it.
        const resend = tracker.getResend(state.taskId)

        const isActive = () => {
          const v = activeChatVisibilityRef.current
          return v.selectedAgent === agentRef && v.activeChatId === chatId
        }
        // Drop the per-agent activity in-flight entry. NOT called on the rejoin
        // path — the task keeps running there, so its activity stream stays up.
        const dropActivity = () => {
          activityInFlightByAgentRef.current[agentRef] = (
            activityInFlightByAgentRef.current[agentRef] || []
          ).filter(id => id !== state.userMessageId)
          void maybeStopAgentActivityStream(agentRef)
        }
        // STREAM_TERMINAL settles the FSM to idle; when the chat is NOT visible
        // it also emits the `mark_unread` effect (badge mirror, GAP-N2). Status
        // is 'failed' here (stream-loss recovery) — the reducer only distinguishes
        // 'cancelled' (which never marks), so failed vs completed is equivalent
        // for the idle transition on a visible chat.
        const setIdle = () =>
          dispatchSession(key, {
            type: 'STREAM_TERMINAL',
            taskId: state.taskId,
            status: 'failed',
            chatVisible: isActive(),
          })
        // Today's failure UX — only when the server confirms nothing recoverable.
        // Telemetry for this recovery is emitted once by the reconcile gate (§4.8,
        // `deps.telemetry`) with the real outcome, so no manual log here.
        const applyFallback = () => {
          dropActivity()
          liveDepsRef.current.pushToast(`Message to ${agentRef} failed.`, 'error')
          updateMessageProgress(agentRef, state.userMessageId, () => ({
            taskId: state.taskId,
            status: 'error',
            steps: state.steps,
            currentIteration: state.currentIteration,
            llmElapsedMs: state.llmElapsedMs,
          }))
          updateMessageActivity(agentRef, state.userMessageId, previous => ({
            ...previous,
            taskId: state.taskId,
            status: 'error',
            errorMessage: result.message,
          }))
          if (resend && isActive()) {
            setAgentError(
              'Lost connection to the task — it may not have completed. Resend your message?'
            )
            setFailedAgentSend({
              content: resend.content,
              attachments: resend.attachments,
              references: resend.references,
              message: result.message,
              kind: 'network',
              timestamp: Date.now(),
            })
          }
          setIdle()
        }

        // Fix B — durable-task-result fallback for a pre-executor denial.
        // A budget-deny (and any pre-executor failure) is durable server-side as
        // a per-task result (`getTaskResult` → `error:{code,message,provider}`)
        // but never writes a session TURN (turns are written by the executor,
        // which never runs on a deny). So the `loadSessionMessages` reconcile
        // above can't grow past the cache and we'd wrongly fall through to the
        // scary "Resend" UX. Before that, consult the durable task result: render
        // it as a terminal message (failed or, rarely, a reply) instead. Returns
        // true when it rendered something — only then do we skip `applyFallback`.
        // Mirrors taskTracker's interpretation of `getTaskResult` (source:'failed'
        // vs a durable reply) so the rendered bubble matches the direct path.
        const recoverFromDurableTaskResult = async (): Promise<boolean> => {
          const taskResult = await window.clerum.rpc
            .getTaskResult(agentRef, state.taskId, [agentRef])
            .catch(() => null)
          if (!taskResult) return false

          // The awaits in this branch (incl. `getTaskResult` above) open a window
          // in which the user can start a NEW task on this same chat — `ack(key)`
          // already ran at the top of the handler, so the send re-entry guard no
          // longer blocks a fresh `tracker.start`. Never let this STALE task's
          // terminal render/settle stomp a fresher task's live state. Mirrors the
          // reconcile_replaced guard (`residual.taskId === state.taskId`): a fresh
          // task has a different (newer) taskId under the same key.
          const freshTaskTookOver = () => {
            const current = tracker.get(key)
            return !!current && current.taskId !== state.taskId
          }
          if (freshTaskTookOver()) return true

          const durableError = taskResult.error
          if (durableError) {
            const message = typeof durableError === 'string' ? durableError : durableError.message
            const errorCode = typeof durableError === 'string' ? undefined : durableError.code
            const errorProvider =
              typeof durableError === 'string' ? undefined : durableError.provider
            dropActivity()
            await appendAssistantMessage(agentRef, chatId, {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: message,
              timestamp: Date.now(),
              task_id: state.taskId,
              isError: true,
              ...(errorCode ? { errorCode } : {}),
              ...(errorProvider ? { errorProvider } : {}),
            })
            updateMessageProgress(agentRef, state.userMessageId, () => ({
              taskId: state.taskId,
              status: 'error',
              steps: state.steps,
              currentIteration: state.currentIteration,
              llmElapsedMs: state.llmElapsedMs,
            }))
            updateMessageActivity(agentRef, state.userMessageId, previous => ({
              ...previous,
              taskId: state.taskId,
              status: 'error',
              errorMessage: message,
            }))
            liveDepsRef.current.pushToast(`Message to ${agentRef} failed: ${message}`, 'error')
            // Settle the session to idle so it can't linger dirty (spinner /
            // "processing") until the next switchToChat — that's exactly the bug
            // this fix targets. Re-check first: a fresh task could have started
            // during the append await, and it now owns the live state (its own
            // onTerminal will settle it).
            if (!freshTaskTookOver()) setIdle()
            return true
          }
          // Rare: a durable SUCCESS reply the stream never delivered and that
          // hydration didn't surface (no turn). Render it as a normal reply.
          const reply = extractAssistantReply(taskResult)
          const attachments = buildResponseFileAttachments(taskResult)
          const hasResponse =
            typeof taskResult.response === 'string' && taskResult.response.trim().length > 0
          if (hasResponse || attachments.length) {
            dropActivity()
            await appendAssistantMessage(agentRef, chatId, {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: reply,
              timestamp: Date.now(),
              task_id: state.taskId,
              ...(attachments.length ? { attachments } : {}),
            })
            updateMessageProgress(agentRef, state.userMessageId, () => ({
              taskId: state.taskId,
              status: 'completed',
              steps: state.steps,
              currentIteration: state.currentIteration,
              llmElapsedMs: state.llmElapsedMs,
            }))
            updateMessageActivity(agentRef, state.userMessageId, previous => ({
              ...previous,
              taskId: state.taskId,
              status: 'completed',
              errorMessage: undefined,
            }))
            liveDepsRef.current.pushToast(`Message sent to ${agentRef}.`, 'success')
            if (!freshTaskTookOver()) setIdle()
            return true
          }
          // No usable durable result (pending / 404 / empty) → let the caller
          // fall through to the existing "Resend" UX (no regression).
          return false
        }

        // Repaint the stepper as done once a reconcile branch materialized the
        // reply/error (the branch's SERVER_SNAPSHOT idle is R2-ignored while the
        // FSM phase is still `processing` — `setIdle` below flips it for real).
        const paintProgressDone = () =>
          updateMessageProgress(agentRef, state.userMessageId, () => ({
            taskId: state.taskId,
            status: 'completed',
            steps: state.steps,
            currentIteration: state.currentIteration,
            llmElapsedMs: state.llmElapsedMs,
          }))

        // B11 (§4.1 R4): a stream loss on a NON-visible chat is not recovered in
        // the foreground. Mark it unread + settle the projection to idle, but DO
        // NOT release the coordinator — the task may still be live server-side and
        // its Resend payload must survive to the reopen reconcile (switchToChat →
        // reconcileChat). Recovery is deferred to reopen, avoiding N concurrent
        // background reconciles.
        if (!isActive()) {
          dropActivity()
          // setIdle → STREAM_TERMINAL(chatVisible:false) settles idle AND mirrors
          // the unread badge to disk via the `mark_unread` effect (GAP-N2).
          setIdle()
          return
        }

        // Active chat → the single reconcile gate (§4.3) owns fetch/retry, rejoin,
        // durable replace, durable per-task result and 404 evict. ack the zombie
        // FIRST so `attachLiveTask` opens a fresh SSE (idempotent-attach would
        // no-op on the dead entry); the Resend payload was already captured above.
        tracker.ack(key)
        const outcome = await reconcileChat(key, {
          reason: 'stream_lost',
          taskIdHint: state.taskId,
          isRelevant: isActive,
        })
        switch (outcome) {
          case 'reconcile_rejoined':
          case 'rejoin_capped_offline':
            // Task still live (rejoined SSE continues) or offline (WENT_OFFLINE was
            // already dispatched by the branch) — leave activity up, no terminal
            // paint; the rejoined stream's own onTerminal (or a reopen reconcile)
            // settles it.
            break
          case 'reconcile_replaced':
          case 'recovered_from_task_result':
            // The reconcile branch materialized a durable reply. Repaint the
            // stepper green and flip the FSM to idle.
            dropActivity()
            paintProgressDone()
            setIdle()
            break
          case 'recovered_error':
            // The reconcile branch rendered (and toasted) a durable ERROR (budget
            // deny etc.). Repaint the stepper + activity red — a green "completed"
            // under an error bubble would misreport (code-review Should-fix).
            dropActivity()
            updateMessageProgress(agentRef, state.userMessageId, () => ({
              taskId: state.taskId,
              status: 'error',
              steps: state.steps,
              currentIteration: state.currentIteration,
              llmElapsedMs: state.llmElapsedMs,
            }))
            updateMessageActivity(agentRef, state.userMessageId, previous => ({
              ...previous,
              taskId: state.taskId,
              status: 'error',
              errorMessage: result.message,
            }))
            setIdle()
            break
          case 'noop':
          case 'stale_drop':
            // The turn already covered the task, or the chat switched away
            // mid-reconcile — settle without re-rendering (a reopen reconcile
            // re-derives if a newer send didn't already take over via R1).
            dropActivity()
            setIdle()
            break
          case '404':
            // The reconcile evicted the chat + reset the FSM already.
            dropActivity()
            break
          case 'offline':
            // Network down (reconcile dispatched WENT_OFFLINE, phase `offline`).
            // Leave the offline banner in place — do NOT `setIdle`/Resend (that
            // would erase the offline affordance the reconcile just set up). Stop
            // the spinner; recovery comes from the hook's `window 'online'`
            // listener dispatching BACK_ONLINE (which schedules a reconcile), or a
            // later system:resume / reopen reconcile re-deriving (code-review
            // Should-fix).
            dropActivity()
            break
          case 'fell_through_to_resend':
            // settleIdle already consulted `getTaskResult` and it was empty → the
            // task is genuinely lost. Today's Resend UX.
            applyFallback()
            break
          default:
            // 'error': the session-messages fetch THREW (non-network, non-404)
            // before settleIdle could reach `getTaskResult`. A durable per-task
            // result may still exist (e.g. a budget deny) — consult it before the
            // Resend UX.
            if (!(await recoverFromDurableTaskResult())) applyFallback()
        }
        return
      }

      if (result?.kind === 'reply') {
        if (result.content && result.content !== 'Message failed') {
          const toolSteps = toMessageToolSteps(state.steps)
          await appendAssistantMessage(agentRef, chatId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: result.content,
            timestamp: Date.now(),
            task_id: state.taskId,
            ...(result.attachments?.length ? { attachments: result.attachments } : {}),
            ...(toolSteps ? { toolSteps } : {}),
          })
        }
        liveDepsRef.current.pushToast(`Message sent to ${agentRef}.`, 'success')
      } else if (result?.kind === 'error') {
        if (result.source === 'failed') {
          await appendAssistantMessage(agentRef, chatId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: result.message,
            timestamp: Date.now(),
            task_id: state.taskId,
            isError: true,
            errorCode: result.code,
            errorProvider: result.provider,
          })
          liveDepsRef.current.pushToast(`Message to ${agentRef} failed: ${result.message}`, 'error')
        } else if (result.source === 'result_fetch') {
          await appendAssistantMessage(agentRef, chatId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'Failed to retrieve task result after completion',
            timestamp: Date.now(),
            task_id: state.taskId,
            isError: true,
          })
          liveDepsRef.current.pushToast(`Failed to retrieve result for ${agentRef}.`, 'error')
        }
        // `source: 'stream'` is intercepted + reconciled at the top of this handler.
      }
      // The Resend payload is dropped by the coordinator on `release` below (B15).
      // Reflect the terminal state into progress/activity directly. The live
      // subscription also does this, but a task can finish before its chat's
      // subscribe effect attaches (freshly auto-created chat) — onTerminal always
      // runs and holds the full state, so this closes that race (idempotent).
      updateMessageProgress(agentRef, state.userMessageId, () => ({
        taskId: state.taskId,
        status: mapTrackerStatusToProgress(state.status),
        steps: state.steps,
        currentIteration: state.currentIteration,
        llmElapsedMs: state.llmElapsedMs,
        cancelReason:
          state.terminalResult?.kind === 'cancelled' ? state.terminalResult.reason : undefined,
      }))
      if (state.status === 'completed') {
        updateMessageActivity(agentRef, state.userMessageId, previous => ({
          ...previous,
          taskId: state.taskId,
          status: 'completed',
          errorMessage: undefined,
        }))
      } else if (state.status === 'failed') {
        const failMessage =
          state.terminalResult?.kind === 'error' ? state.terminalResult.message : undefined
        updateMessageActivity(agentRef, state.userMessageId, previous => ({
          ...previous,
          taskId: state.taskId,
          status: 'error',
          errorMessage: failMessage,
        }))
      }
      // Task finished — drop it from the activity in-flight set and stop the
      // per-agent activity stream if nothing else is running on that agent.
      activityInFlightByAgentRef.current[agentRef] = (
        activityInFlightByAgentRef.current[agentRef] || []
      ).filter(id => id !== state.userMessageId)
      void maybeStopAgentActivityStream(agentRef)
      // STREAM_TERMINAL clears the live "Running"/"Awaiting" badge (→ idle,
      // dropping taskId/approval) and, when the chat was NOT the active view,
      // mirrors the "completed_unread" badge to disk via the `mark_unread` effect
      // (persisted, survives a restart). Skips 'cancelled' — the user initiated
      // that, it's not "news".
      const view = activeChatVisibilityRef.current
      const chatVisible = view.selectedAgent === agentRef && view.activeChatId === chatId
      dispatchSession(key, {
        type: 'STREAM_TERMINAL',
        taskId: state.taskId,
        status:
          state.status === 'completed'
            ? 'completed'
            : state.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        chatVisible,
      })
      tracker.ack(key)
    },
    [
      appendAssistantMessage,
      maybeStopAgentActivityStream,
      dispatchSession,
      tracker,
      updateMessageProgress,
      updateMessageActivity,
      reconcileChat,
    ]
  )

  const onTrackerSuspended = useCallback(
    (key: TaskKey, state: TaskState) => {
      const approval = state.pendingApproval
      if (!approval) return
      // STREAM_SUSPENDED flips the sidebar badge to "Awaiting approval" (for any
      // chat's task, not just the active one) AND emits the approval notification
      // through the effect module — deduped by (taskId, requestId) so a sticky
      // re-emit / re-seed no longer re-notifies (GAP-N3 / §4.7.3). A snapshot that
      // already established the gate pre-arms the dedupe, so it stays silent.
      const label = approval.displayName || 'Tool'
      dispatchSession(key, {
        type: 'STREAM_SUSPENDED',
        taskId: state.taskId,
        approval: { ...approval, displayName: label },
      })
    },
    [dispatchSession]
  )

  const onTrackerResumed = useCallback(
    (key: TaskKey, state: TaskState) => {
      // The task moved past its approval — decided on ANY surface (in-chat,
      // notification, notification center, another device). STREAM_RESUMED settles
      // the badge back to `processing` and marks any optimistic local decision as
      // superseded (R3) so a stale APPROVAL_DECISION_FAILED can't resurrect the
      // gate — closing the C.2 rejoin loop.
      fsm.dispatch(key, { type: 'STREAM_RESUMED', taskId: state.taskId })
    },
    [fsm]
  )

  useEffect(() => {
    tracker.setCallbacks({
      onTerminal: onTrackerTerminal,
      onSuspended: onTrackerSuspended,
      onResumed: onTrackerResumed,
    })
  }, [tracker, onTrackerTerminal, onTrackerSuspended, onTrackerResumed])

  // Mirror the active chat's tracked task into progress/activity React state.
  // Switching chats only unsubscribes this listener — the task keeps running in
  // the tracker (cross-ref D.3 M2); onTrackerTerminal still fires for it.
  //
  // §8-R2: `seedSuspended` is gone. The approve/deny affordance (in-chat + the
  // in-flight placeholder) is driven by the progress `suspendedInfo`, which now
  // falls back to the FSM projection's `pendingApproval` when the tracker doesn't
  // (yet) hold one — the immediate optimistic paint from the reconcile's
  // `SERVER_SNAPSHOT` on a rejoin, before the rejoined SSE replays the sticky
  // `suspended` (V2). The tracker's own `pendingApproval` (live/replayed suspended)
  // wins when present.
  const activeSuspendKey =
    selectedAgent && activeChatId ? makeTaskKey(selectedAgent, activeChatId) : null
  const activeFsmApproval = activeSuspendKey
    ? sessionStateByChatKey[activeSuspendKey]?.pendingApproval
    : undefined
  useEffect(() => {
    if (!selectedAgent || !activeChatId) return
    const key = makeTaskKey(selectedAgent, activeChatId)
    return tracker.subscribe(key, state => {
      // A stream-loss terminal is owned by `onTrackerTerminal` (reconcile →
      // rejoin / render the durable reply, or paint the error itself only if
      // nothing is recoverable). Mirroring `failed` here would flash "Progress
      // stream error" on the message for a frame before the reconcile lands.
      if (
        state.status === 'failed' &&
        state.terminalResult?.kind === 'error' &&
        state.terminalResult.source === 'stream'
      ) {
        return
      }
      const suspendedInfo = state.pendingApproval
        ? {
            requestId: state.pendingApproval.requestId,
            displayName: state.pendingApproval.displayName || 'Unknown Tool',
          }
        : activeFsmApproval
          ? {
              requestId: activeFsmApproval.requestId,
              displayName: activeFsmApproval.displayName || 'Unknown Tool',
            }
          : undefined
      updateMessageProgress(selectedAgent, state.userMessageId, () => ({
        taskId: state.taskId,
        status: mapTrackerStatusToProgress(state.status),
        steps: state.steps,
        currentIteration: state.currentIteration,
        llmElapsedMs: state.llmElapsedMs,
        suspendedInfo,
        cancelReason:
          state.terminalResult?.kind === 'cancelled' ? state.terminalResult.reason : undefined,
      }))
      if (state.status === 'completed') {
        updateMessageActivity(selectedAgent, state.userMessageId, previous => ({
          ...previous,
          taskId: state.taskId,
          status: 'completed',
          errorMessage: undefined,
        }))
      } else if (state.status === 'failed') {
        const message =
          state.terminalResult?.kind === 'error' ? state.terminalResult.message : undefined
        updateMessageActivity(selectedAgent, state.userMessageId, previous => ({
          ...previous,
          taskId: state.taskId,
          status: 'error',
          errorMessage: message,
        }))
      }
    })
  }, [
    selectedAgent,
    activeChatId,
    tracker,
    updateMessageProgress,
    updateMessageActivity,
    activeFsmApproval,
  ])

  const sendAgentMessage = useCallback(
    async (
      content: string,
      attachments: ComposerImageAttachment[] = composerImageAttachments,
      references: ComposerReferenceAttachment[] = composerReferenceAttachments
    ) => {
      const trimmedContent = content.trim()
      const effectiveAttachments = [...attachments]
      const effectiveReferences = [...references]
      if (
        !selectedAgent ||
        (!trimmedContent && !effectiveAttachments.length && !effectiveReferences.length)
      )
        return
      // Per-(agent, chat) re-entry guard: a chat with a running task can't start
      // another. Concurrent sends to *different* chats are allowed (the feature).
      // Read the chat id from the ref (updated synchronously by auto-create /
      // switchToChat) rather than state, which may not have committed yet.
      const currentChatId = activeChatVisibilityRef.current.activeChatId
      if (currentChatId && tracker.get(makeTaskKey(selectedAgent, currentChatId))) return
      if (agentSendInFlightRef.current) return
      agentSendInFlightRef.current = true
      const sendAgent = selectedAgent
      let sendChatId = activeChatId
      // B10: when a chat is auto-created by this send, the `chatList` captured in
      // this closure predates it, so the auto-title lookup below would miss it and
      // never title the chat on message 1 (then mis-title it on message 2). Keep
      // the freshly-created meta so the lookup can fall back to it.
      let autoCreatedMeta: Awaited<ReturnType<typeof chatStore.createChat>> | undefined
      if (!sendChatId) {
        try {
          const chatId = crypto.randomUUID()
          const meta = await chatStore.createChat(sendAgent, chatId)
          autoCreatedMeta = meta
          appendNewEntry(sendAgent, meta)
          sendChatId = chatId
          // R2 new-chat composer: a per-session model picked BEFORE this chat
          // existed was held in the agent-keyed pre-chat slot (no chatId to key a
          // pending entry, no session to POST to). Now that the chatId exists,
          // migrate it into this chat's pending slot so the standard piggyback
          // logic below attaches it as `message.model` on message 1 and clears it
          // on a successful POST (a thrown POST leaves it for the retry).
          const preChatModel = chatStore.getPreChatModel(sendAgent)
          if (preChatModel) {
            chatStore.setPendingModel(sendAgent, chatId, preChatModel)
            chatStore.clearPreChatModel(sendAgent)
          }
          activeChatVisibilityRef.current = {
            ...activeChatVisibilityRef.current,
            activeChatId: chatId,
            selectedAgent: sendAgent,
          }
          setActiveChatId(chatId)
          setChatMessages([])
          await chatStore.setLastActive(sendAgent, chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          pushToast(`Could not create a chat session: ${message}`, 'error')
          agentSendInFlightRef.current = false
          setAgentSending(false)
          return
        }
      }
      const userMessageId = crypto.randomUUID()
      const baseContentForRequest =
        trimmedContent ||
        (effectiveAttachments.length
          ? 'Please analyze the attached image(s).'
          : 'Please use the attached context.')
      const effectiveContentForRequest = buildComposerRequestContent(
        baseContentForRequest,
        effectiveReferences
      )
      const displayAttachments = buildChatMessageAttachments(
        effectiveAttachments,
        effectiveReferences
      )
      const userMessage: AgentChatMessage = {
        id: userMessageId,
        role: 'user',
        content: trimmedContent,
        timestamp: Date.now(),
        ...(displayAttachments.length ? { attachments: displayAttachments } : {}),
      }
      // Sidebar freshness (dev): bump this chat's updatedAt/messageCount so the
      // cross-agent list and the chat list re-sort to the top on send. The user
      // message itself is persisted once, later, carrying its task_id (post-D.3),
      // so we do NOT eager-persist here (that would double-write without task_id).
      if (selectedAgent && sendChatId) {
        const updatedAt = new Date(userMessage.timestamp).toISOString()
        bumpActivity(selectedAgent, sendChatId, updatedAt)
      }
      setChatMessages(prev => [...prev, userMessage])
      // Auto-title on first message
      if (selectedAgent && sendChatId) {
        // B10: fall back to the meta just returned by createChat — the closure's
        // `chatList` doesn't yet include a chat auto-created by this very send.
        const chat =
          chatList.find(c => c.id === sendChatId) ??
          (autoCreatedMeta && autoCreatedMeta.id === sendChatId ? autoCreatedMeta : undefined)
        if (chat && chat.title === 'New Chat') {
          const autoTitleSeed =
            trimmedContent ||
            (effectiveAttachments.length > 0
              ? `Images: ${effectiveAttachments.map(att => att.name).join(', ')}`
              : effectiveReferences.length > 0
                ? `Context: ${effectiveReferences.map(ref => ref.label).join(', ')}`
                : '')
          const autoTitle =
            autoTitleSeed.length > 60
              ? autoTitleSeed.substring(0, autoTitleSeed.lastIndexOf(' ', 60) || 60) + '...'
              : autoTitleSeed
          if (autoTitle) {
            void handleRenameChat(sendChatId, autoTitle)
          }
        }
      }
      setActivityByAgentMessage(previous => ({
        ...previous,
        [sendAgent]: {
          ...(previous[sendAgent] || {}),
          [userMessageId]: {
            status: 'waiting',
            events: [],
            redactionCount: 0,
          },
        },
      }))
      activityInFlightByAgentRef.current[sendAgent] = [
        ...(activityInFlightByAgentRef.current[sendAgent] || []),
        userMessageId,
      ]
      if (!activityTaskToMessageByAgentRef.current[sendAgent]) {
        activityTaskToMessageByAgentRef.current[sendAgent] = {}
      }

      clearComposerAfterSend(sendChatId)
      setAgentError(null)
      setFailedAgentSend(null)
      setAgentSending(true)

      try {
        await ensureAgentActivityStream(sendAgent)
        // R2 "Option A": a per-session model chosen while the host was suspended
        // couldn't be persisted server-side, so it was held as pending. Piggyback
        // it here — this send wakes the host and applies the model to this task.
        const pendingModel = sendChatId
          ? chatStore.getPendingModel(sendAgent, sendChatId)
          : undefined
        const request = {
          content: effectiveContentForRequest,
          channelType: 'rpc',
          channelId: sendAgent,
          threadId: sendChatId || undefined,
          attachments:
            effectiveAttachments.length > 0
              ? mapComposerAttachmentsToHostRequest(effectiveAttachments)
              : undefined,
          ...(pendingModel ? { model: pendingModel } : {}),
        }

        const response = await window.clerum.rpc.invokeHostMessage(
          sendAgent,
          request,
          [sendAgent],
          {
            async: true,
          }
        )
        // The runtime accepted the POST (sync reply or async task) — it received
        // the piggybacked model, so drop the pending entry. A thrown POST skips
        // this (the catch below leaves it set) so the next attempt retries it.
        if (pendingModel && sendChatId) {
          chatStore.clearPendingModel(sendAgent, sendChatId)
        }
        const responseRecord = response as Record<string, unknown>
        const taskId =
          (typeof responseRecord.taskId === 'string' ? responseRecord.taskId : undefined) ||
          (typeof responseRecord.id === 'string' ? responseRecord.id : undefined)

        if (!taskId) {
          // Synchronous (non-async) response — a direct reply or a structured error.
          const errorRecord = responseRecord.error as
            | { message?: string; code?: string; provider?: string }
            | undefined
          const content =
            typeof errorRecord?.message === 'string'
              ? errorRecord.message
              : extractAssistantReply(response)
          const responseAttachments = buildResponseFileAttachments(response)
          const assistantMessage: AgentChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content,
            timestamp: Date.now(),
            ...(responseAttachments.length ? { attachments: responseAttachments } : {}),
            ...(errorRecord && {
              isError: true,
              errorCode: errorRecord.code,
              errorProvider: errorRecord.provider,
            }),
          }
          if (sendChatId) {
            await chatStore.appendMessages(sendAgent, sendChatId, [userMessage])
          }
          await appendAssistantMessage(sendAgent, sendChatId, assistantMessage)
          if (errorRecord) {
            updateMessageActivity(sendAgent, userMessageId, previous => ({
              ...previous,
              status: 'error',
              errorMessage: errorRecord.message,
            }))
            pushToast(`Message to ${sendAgent} failed: ${errorRecord.message ?? 'error'}`, 'error')
          } else {
            updateMessageActivity(sendAgent, userMessageId, previous => ({
              ...previous,
              status: previous.events.length ? 'completed' : 'no_activity',
              errorMessage: undefined,
            }))
            pushToast(`Message sent to ${sendAgent}.`, 'success')
          }
          activityInFlightByAgentRef.current[sendAgent] = (
            activityInFlightByAgentRef.current[sendAgent] || []
          ).filter(id => id !== userMessageId)
          void maybeStopAgentActivityStream(sendAgent)
          return
        }

        // Async task accepted. Persist the user message once, now carrying its
        // task_id (schema v2), then hand the SSE lifecycle to the tracker.
        const persistedUserMessage: AgentChatMessage = { ...userMessage, task_id: taskId }
        setChatMessages(prev => prev.map(m => (m.id === userMessageId ? persistedUserMessage : m)))
        if (sendChatId) {
          await chatStore.appendMessages(sendAgent, sendChatId, [persistedUserMessage])
        }
        activityTaskToMessageByAgentRef.current[sendAgent] = {
          ...(activityTaskToMessageByAgentRef.current[sendAgent] || {}),
          [taskId]: userMessageId,
        }
        reconcileTaskOwnership(sendAgent, taskId, userMessageId)
        updateMessageProgress(sendAgent, userMessageId, () => ({
          taskId,
          status: 'connecting',
          steps: [],
          currentIteration: 0,
        }))
        updateMessageActivity(sendAgent, userMessageId, previous => ({
          ...previous,
          taskId,
          status: 'streaming',
        }))
        if (sendChatId) {
          // Stash the original input so a ghost terminal can offer a Resend (AC11).
          // Owned by the coordinator now (B15): cleared when the key is released.
          tracker.setResend(taskId, {
            content: trimmedContent,
            attachments: effectiveAttachments,
            references: effectiveReferences,
          })
          const taskKey = makeTaskKey(sendAgent, sendChatId)
          tracker.start(taskKey, taskId, userMessageId)
          // SEND_STARTED bumps the epoch (R2 snapshot staleness anchor), adopts
          // the new taskId (R1 then drops the previous task's late events) and
          // clears any prior approval/offline residue; TASK_CREATED flips to
          // `processing` so
          // the sidebar "Running" badge shows even while viewing another chat.
          fsm.dispatch(taskKey, { type: 'SEND_STARTED', taskId })
          fsm.dispatch(taskKey, { type: 'TASK_CREATED', taskId })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const normalized = message.toLowerCase()
        const isRequestEntityTooLarge =
          normalized.includes('request entity too large') ||
          normalized.includes('payload too large')
        const kind = classifyErrorKind(message)
        const fallback = isRequestEntityTooLarge
          ? 'Runtime payload limit hit. This environment still needs updated rpc-proxy and mcp-host deployments for image uploads.'
          : errorRecoveryHint(kind)
        const friendlyMessage = isRequestEntityTooLarge
          ? 'Image payload is larger than the currently deployed runtime limit.'
          : kind === 'waking'
            ? 'Agent is waking up.'
            : kind === 'network'
              ? 'Temporary connection issue while sending to the agent.'
              : kind === 'auth'
                ? 'Access issue while sending to this agent.'
                : 'Unable to send message to this agent.'
        setAgentError(`${friendlyMessage} ${fallback}`)
        setFailedAgentSend({
          content: trimmedContent,
          attachments: effectiveAttachments,
          references: effectiveReferences,
          message,
          kind,
          timestamp: Date.now(),
        })
        updateMessageActivity(sendAgent, userMessageId, previous => ({
          ...previous,
          status: 'error',
          errorMessage: fallback,
        }))
        pushToast(
          kind === 'waking'
            ? 'Agent is waking up — message not sent yet.'
            : `Message failed (${kind}).`,
          'error'
        )
        // Durability: the POST threw before either success branch persisted the
        // user message (post-D.3 persists once, after the taskId is known). Write
        // it now so a transient send failure doesn't silently drop the user's
        // typed input on reload — matches pre-D.3 eager-persist. Best-effort.
        if (sendChatId) {
          try {
            await chatStore.appendMessages(sendAgent, sendChatId, [userMessage])
          } catch {
            // persistence is best-effort; the in-memory view still shows it
          }
        }
        // The POST failed — no background task exists, so retire the activity
        // stream now. (For a started task, onTrackerTerminal does this instead.)
        activityInFlightByAgentRef.current[sendAgent] = (
          activityInFlightByAgentRef.current[sendAgent] || []
        ).filter(messageId => messageId !== userMessageId)
        void maybeStopAgentActivityStream(sendAgent)
      } finally {
        // Fire & forget: release the synchronous setup guard immediately. The
        // task (if any) keeps running in the tracker.
        agentSendInFlightRef.current = false
        setAgentSending(false)
      }
    },
    [
      selectedAgent,
      activeChatId,
      composerImageAttachments,
      composerReferenceAttachments,
      chatList,
      chatStore,
      clearComposerAfterSend,
      fsm,
      handleRenameChat,
      pushToast,
      tracker,
      ensureAgentActivityStream,
      maybeStopAgentActivityStream,
      reconcileTaskOwnership,
      updateMessageActivity,
      updateMessageProgress,
      appendAssistantMessage,
      appendNewEntry,
      bumpActivity,
    ]
  )

  const handleSendAgentMessage = useCallback(
    async (text: string) => {
      await sendAgentMessage(text, composerImageAttachments, composerReferenceAttachments)
    },
    [composerImageAttachments, composerReferenceAttachments, sendAgentMessage]
  )

  const handleRetryFailedAgentSend = useCallback(async () => {
    if (!failedAgentSend) return
    await sendAgentMessage(
      failedAgentSend.content,
      failedAgentSend.attachments,
      failedAgentSend.references
    )
  }, [failedAgentSend, sendAgentMessage])

  const cancelTask = useCallback(
    async (taskId: string) => {
      const hostRef = selectedAgent
      if (!hostRef) return
      const markCancelled = (reason?: string) => {
        setProgressByAgentMessage(previous => {
          const byMessage = previous[hostRef] || {}
          let changed = false
          const nextByMessage = Object.fromEntries(
            Object.entries(byMessage).map(([messageId, progress]) => {
              if (progress.taskId !== taskId) return [messageId, progress]
              changed = true
              return [
                messageId,
                {
                  ...progress,
                  status: 'cancelled' as const,
                  cancelReason: reason ?? progress.cancelReason,
                },
              ]
            })
          )
          return changed ? { ...previous, [hostRef]: nextByMessage } : previous
        })
        setActivityByAgentMessage(previous => {
          const byMessage = previous[hostRef] || {}
          let changed = false
          const nextByMessage = Object.fromEntries(
            Object.entries(byMessage).map(([messageId, activity]) => {
              if (activity.taskId !== taskId) return [messageId, activity]
              changed = true
              return [
                messageId,
                {
                  ...activity,
                  status: 'completed' as const,
                  errorMessage: undefined,
                },
              ]
            })
          )
          return changed ? { ...previous, [hostRef]: nextByMessage } : previous
        })
      }
      try {
        await window.clerum.rpc.cancelTask(hostRef, taskId)
        markCancelled('Cancelled by user.')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('404') || message.toLowerCase().includes('task not found')) {
          markCancelled('Task already finished or is no longer active.')
          pushToast('That task is no longer active.', 'info')
          return
        }
        console.error('[useAgentChatController] cancelTask failed', err)
        pushToast(`Failed to cancel task: ${message}`, 'error')
      }
    },
    [pushToast, selectedAgent]
  )

  const setPendingChatSelection = useCallback(
    (
      agentName: string,
      chatId: string | null,
      options: {
        selectLatest?: boolean
        suppressAutoSelect?: boolean
        title?: string
        isRemote?: boolean
      } = {}
    ) => {
      if (options.selectLatest) {
        writePendingSelection(agentName, { mode: 'latest', chatId: null })
        return
      }
      if (options.suppressAutoSelect || !chatId) {
        writePendingSelection(agentName, { mode: 'none', chatId: null })
        return
      }
      const specificSelection: Extract<PendingChatSelection, { mode: 'specific' }> = {
        mode: 'specific',
        chatId,
      }
      if (options.title) specificSelection.title = options.title
      if (options.isRemote !== undefined) specificSelection.isRemote = options.isRemote
      writePendingSelection(agentName, specificSelection)
      activeChatVisibilityRef.current = {
        ...activeChatVisibilityRef.current,
        activeChatId: chatId,
        currentTeamId,
        selectedAgent: agentName,
      }
      setActiveChatId(chatId)
      setChatMessages([])
      setChatMessagesLoading(true)
      setHasOlderMessages(false)
      loadedLocalMessageCountRef.current = 0
      if (options.title) {
        upsertProvisionalEntry(chatId, options.title, options.isRemote === true)
      }
    },
    [currentTeamId, writePendingSelection, upsertProvisionalEntry]
  )

  const clearActiveChat = useCallback(() => {
    activeChatVisibilityRef.current = {
      ...activeChatVisibilityRef.current,
      activeChatId: null,
    }
    setActiveChatId(null)
    setChatMessages([])
    setChatMessagesLoading(false)
    setHasOlderMessages(false)
    loadedLocalMessageCountRef.current = 0
    // Deselecting the active chat (e.g. team switch) must also drop its per-chat
    // error/resend banner so it doesn't bleed into the next active chat.
    setAgentError(null)
    setFailedAgentSend(null)
  }, [])

  const groupedMessages = useMemo(() => {
    const groups: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }> = []
    for (const item of chatMessages) {
      const previous = groups[groups.length - 1]
      if (!previous || previous.role !== item.role) groups.push({ role: item.role, items: [item] })
      else previous.items.push(item)
    }
    return groups
  }, [chatMessages])

  // D.5: session state for the SELECTED agent's chats, re-keyed by plain chatId
  // (the same key as chatList entries / activeChatId) so the sidebar + header can
  // look it up without recomputing makeTaskKey per chat.
  const sessionStateByChatId = useMemo(() => {
    if (!selectedAgent) return {} as Record<string, SessionStateLite>
    const out: Record<string, SessionStateLite> = {}
    for (const [taskKey, value] of Object.entries(sessionStateByChatKey)) {
      const { agentRef, chatId } = parseTaskKey(taskKey)
      if (agentRef === selectedAgent) out[chatId] = value
    }
    return out
  }, [sessionStateByChatKey, selectedAgent])

  return {
    activeChatId,
    chatList,
    chatListLoading,
    latestChatSessions,
    latestChatSessionsLoading,
    chatMessages,
    chatMessagesLoading,
    hasOlderMessages,
    olderMessagesLoading,
    sessionStateByChatKey,
    sessionStateByChatId,
    // Fase 2b (§4.7.4): the app-shell builds the central `decideApproval` bound to
    // THIS store so all four decision surfaces converge the same FSM projection.
    sessionFsmStore: fsm,
    progressByAgentMessage,
    composerImageAttachments,
    composerReferenceAttachments,
    agentSending,
    agentError,
    failedAgentSend,
    chatEndRef,
    activityByMessageId,
    progressByMessageId,
    groupedMessages,
    switchToChat,
    reconcileChat,
    stopAllActivityStreams,
    resetChat,
    setPendingChatSelection,
    clearActiveChat,
    handleCreateChat,
    handleRenameChat,
    handleRenameChatForAgent,
    handleDeleteChat,
    handleDeleteChatForAgent,
    handleSelectChat,
    handleLoadOlderMessages,
    handleSendAgentMessage,
    handleRetryFailedAgentSend,
    clearComposerSendError,
    handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment,
    handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment,
    cancelTask,
  }
}

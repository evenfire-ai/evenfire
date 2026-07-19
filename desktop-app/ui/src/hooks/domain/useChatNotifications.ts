import { type MutableRefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import { DESKTOP_ROUTES } from '../../constants/navigation'
import type {
  AgentApprovalNotificationTarget,
  AgentChatMessage,
  AgentConversationNotificationTarget,
  DesktopNotificationPayload,
  DesktopNotificationPermission,
  NavItem,
} from '../../uiTypes'
import type { PushNotificationInput } from './types'

/** The active-chat visibility snapshot the notification gating reads. Owned by
 *  the parent (many synchronous writers); passed in read-only here (§4.7.2). */
export interface ActiveChatVisibility {
  activeChatId: string | null
  currentTeamId: string
  navItem: NavItem
  selectedAgent: string | null
}

function formatNotificationPreview(content: string, fallback: string): string {
  const normalizedContent = content.replace(/\s+/g, ' ').trim()
  if (!normalizedContent) return fallback
  const maxLength = 140
  if (normalizedContent.length <= maxLength) return normalizedContent
  return `${normalizedContent.slice(0, maxLength - 3).trimEnd()}...`
}

interface UseChatNotificationsParams {
  /** Read-only ref to the parent's active-chat visibility (see §4.7.2). */
  activeChatVisibilityRef: MutableRefObject<ActiveChatVisibility>
  currentTeamId: string
  currentTeamName: string
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

/**
 * Chat notification emitters — assistant reply + approval — plus the visibility
 * gating they share. Extracted from `useAgentChatController` (Fase 1) with the
 * §4.7.2/§4.7.3 rules preserved (140-char preview, per-tag desktop dedupe,
 * team+nav+agent+chat visibility check).
 *
 * The live props are read through refs assigned in an EFFECT (not in the render
 * body — closes R-F12). This keeps `pushAssistantReplyNotification` /
 * `pushApprovalNotification` identity-stable (deps: `[isNotificationTargetVisible]`)
 * so the parent's `appendAssistantMessage` / `onTrackerSuspended` — and thus the
 * tracker `setCallbacks` effect — don't churn. The `useRef` INITIALIZERS already
 * hold the mount-time props, and the only callers (a task terminal via
 * `appendAssistantMessage`, an approval via `onTrackerSuspended`) can only fire
 * after the tracker callbacks are registered in a later effect, so no caller ever
 * reads a ref before its first effect assignment.
 */
export function useChatNotifications({
  activeChatVisibilityRef,
  currentTeamId,
  currentTeamName,
  pushNotification,
  canDeliverChatResponseNotification,
  showDesktopNotification,
  openAgentConversationFromNotification,
  decideApprovalFromNotification,
}: UseChatNotificationsParams) {
  const liveDepsRef = useRef({
    currentTeamId,
    currentTeamName,
    pushNotification,
    openAgentConversationFromNotification,
    decideApprovalFromNotification,
  })
  useEffect(() => {
    liveDepsRef.current = {
      currentTeamId,
      currentTeamName,
      pushNotification,
      openAgentConversationFromNotification,
      decideApprovalFromNotification,
    }
  }, [
    currentTeamId,
    currentTeamName,
    pushNotification,
    openAgentConversationFromNotification,
    decideApprovalFromNotification,
  ])

  // §4.7.2 first-materialization dedupe: emit the reply notification ONCE per task,
  // whether the reply first materializes via `STREAM_TERMINAL(completed)` (the
  // coordinator's `appendAssistantMessage`) or via the reconciler's durable branch
  // (rama 3/4). A hydration REPLACE never routes through here (it uses
  // `replaceMessages`, not `appendAssistantMessage`), so those never notify; this
  // ref only guards the rare double-materialization of the SAME task (e.g. a
  // durable recovery landing after a terminal already appended). Mirrors the FSM's
  // `notified` bookkeeping (§4.1). Keyed by `task_id` — the stable per-task id — as
  // each materialization mints a fresh message id, so the message id can't serve as
  // a cross-materialization key. Bounded by a session's task count and explicitly
  // cleared on a controller reset (logout / team-switch) via
  // `resetReplyNotificationDedupe` below, so it can't accumulate across sessions.
  const notifiedReplyTaskIdsRef = useRef<Set<string>>(new Set())

  const notificationDeliveryRef = useRef({
    canDeliverChatResponseNotification,
    showDesktopNotification,
  })
  useEffect(() => {
    notificationDeliveryRef.current = {
      canDeliverChatResponseNotification,
      showDesktopNotification,
    }
  }, [canDeliverChatResponseNotification, showDesktopNotification])

  const isNotificationTargetVisible = useCallback(
    (agentName: string, chatId?: string | null, teamId?: string) => {
      const currentChatView = activeChatVisibilityRef.current
      const activeTeamVisible = !teamId || currentChatView.currentTeamId === teamId
      const activeAgentVisible =
        activeTeamVisible &&
        (currentChatView.navItem === DESKTOP_ROUTES.agents ||
          currentChatView.navItem === DESKTOP_ROUTES.chat) &&
        currentChatView.selectedAgent === agentName
      return activeAgentVisible && (!chatId || currentChatView.activeChatId === chatId)
    },
    [activeChatVisibilityRef]
  )

  const pushAssistantReplyNotification = useCallback(
    (agentName: string, message: AgentChatMessage, chatId?: string | null) => {
      // §4.7.2: notify once per (taskId) on first materialization. A re-delivery of
      // the same task's reply (durable recovery after a terminal, or vice-versa) is
      // swallowed — the in-app channel has no per-tag dedupe of its own (unlike the
      // desktop tag), so this is the only guard against a duplicate in-app toast.
      const taskId = message.task_id
      if (taskId) {
        if (notifiedReplyTaskIdsRef.current.has(taskId)) return
        notifiedReplyTaskIdsRef.current.add(taskId)
      }
      const deps = liveDepsRef.current
      const notificationTeamId = deps.currentTeamId || undefined
      const fallback = message.isError ? 'Agent returned an error.' : 'Agent replied.'
      const text = formatNotificationPreview(message.content, fallback)
      const activeChatVisible = isNotificationTargetVisible(agentName, chatId, notificationTeamId)
      const { canDeliverChatResponseNotification: canDeliver, showDesktopNotification } =
        notificationDeliveryRef.current
      if (canDeliver('inApp', { activeChatVisible })) {
        deps.pushNotification({
          kind: 'assistant_reply',
          agentName,
          chatId: chatId || undefined,
          teamId: notificationTeamId,
          teamName: deps.currentTeamName || undefined,
          text,
          timestamp: message.timestamp,
        })
      }
      if (canDeliver('desktop', { activeChatVisible })) {
        void showDesktopNotification({
          title: `${agentName} replied`,
          body: text,
          tag: `assistant-reply:${agentName}:${chatId || 'no-chat'}:${message.id}`,
          onClick: () =>
            deps.openAgentConversationFromNotification({
              agentName,
              chatId: chatId || undefined,
              teamId: notificationTeamId,
            }),
        })
      }
    },
    [isNotificationTargetVisible]
  )

  const pushApprovalNotification = useCallback(
    ({
      agentName,
      chatId,
      taskId,
      requestId,
      text,
      displayName,
    }: {
      agentName: string
      chatId?: string | null
      taskId: string
      requestId: string
      text: string
      displayName?: string
    }) => {
      const deps = liveDepsRef.current
      const notificationTeamId = deps.currentTeamId || undefined
      const dedupeKey = `approval:${agentName}:${taskId}:${requestId}`
      const desktopText = formatNotificationPreview(text, `Approval required for ${agentName}.`)
      deps.pushNotification({
        kind: 'approval_required',
        agentName,
        chatId: chatId || undefined,
        teamId: notificationTeamId,
        teamName: deps.currentTeamName || undefined,
        text,
        approval: { taskId, requestId, displayName },
        dedupeKey,
      })
      const activeChatVisible = isNotificationTargetVisible(agentName, chatId, notificationTeamId)
      const { canDeliverChatResponseNotification: canDeliver, showDesktopNotification } =
        notificationDeliveryRef.current
      if (!canDeliver('desktop', { activeChatVisible })) return
      void showDesktopNotification({
        title: `${agentName} needs authorization`,
        body: desktopText,
        tag: dedupeKey,
        actions: [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' },
        ],
        onClick: () =>
          deps.openAgentConversationFromNotification({
            agentName,
            chatId: chatId || undefined,
            teamId: notificationTeamId,
          }),
        onAction: action => {
          if (action !== 'approve' && action !== 'deny') {
            return deps.openAgentConversationFromNotification({
              agentName,
              chatId: chatId || undefined,
              teamId: notificationTeamId,
            })
          }
          return deps.decideApprovalFromNotification({
            agentName,
            chatId: chatId || undefined,
            teamId: notificationTeamId,
            taskId,
            requestId,
            decision: action,
          })
        },
      })
    },
    [isNotificationTargetVisible]
  )

  // Drop the reply-dedupe set on a controller teardown (logout / team-switch /
  // unmount) so it can't accumulate taskIds across sessions. Bounded and
  // security-inert either way (UUID keys only ever dedupe their own task), but
  // reset keeps it hygienic.
  const resetReplyNotificationDedupe = useCallback(() => {
    notifiedReplyTaskIdsRef.current.clear()
  }, [])

  return useMemo(
    () => ({
      pushAssistantReplyNotification,
      pushApprovalNotification,
      resetReplyNotificationDedupe,
    }),
    [pushAssistantReplyNotification, pushApprovalNotification, resetReplyNotificationDedupe]
  )
}

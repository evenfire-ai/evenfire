import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NOTIFICATION_ALERT_SOUND_SRC } from '@constants/notifications'
import type {
  PendingWorkflowApproval,
  WorkflowApprovalDecisionResult,
  WorkflowNotificationStreamEvent,
  WorkflowRunCompletedNotification,
} from '../../../../src/types'
import type {
  AppNotification,
  DesktopNotificationPayload,
  DesktopNotificationPermission,
  Tone,
} from '../../uiTypes'
import type { ApprovalDecisionTarget } from './approvalDecision'
import type { PushNotificationInput, SetStatusFn } from './types'

type WorkflowApprovalDecisionCallbackInput = {
  approval: PendingWorkflowApproval
  decision: 'approve' | 'deny'
  result: WorkflowApprovalDecisionResult
}

type WorkflowRunCompletedStreamEvent = {
  type: 'workflow.run.completed'
  id: string
  cursor: string
  observedAt: string
  workflowRun: WorkflowRunCompletedNotification
}

interface UseNotificationsControllerParams {
  isAuthenticated: boolean
  notificationSoundVolume: number
  canDeliverChatResponseNotification: (
    channel: 'inApp' | 'desktop',
    context: { activeChatVisible: boolean }
  ) => boolean
  showDesktopNotification: (
    payload: DesktopNotificationPayload
  ) => Promise<DesktopNotificationPermission>
  onWorkflowApprovalDecision?: (
    input: WorkflowApprovalDecisionCallbackInput
  ) => Promise<void> | void
  /** §4.7.4: the central approval decider — the in-app bell funnels through it so
   *  the chat FSM badge converges when deciding from the notification panel. */
  decideApproval: (target: ApprovalDecisionTarget) => Promise<void>
  pushToast: (msg: string, tone: Tone) => void
  setStatus: SetStatusFn
}

function isWorkflowRunCompletedStreamEvent(
  event: unknown
): event is WorkflowRunCompletedStreamEvent {
  const record = event && typeof event === 'object' ? (event as Record<string, unknown>) : null
  const workflowRun =
    record?.workflowRun && typeof record.workflowRun === 'object'
      ? (record.workflowRun as Record<string, unknown>)
      : null
  const target =
    workflowRun?.target && typeof workflowRun.target === 'object'
      ? (workflowRun.target as Record<string, unknown>)
      : null
  return Boolean(
    record?.type === 'workflow.run.completed' &&
    typeof record.id === 'string' &&
    typeof record.cursor === 'string' &&
    typeof record.observedAt === 'string' &&
    workflowRun &&
    typeof workflowRun.workflowRunId === 'string' &&
    typeof workflowRun.approvalRequestId === 'string' &&
    typeof workflowRun.recipeNamespace === 'string' &&
    typeof workflowRun.recipeName === 'string' &&
    ['Succeeded', 'Failed', 'Canceled'].includes(String(workflowRun.phase || '')) &&
    typeof workflowRun.completedAt === 'string' &&
    target
  )
}

function workflowCompletionText(
  workflowRun: WorkflowRunCompletedStreamEvent['workflowRun']
): string {
  if (workflowRun.phase === 'Succeeded') {
    return 'Workflow ' + workflowRun.recipeName + ' completed. Results are ready.'
  }
  return (
    'Workflow ' +
    workflowRun.recipeName +
    ' finished with status ' +
    workflowRun.phase +
    '. Check available results.'
  )
}

function workflowCompletionTimestamp(
  workflowRun: WorkflowRunCompletedStreamEvent['workflowRun']
): number {
  const parsed = new Date(workflowRun.completedAt).getTime()
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function activeApprovals(items: PendingWorkflowApproval[]): PendingWorkflowApproval[] {
  const now = Date.now()
  const seenApprovalIds = new Set<string>()
  return items.filter(approval => {
    if (new Date(approval.expiresAt).getTime() <= now) return false
    if (seenApprovalIds.has(approval.id)) return false
    seenApprovalIds.add(approval.id)
    return true
  })
}

function upsertApproval(
  current: PendingWorkflowApproval[],
  approval: PendingWorkflowApproval
): PendingWorkflowApproval[] {
  if (new Date(approval.expiresAt).getTime() <= Date.now()) return current
  const existingIndex = current.findIndex(item => item.id === approval.id)
  if (existingIndex >= 0) {
    const next = [...current]
    next[existingIndex] = approval
    return activeApprovals(next)
  }
  return activeApprovals([approval, ...current])
}

function isSdkNotificationStreamEvent(
  event: WorkflowNotificationStreamEvent
): event is Extract<WorkflowNotificationStreamEvent, { type: 'sdk.notification' }> {
  return event.type === 'sdk.notification'
}

export function useNotificationsController({
  isAuthenticated,
  notificationSoundVolume,
  canDeliverChatResponseNotification,
  showDesktopNotification,
  onWorkflowApprovalDecision,
  decideApproval,
  pushToast,
  setStatus,
}: UseNotificationsControllerParams) {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [notificationActionById, setNotificationActionById] = useState<
    Record<string, 'approving' | 'denying' | undefined>
  >({})
  const [pendingApprovals, setPendingApprovals] = useState<PendingWorkflowApproval[]>([])
  const [pendingApprovalsLoading, setPendingApprovalsLoading] = useState(false)
  const [pendingApprovalActionId, setPendingApprovalActionId] = useState<string | null>(null)
  const notificationSoundRef = useRef<HTMLAudioElement | null>(null)
  const seenNotificationIdsRef = useRef<Set<string>>(new Set())
  const notificationSoundInitializedRef = useRef(false)
  const lastNotificationStreamErrorRef = useRef<string | null>(null)

  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, notification) => count + (notification.read ? 0 : 1), 0),
    [notifications]
  )

  const playNotificationSound = useCallback(
    (volume = notificationSoundVolume) => {
      if (typeof Audio === 'undefined') return
      if (volume <= 0) return
      const audio = notificationSoundRef.current ?? new Audio(NOTIFICATION_ALERT_SOUND_SRC)
      notificationSoundRef.current = audio
      audio.volume = volume / 100
      audio.currentTime = 0
      void audio.play().catch(error => {
        console.warn('[useNotificationsController] notification sound playback failed', error)
      })
    },
    [notificationSoundVolume]
  )

  useEffect(() => {
    const nextSeenNotificationIds = new Set(notifications.map(notification => notification.id))
    if (!notificationSoundInitializedRef.current) {
      notificationSoundInitializedRef.current = true
      seenNotificationIdsRef.current = nextSeenNotificationIds
      return
    }

    const latestNotification = notifications[0]
    if (!latestNotification) {
      seenNotificationIdsRef.current = nextSeenNotificationIds
      return
    }
    const seenNotificationIds = seenNotificationIdsRef.current
    const latestIsNew = !seenNotificationIds.has(latestNotification.id)
    seenNotificationIdsRef.current = nextSeenNotificationIds
    if (latestIsNew) {
      playNotificationSound()
    }
  }, [notifications, playNotificationSound])

  const pushNotification = useCallback((input: PushNotificationInput) => {
    const text = input.text.trim()
    if (!text) return
    setNotifications(previous => {
      if (input.dedupeKey) {
        const existingIndex = previous.findIndex(
          notification => notification.dedupeKey === input.dedupeKey
        )
        if (existingIndex >= 0) {
          const existing = previous[existingIndex]
          if (!existing) return previous
          const merged: AppNotification = {
            ...existing,
            text,
            chatId: input.chatId ?? existing.chatId,
            teamId: input.teamId ?? existing.teamId,
            teamName: input.teamName ?? existing.teamName,
            timestamp: input.timestamp ?? existing.timestamp,
            approval: input.approval || existing.approval,
            approvalState: existing.approvalState,
            workflow: input.workflow || existing.workflow,
            sdk: input.sdk || existing.sdk,
          }
          const next = [...previous]
          next[existingIndex] = merged
          return next
        }
      }
      const next: AppNotification = {
        id: crypto.randomUUID(),
        kind: input.kind,
        agentName: input.agentName,
        chatId: input.chatId,
        teamId: input.teamId,
        teamName: input.teamName,
        text,
        timestamp: input.timestamp ?? Date.now(),
        read: false,
        approval: input.approval,
        approvalState: input.approvalState,
        workflow: input.workflow,
        sdk: input.sdk,
        dedupeKey: input.dedupeKey,
      }
      return [next, ...previous].slice(0, 80)
    })
  }, [])

  const markNotificationsRead = useCallback(() => {
    setNotifications(previous =>
      previous.some(notification => !notification.read)
        ? previous.map(notification =>
            notification.read ? notification : { ...notification, read: true }
          )
        : previous
    )
  }, [])

  const markNotificationRead = useCallback((notificationId: string) => {
    setNotifications(previous =>
      previous.map(entry =>
        entry.id === notificationId && !entry.read ? { ...entry, read: true } : entry
      )
    )
  }, [])

  const clearNotifications = useCallback(() => {
    setNotifications([])
    setNotificationActionById({})
  }, [])

  const removeNotification = useCallback((notificationId: string) => {
    if (!notificationId) return
    setNotifications(previous =>
      previous.filter(notification => notification.id !== notificationId)
    )
    setNotificationActionById(previous => {
      if (!(notificationId in previous)) return previous
      const next = { ...previous }
      delete next[notificationId]
      return next
    })
  }, [])

  const resolveApprovalNotification = useCallback(
    ({
      agentName,
      taskId,
      requestId,
      state,
    }: {
      agentName: string
      taskId: string
      requestId: string
      state: 'approved' | 'denied'
    }) => {
      setNotifications(previous =>
        previous.map(notification => {
          const approval = notification.approval
          const matchesApproval =
            notification.kind === 'approval_required' &&
            notification.agentName === agentName &&
            approval?.taskId === taskId &&
            approval.requestId === requestId
          return matchesApproval
            ? { ...notification, read: true, approvalState: state }
            : notification
        })
      )
    },
    []
  )

  // Surface (b), §4.7.4: the bell funnels through the central decider (optimistic
  // FSM dispatch + RPC + resolve/toast/revert). The panel keeps its LOCAL spinner
  // (setNotificationActionById); the resolved/denied visual state now derives from
  // the central `resolveApprovalNotification` (matched by agentName/taskId/requestId)
  // rather than a separate `setNotificationApprovalState`.
  const decideFromBell = useCallback(
    async (notification: AppNotification, decision: 'approve' | 'deny') => {
      if (!notification.approval) return
      if (notification.approvalState) return
      setNotificationActionById(previous => ({
        ...previous,
        [notification.id]: decision === 'approve' ? 'approving' : 'denying',
      }))
      try {
        await decideApproval({
          agentRef: notification.agentName,
          chatId: notification.chatId ?? '',
          teamId: notification.teamId,
          taskId: notification.approval.taskId,
          requestId: notification.approval.requestId,
          decision,
          source: 'inapp_bell',
        })
      } finally {
        setNotificationActionById(previous => {
          const next = { ...previous }
          delete next[notification.id]
          return next
        })
      }
    },
    [decideApproval]
  )

  const handleApproveNotification = useCallback(
    (notification: AppNotification) => decideFromBell(notification, 'approve'),
    [decideFromBell]
  )

  const handleDenyNotification = useCallback(
    (notification: AppNotification) => decideFromBell(notification, 'deny'),
    [decideFromBell]
  )

  const handleRefreshPendingApprovals = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const { silent = false } = options
      if (!isAuthenticated) {
        setPendingApprovals([])
        setPendingApprovalsLoading(false)
        return
      }

      const showLoadingState = !silent || pendingApprovals.length === 0
      if (showLoadingState) {
        setPendingApprovalsLoading(true)
      }

      try {
        const items = await window.clerum.approvals.listPending(20)
        setPendingApprovals(activeApprovals(Array.isArray(items) ? items : []))
      } catch (error) {
        if (!silent) {
          setStatus(
            `Failed loading pending approvals: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        }
      } finally {
        if (showLoadingState) {
          setPendingApprovalsLoading(false)
        }
      }
    },
    [isAuthenticated, pendingApprovals.length, setStatus]
  )

  useEffect(() => {
    if (!isAuthenticated) {
      setPendingApprovals([])
      setPendingApprovalsLoading(false)
      lastNotificationStreamErrorRef.current = null
      return
    }

    let disposed = false
    let unsubscribe: (() => Promise<void>) | null = null
    setPendingApprovalsLoading(true)

    const handleStreamEvent = (event: WorkflowNotificationStreamEvent) => {
      if (disposed) return
      if (event.type === 'open') {
        lastNotificationStreamErrorRef.current = null
        return
      }
      if (event.type === 'notification.snapshot') {
        const snapshotTeamIds = new Set(
          event.items.map(item => String(item.target.teamId || '')).filter(Boolean)
        )
        setPendingApprovals(current => {
          const retained = snapshotTeamIds.size
            ? current.filter(item => !snapshotTeamIds.has(String(item.target.teamId || '')))
            : []
          return activeApprovals([...event.items, ...retained])
        })
        setPendingApprovalsLoading(false)
        lastNotificationStreamErrorRef.current = null
        return
      }
      if (event.type === 'approval.requested') {
        setPendingApprovals(current => upsertApproval(current, event.approval))
        setPendingApprovalsLoading(false)
        lastNotificationStreamErrorRef.current = null
        return
      }
      if (event.type === 'approval.updated') {
        setPendingApprovals(current =>
          current.filter(approval => approval.id !== event.approvalRequestId)
        )
        return
      }
      if (isSdkNotificationStreamEvent(event)) {
        const { notification } = event
        const text = notification.body.trim() || notification.title.trim()
        const deliveryContext = { activeChatVisible: false }
        const deliverInApp = canDeliverChatResponseNotification('inApp', deliveryContext)
        const deliverOnDesktop = canDeliverChatResponseNotification('desktop', deliveryContext)
        if (deliverInApp) {
          pushNotification({
            kind: 'sdk_notification',
            agentName: notification.recipeName,
            text,
            timestamp: Date.now(),
            dedupeKey: `plugin_workload_sdk.notification:${notification.notificationId}`,
            sdk: {
              deliveryId: event.id,
              notificationId: notification.notificationId,
              recipeNamespace: notification.recipeNamespace,
              recipeName: notification.recipeName,
              callerRef: notification.callerRef,
              eventType: notification.eventType,
              title: notification.title,
              body: notification.body,
            },
          })
        }
        // Confirm desktop receipt to the server first, independent of the local
        // OS-notification decision below: the delivery is acknowledged because
        // the desktop received it. In-app and native channel preferences only
        // control local presentation. Keeping the ack ahead of (and decoupled
        // from) showDesktopNotification ensures a display gate or native failure
        // can never suppress the receipt acknowledgement.
        void window.clerum.notifications.ack(event.id).catch(error => {
          console.warn('[useNotificationsController] sdk notification ack failed', error)
        })
        if (deliverOnDesktop) {
          void showDesktopNotification({
            title: notification.title || notification.recipeName,
            body: notification.body || text,
            tag: `sdk-notification:${notification.notificationId}`,
            silent: true,
          }).then(permission => {
            if (!deliverInApp && permission === 'granted') {
              playNotificationSound()
            }
          })
        }
        lastNotificationStreamErrorRef.current = null
        return
      }
      if (isWorkflowRunCompletedStreamEvent(event)) {
        const { workflowRun } = event
        pushNotification({
          kind: 'workflow_completed',
          agentName: 'Workflows',
          text: workflowCompletionText(workflowRun),
          timestamp: workflowCompletionTimestamp(workflowRun),
          teamId: workflowRun.target.teamId ?? undefined,
          teamName: workflowRun.target.teamName ?? undefined,
          dedupeKey:
            'workflow.run.completed:' + workflowRun.workflowRunId + ':' + workflowRun.phase,
          workflow: {
            namespace: workflowRun.recipeNamespace,
            name: workflowRun.recipeName,
            runId: workflowRun.workflowRunId,
            approvalRequestId: workflowRun.approvalRequestId,
            phase: workflowRun.phase,
            completedAt: workflowRun.completedAt,
          },
        })
        setPendingApprovals(current =>
          current.filter(approval => approval.id !== workflowRun.approvalRequestId)
        )
        lastNotificationStreamErrorRef.current = null
        return
      }
      if (event.type === 'stream.closing') {
        setStatus('Notification stream is reconnecting.', 'info', undefined, {
          global: false,
          toast: false,
        })
        return
      }
      if (event.type === 'error') {
        const message = `Notification stream degraded: ${event.message}`
        if (lastNotificationStreamErrorRef.current !== message) {
          lastNotificationStreamErrorRef.current = message
          setStatus(message, 'error', undefined, { global: false, toast: true })
        }
      }
    }

    window.clerum.notifications
      .subscribe(handleStreamEvent)
      .then(stop => {
        if (disposed) {
          void stop()
          return
        }
        unsubscribe = stop
      })
      .catch(error => {
        if (disposed) return
        setPendingApprovalsLoading(false)
        const message = `Notification stream unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
        lastNotificationStreamErrorRef.current = message
        setStatus(message, 'error', undefined, { global: false, toast: true })
      })

    return () => {
      disposed = true
      setPendingApprovalsLoading(false)
      if (unsubscribe) void unsubscribe()
    }
  }, [
    canDeliverChatResponseNotification,
    isAuthenticated,
    playNotificationSound,
    pushNotification,
    setStatus,
    showDesktopNotification,
  ])

  const handleDecidePendingApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny') => {
      const approval = pendingApprovals.find(item => item.id === approvalId) ?? null
      try {
        setPendingApprovalActionId(approvalId)
        const result = await window.clerum.approvals.decide(approvalId, decision, undefined, {
          teamId: approval?.target.teamId,
        })
        setPendingApprovals(current => current.filter(item => item.id !== approvalId))
        if (approval) {
          void Promise.resolve(onWorkflowApprovalDecision?.({ approval, decision, result })).catch(
            error => {
              console.warn(
                '[useNotificationsController] workflow approval decision refresh failed',
                error
              )
            }
          )
        }
        setStatus(
          decision === 'approve' && result.run
            ? 'Approval accepted. Workflow run queued.'
            : decision === 'approve'
              ? 'Approval accepted.'
              : 'Approval denied.',
          'success',
          undefined,
          { global: false, toast: true }
        )
        void handleRefreshPendingApprovals({ silent: true })
      } catch (error) {
        setStatus(
          `Approval action failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      } finally {
        setPendingApprovalActionId(null)
      }
    },
    [handleRefreshPendingApprovals, onWorkflowApprovalDecision, pendingApprovals, setStatus]
  )

  const resetNotifications = useCallback(() => {
    setNotifications([])
    setNotificationActionById({})
    setPendingApprovals([])
    setPendingApprovalsLoading(false)
    setPendingApprovalActionId(null)
  }, [])

  return {
    notifications,
    notificationActionById,
    pendingApprovals,
    pendingApprovalsLoading,
    pendingApprovalActionId,
    unreadNotificationCount,
    setPendingApprovals,
    pushNotification,
    markNotificationsRead,
    markNotificationRead,
    clearNotifications,
    removeNotification,
    resolveApprovalNotification,
    handleApproveNotification,
    handleDenyNotification,
    handleRefreshPendingApprovals,
    handleDecidePendingApproval,
    playNotificationSound,
    resetNotifications,
  }
}

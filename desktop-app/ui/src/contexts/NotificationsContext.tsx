import { createContext, useContext } from 'react'
import type { PendingWorkflowApproval } from '../../../src/types'
import type { ApprovalDecisionTarget } from '../hooks/domain/approvalDecision'
import type { AppNotification, ToastMessage } from '../uiTypes'

export interface NotificationsContextValue {
  notifications: AppNotification[]
  unreadNotificationCount: number
  notificationActionById: Record<string, 'approving' | 'denying' | undefined>
  pendingApprovals: PendingWorkflowApproval[]
  pendingApprovalsLoading: boolean
  pendingApprovalActionId: string | null
  toasts: ToastMessage[]
  markNotificationsRead: () => void
  clearNotifications: () => void
  removeNotification: (notificationId: string) => void
  resolveApprovalNotification: (input: {
    agentName: string
    taskId: string
    requestId: string
    state: 'approved' | 'denied'
  }) => void
  /** §4.7.4: central approval decider — the in-chat gate and in-flight placeholder
   *  funnel through it so the chat FSM badge converges from every surface. */
  decideApproval: (target: ApprovalDecisionTarget) => Promise<void>
  handleOpenNotification: (notification: AppNotification) => Promise<void>
  handleApproveNotification: (notification: AppNotification) => Promise<void>
  handleDenyNotification: (notification: AppNotification) => Promise<void>
  handleRefreshPendingApprovals: (options?: { silent?: boolean }) => Promise<void>
  handleDecidePendingApproval: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function useNotificationsContext(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext)
  if (!ctx)
    throw new Error('useNotificationsContext must be used within NotificationsContext.Provider')
  return ctx
}

export { NotificationsContext }

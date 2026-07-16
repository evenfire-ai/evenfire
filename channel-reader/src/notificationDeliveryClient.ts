export type NotificationDeliveryMedium = 'telegram' | 'slack' | 'teams'

type NotificationDeliveryBase = {
  id: string
  medium: NotificationDeliveryMedium
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId: string
  attempts: number
}

export type ApprovalRequestedNotificationDelivery = NotificationDeliveryBase & {
  eventType: 'approval.requested'
  payload: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    title: string
    body: string
    actions?: Array<{ id: string; label: string }>
    metadata?: Record<string, unknown> | null
  }
}

export type ApprovalUpdatedNotificationDelivery = NotificationDeliveryBase & {
  eventType: 'approval.updated'
  payload: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
  }
}

export type WorkflowRunCompletedNotificationDelivery = NotificationDeliveryBase & {
  eventType: 'workflow.run.completed'
  payload: {
    workflowRunId: string
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    phase: 'Succeeded' | 'Failed' | 'Canceled'
    providerMedium: NotificationDeliveryMedium
    providerChannelId: string
    providerWorkspaceId?: string | null
    providerConversationId?: string | null
    providerThreadId?: string | null
    hasDownloadableItems?: boolean
    completedAt?: string
    message?: string
  }
}

export type PluginWorkloadSdkNotificationDelivery = NotificationDeliveryBase & {
  eventType: 'plugin_workload_sdk.notification'
  payload: {
    notificationId: string
    origin: 'plugin_workload_sdk'
    recipeNamespace: string
    recipeName: string
    callerRef: string
    eventType: string
    title: string
    body: string
    data?: Record<string, unknown> | null
    actionRef?: { type: string; id: string; urlRef?: string } | null
    deliveryPolicyRef?: string | null
  }
}

export type NotificationDelivery =
  | ApprovalRequestedNotificationDelivery
  | ApprovalUpdatedNotificationDelivery
  | WorkflowRunCompletedNotificationDelivery
  | PluginWorkloadSdkNotificationDelivery

type FetchDeliveriesResponse = {
  deliveries?: NotificationDelivery[]
}

export interface NotificationDeliveryClient {
  fetchDeliveries(params: {
    medium: NotificationDeliveryMedium
    providerChannelIds: string[]
    providerWorkspaceId?: string | null
    hostRef: string
    limit: number
  }): Promise<NotificationDelivery[]>

  acknowledge(
    id: string,
    params: {
      medium: NotificationDeliveryMedium
      providerUserId: string
      providerChannelId: string
      providerWorkspaceId?: string | null
      hostRef: string
    }
  ): Promise<void>

  fail(
    id: string,
    params: {
      medium: NotificationDeliveryMedium
      providerUserId: string
      providerChannelId: string
      providerWorkspaceId?: string | null
      hostRef: string
    }
  ): Promise<void>
}

export type { FetchDeliveriesResponse }

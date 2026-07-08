import { config } from './config'
import {
  type NotificationDelivery,
  type NotificationDeliveryClient,
  type NotificationDeliveryMedium,
} from './notificationDeliveryClient'
import type { RPCClient } from './rpcClient'
import type { ChannelAdapter, CommunicationChannelCRD, Message, ProviderIdentity } from './types'
import type {
  WorkflowApprovalDecisionCallbackCommand,
  WorkflowApprovalDecisionCommand,
} from './workflowApprovalDecision'
import { formatNotificationDelivery } from './workflowApprovalNotificationFormatter'
import { WorkflowApprovalPendingApprovals } from './workflowApprovalPendingApprovals'
import {
  getConfiguredProviderChannelGroups,
  hostRefForProviderIdentity,
} from './workflowApprovalProviderChannels'

type WorkflowApprovalRpcClient = Pick<
  RPCClient,
  'sendWorkflowApprovalDecision' | 'resolveWorkflowApproval'
>

type WorkflowApprovalNotificationClient = Pick<
  NotificationDeliveryClient,
  'fetchDeliveries' | 'acknowledge' | 'fail'
>

export type WorkflowApprovalCoordinatorOptions = {
  rpcClient: WorkflowApprovalRpcClient
  notificationDeliveryClient: WorkflowApprovalNotificationClient | null
  getAdapters: () => Map<string, ChannelAdapter>
  getAdapterForChannel?: (
    medium: NotificationDeliveryMedium,
    channelRef: { namespace: string; name: string }
  ) => ChannelAdapter | undefined
  getChannels: () => CommunicationChannelCRD[]
  sendReply: (message: Message, content: string) => Promise<void>
}

export class WorkflowApprovalCoordinator {
  private readonly rpcClient: WorkflowApprovalRpcClient
  private readonly notificationDeliveryClient: WorkflowApprovalNotificationClient | null
  private readonly getAdapters: () => Map<string, ChannelAdapter>
  private readonly getAdapterForChannel:
    | ((
        medium: NotificationDeliveryMedium,
        channelRef: { namespace: string; name: string }
      ) => ChannelAdapter | undefined)
    | null
  private readonly getChannels: () => CommunicationChannelCRD[]
  private readonly sendReply: (message: Message, content: string) => Promise<void>
  private readonly pendingWorkflowApprovals = new WorkflowApprovalPendingApprovals()

  constructor(options: WorkflowApprovalCoordinatorOptions) {
    this.rpcClient = options.rpcClient
    this.notificationDeliveryClient = options.notificationDeliveryClient
    this.getAdapters = options.getAdapters
    this.getAdapterForChannel = options.getAdapterForChannel ?? null
    this.getChannels = options.getChannels
    this.sendReply = options.sendReply
  }

  async handleDecisionCommand(
    msg: Message,
    command: WorkflowApprovalDecisionCommand | null
  ): Promise<void> {
    if (!command) return
    if (
      command.providerIdentity.medium === 'slack' &&
      !command.providerIdentity.providerWorkspaceId
    ) {
      await this.sendReply(msg, 'Unable to verify Slack workspace identity for this approval.')
      return
    }

    const resolvedCommand = await this.resolveDecisionCommand(msg, command)
    if (!resolvedCommand) return

    const decisionPayload = {
      approvalRequestId: resolvedCommand.approvalRequestId,
      decision: resolvedCommand.decision,
      providerIdentity: resolvedCommand.providerIdentity,
      ...(resolvedCommand.note ? { note: resolvedCommand.note } : {}),
    }
    const result = await this.rpcClient.sendWorkflowApprovalDecision(decisionPayload)
    if (!result.success) {
      await this.sendReply(
        msg,
        `Failed to record workflow approval: ${result.error ?? 'unknown error'}`
      )
      return
    }

    this.pendingWorkflowApprovals.forget(resolvedCommand.approvalRequestId)
    const action = command.decision === 'approve' ? 'Approved' : 'Denied'
    await this.sendReply(
      msg,
      result.duplicate
        ? `${action}. This provider decision was already processed.`
        : `${action}. Workflow approval recorded.`
    )
  }

  async handleDecisionCallback(
    msg: Message,
    command: WorkflowApprovalDecisionCallbackCommand | null
  ): Promise<void> {
    if (!command) return
    if (
      command.providerIdentity.medium === 'slack' &&
      !command.providerIdentity.providerWorkspaceId
    ) {
      await this.sendReply(msg, 'Unable to verify Slack workspace identity for this approval.')
      return
    }

    const decisionPayload = {
      approvalRequestId: command.approvalRequestId,
      decision: command.decision,
      providerIdentity: command.providerIdentity,
      ...(command.note ? { note: command.note } : {}),
    }
    const result = await this.rpcClient.sendWorkflowApprovalDecision(decisionPayload)
    if (!result.success) {
      await this.sendReply(
        msg,
        `Failed to record workflow approval: ${result.error ?? 'unknown error'}`
      )
      return
    }

    this.pendingWorkflowApprovals.forget(command.approvalRequestId)
    const action = command.decision === 'approve' ? 'Approved' : 'Denied'
    await this.sendReply(
      msg,
      result.duplicate
        ? `${action}. This provider decision was already processed.`
        : `${action}. Workflow approval recorded.`
    )
  }

  async pollNotifications(): Promise<void> {
    if (!this.notificationDeliveryClient) return

    for (const medium of ['telegram', 'slack'] as const) {
      const providerChannelGroups = getConfiguredProviderChannelGroups(medium, this.getChannels())
      if (providerChannelGroups.length === 0) continue

      for (const providerChannelGroup of providerChannelGroups) {
        const adapter =
          this.getAdapterForChannel?.(medium, {
            namespace: providerChannelGroup.communicationChannelNamespace,
            name: providerChannelGroup.communicationChannelName,
          }) ?? this.getAdapters().get(medium)
        if (!adapter) continue

        let deliveries: NotificationDelivery[]
        try {
          deliveries = await this.notificationDeliveryClient.fetchDeliveries({
            medium,
            providerChannelIds: providerChannelGroup.providerChannelIds,
            providerWorkspaceId: providerChannelGroup.providerWorkspaceId,
            hostRef: providerChannelGroup.hostRef,
            limit: config.notificationDeliveryPollLimit,
          })
        } catch (err) {
          console.error(`[WorkflowApproval] Failed to fetch ${medium} notifications:`, err)
          continue
        }

        for (const delivery of deliveries) {
          await this.deliverNotification(adapter, delivery, medium, providerChannelGroup.hostRef, {
            namespace: providerChannelGroup.communicationChannelNamespace,
            name: providerChannelGroup.communicationChannelName,
          })
        }
      }
    }
  }

  private async deliverNotification(
    adapter: ChannelAdapter,
    delivery: NotificationDelivery,
    medium: NotificationDeliveryMedium,
    hostRef: string,
    channelRef: { namespace: string; name: string }
  ): Promise<void> {
    try {
      if (delivery.eventType === 'approval.updated') {
        this.pendingWorkflowApprovals.forget(delivery.payload.approvalRequestId)
        await this.notificationDeliveryClient?.acknowledge(delivery.id, {
          medium,
          providerUserId: delivery.providerUserId,
          providerChannelId: delivery.providerChannelId,
          providerWorkspaceId: delivery.providerWorkspaceId,
          hostRef,
        })
        return
      }

      const message = formatNotificationDelivery(delivery, {
        communicationChannelRef: `${channelRef.namespace}/${channelRef.name}`,
      })
      await adapter.sendMessage(
        delivery.providerChannelId,
        message.content,
        undefined,
        undefined,
        message.sendOptions
      )
      if (delivery.eventType === 'approval.requested') {
        this.pendingWorkflowApprovals.track(delivery)
      }
      await this.notificationDeliveryClient?.acknowledge(delivery.id, {
        medium,
        providerUserId: delivery.providerUserId,
        providerChannelId: delivery.providerChannelId,
        providerWorkspaceId: delivery.providerWorkspaceId,
        hostRef,
      })
    } catch (err) {
      console.error(`[WorkflowApproval] Failed to deliver notification ${delivery.id}:`, err)
      try {
        await this.notificationDeliveryClient?.fail(delivery.id, {
          medium,
          providerUserId: delivery.providerUserId,
          providerChannelId: delivery.providerChannelId,
          providerWorkspaceId: delivery.providerWorkspaceId,
          hostRef,
        })
      } catch (failErr) {
        console.error(
          `[WorkflowApproval] Failed to record notification delivery failure ${delivery.id}:`,
          failErr
        )
      }
    }
  }

  private async resolveDecisionCommand(
    msg: Message,
    command: WorkflowApprovalDecisionCommand
  ): Promise<(WorkflowApprovalDecisionCommand & { approvalRequestId: string }) | null> {
    const recipeName = command.recipeName.trim()
    if (!recipeName) return null

    const approvals = this.pendingWorkflowApprovals.list(command.providerIdentity, recipeName)
    if (approvals.length === 0) {
      let restoredApprovalRequestId: string | null
      try {
        restoredApprovalRequestId = await this.resolvePendingApprovalFromRuntime(
          command.providerIdentity,
          recipeName
        )
      } catch (err) {
        console.error(
          `[WorkflowApproval] Failed to resolve pending approval through mcp-host:`,
          err
        )
        await this.sendReply(
          msg,
          `Could not verify the pending workflow approval for ${recipeName}. Try again after the approval request is delivered.`
        )
        return null
      }
      if (restoredApprovalRequestId) {
        return { ...command, approvalRequestId: restoredApprovalRequestId }
      }
      await this.sendReply(
        msg,
        `No pending workflow approval found for ${recipeName}. Use the workflow name shown in the approval request.`
      )
      return null
    }
    if (approvals.length > 1) {
      let restoredApprovalRequestId: string | null
      try {
        restoredApprovalRequestId = await this.resolvePendingApprovalFromRuntime(
          command.providerIdentity,
          recipeName
        )
      } catch (err) {
        console.error(
          `[WorkflowApproval] Failed to reconcile ambiguous pending workflow approvals through mcp-host:`,
          err
        )
        const message = err instanceof Error ? err.message : ''
        await this.sendReply(
          msg,
          message === 'pending_workflow_approval_ambiguous'
            ? `More than one pending workflow approval was found for ${recipeName}. Use the approval button on the specific request.`
            : `Could not verify the pending workflow approval for ${recipeName}. Try again after the approval request is delivered.`
        )
        return null
      }
      if (restoredApprovalRequestId) {
        this.pendingWorkflowApprovals.replace(
          command.providerIdentity,
          recipeName,
          restoredApprovalRequestId
        )
        return { ...command, approvalRequestId: restoredApprovalRequestId }
      }
      this.pendingWorkflowApprovals.clear(command.providerIdentity, recipeName)
      await this.sendReply(
        msg,
        `No pending workflow approval found for ${recipeName}. Use the workflow name shown in the approval request.`
      )
      return null
    }

    return { ...command, approvalRequestId: approvals[0].approvalRequestId }
  }

  private async resolvePendingApprovalFromRuntime(
    identity: ProviderIdentity,
    recipeName: string
  ): Promise<string | null> {
    const hostRef = hostRefForProviderIdentity(identity, this.getChannels())
    if (!hostRef) return null
    const resolved = await this.rpcClient.resolveWorkflowApproval({
      recipeName,
      providerIdentity: identity,
    })
    return resolved?.approvalRequestId ?? null
  }
}

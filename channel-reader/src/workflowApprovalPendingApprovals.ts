import type { ApprovalRequestedNotificationDelivery } from './notificationDeliveryClient'
import type { ProviderIdentity } from './types'

type PendingWorkflowApprovalState = {
  approvalRequestId: string
  createdAt: Date
}

/** Stale workflow approval command bindings are cleaned up after this interval. */
const PENDING_WORKFLOW_APPROVAL_TTL_MS = 10 * 60 * 1000

function workflowApprovalKey(identity: ProviderIdentity, recipeName: string): string {
  return [
    identity.medium,
    identity.providerWorkspaceId ?? '',
    identity.providerChannelId,
    identity.providerUserId,
    recipeName,
  ].join('\0')
}

export class WorkflowApprovalPendingApprovals {
  private readonly approvalsByKey = new Map<string, PendingWorkflowApprovalState[]>()

  track(delivery: ApprovalRequestedNotificationDelivery): void {
    this.prune()
    const identity: ProviderIdentity = {
      medium: delivery.medium,
      providerUserId: delivery.providerUserId,
      providerWorkspaceId: delivery.providerWorkspaceId,
      providerChannelId: delivery.providerChannelId,
      providerEventId: '',
    }
    const key = workflowApprovalKey(identity, delivery.payload.recipeName)
    const existing = this.approvalsByKey.get(key) ?? []
    const next = existing.filter(
      approval => approval.approvalRequestId !== delivery.payload.approvalRequestId
    )
    next.push({
      approvalRequestId: delivery.payload.approvalRequestId,
      createdAt: new Date(),
    })
    this.approvalsByKey.set(key, next)
  }

  list(identity: ProviderIdentity, recipeName: string): PendingWorkflowApprovalState[] {
    this.prune()
    return this.approvalsByKey.get(workflowApprovalKey(identity, recipeName)) ?? []
  }

  replace(identity: ProviderIdentity, recipeName: string, approvalRequestId: string): void {
    this.prune()
    this.approvalsByKey.set(workflowApprovalKey(identity, recipeName), [
      { approvalRequestId, createdAt: new Date() },
    ])
  }

  clear(identity: ProviderIdentity, recipeName: string): void {
    this.approvalsByKey.delete(workflowApprovalKey(identity, recipeName))
  }

  forget(approvalRequestId: string): void {
    for (const [key, approvals] of this.approvalsByKey) {
      const remaining = approvals.filter(
        approval => approval.approvalRequestId !== approvalRequestId
      )
      if (remaining.length > 0) {
        this.approvalsByKey.set(key, remaining)
      } else {
        this.approvalsByKey.delete(key)
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_WORKFLOW_APPROVAL_TTL_MS
    for (const [key, approvals] of this.approvalsByKey) {
      const active = approvals.filter(approval => approval.createdAt.getTime() >= cutoff)
      if (active.length > 0) {
        this.approvalsByKey.set(key, active)
      } else {
        this.approvalsByKey.delete(key)
      }
    }
  }
}

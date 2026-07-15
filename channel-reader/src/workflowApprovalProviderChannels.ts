import type { NotificationDeliveryMedium } from './notificationDeliveryClient'
import type { CommunicationChannelCRD, ProviderIdentity } from './types'

export type ConfiguredProviderChannelGroup = {
  hostRef: string
  providerChannelIds: string[]
  providerWorkspaceId?: string | null
  communicationChannelNamespace: string
  communicationChannelName: string
}

export function hostRefForProviderIdentity(
  identity: ProviderIdentity,
  channels: CommunicationChannelCRD[]
): string | null {
  const targetHostRef = identity.providerTarget?.hostRef?.trim()
  if (targetHostRef) return targetHostRef

  for (const channelCRD of channels) {
    const hostRef = channelCRD.spec.hostRef?.trim()
    if (!hostRef) continue
    if (identity.medium === 'telegram') {
      const group = channelCRD.spec.telegram?.find(
        item => item.channelId === identity.providerChannelId
      )
      if (group) return hostRef
    }
    if (identity.medium === 'slack') {
      const group = channelCRD.spec.slack?.find(
        item =>
          item.channelId === identity.providerChannelId &&
          item.workspaceId === identity.providerWorkspaceId
      )
      if (group) return hostRef
    }
    if (identity.medium === 'teams') {
      const group = channelCRD.spec.teams?.find(
        item =>
          item.channelId === identity.providerChannelId &&
          item.tenantId === identity.providerWorkspaceId
      )
      if (group) return hostRef
    }
  }
  return null
}

export function getConfiguredProviderChannelGroups(
  medium: NotificationDeliveryMedium,
  channels: CommunicationChannelCRD[]
): ConfiguredProviderChannelGroup[] {
  const byBinding = new Map<
    string,
    {
      hostRef: string
      providerWorkspaceId?: string | null
      communicationChannelNamespace: string
      communicationChannelName: string
      providerChannelIds: Set<string>
    }
  >()
  for (const channelCRD of channels) {
    const hostRef = channelCRD.spec.hostRef?.trim()
    if (!hostRef) continue
    const communicationChannelNamespace = channelCRD.namespace?.trim()
    const communicationChannelName = channelCRD.name?.trim()
    if (!communicationChannelNamespace || !communicationChannelName) continue
    const groups =
      medium === 'telegram'
        ? channelCRD.spec.telegram
        : medium === 'slack'
          ? channelCRD.spec.slack
          : channelCRD.spec.teams
    for (const group of groups ?? []) {
      const channelId = group.channelId?.trim()
      if (!channelId) continue
      const providerWorkspaceId =
        medium === 'slack' && 'workspaceId' in group && typeof group.workspaceId === 'string'
          ? group.workspaceId.trim()
          : medium === 'teams' && 'tenantId' in group && typeof group.tenantId === 'string'
            ? group.tenantId.trim()
            : null
      if ((medium === 'slack' || medium === 'teams') && !providerWorkspaceId) {
        console.warn(
          `[WorkflowApproval] Skipping ${medium} notification delivery group ${channelCRD.namespace}/${channelCRD.name} channel ${channelId}: workspace/tenant id is required for workflow approval delivery.`
        )
        continue
      }
      // Keep delivery groups scoped to the owning CommunicationChannel. This is required for
      // per-channel adapter routing and access boundaries, and intentionally means Slack CCs
      // in the same workspace are polled separately instead of merged by workspace only.
      const key = [
        medium,
        hostRef,
        providerWorkspaceId ?? '',
        communicationChannelNamespace,
        communicationChannelName,
      ].join('\0')
      const existing = byBinding.get(key) ?? {
        hostRef,
        providerWorkspaceId,
        communicationChannelNamespace,
        communicationChannelName,
        providerChannelIds: new Set<string>(),
      }
      existing.providerChannelIds.add(channelId)
      byBinding.set(key, existing)
    }
  }
  return Array.from(byBinding.values()).map(group => ({
    hostRef: group.hostRef,
    providerWorkspaceId: group.providerWorkspaceId,
    communicationChannelNamespace: group.communicationChannelNamespace,
    communicationChannelName: group.communicationChannelName,
    providerChannelIds: Array.from(group.providerChannelIds),
  }))
}

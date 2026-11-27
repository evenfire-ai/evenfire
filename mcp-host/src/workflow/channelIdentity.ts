import { WorkflowBrokerRequestError } from '../core/tools/workflowBrokerClient'
import type { ProviderIdentity } from '../server/types'

export type ExternalChannelType = 'telegram' | 'slack' | 'teams'

export function isExternalChannelType(
  channelType: string | null | undefined
): channelType is ExternalChannelType {
  return channelType === 'telegram' || channelType === 'slack' || channelType === 'teams'
}

/**
 * Minimal allowlisted `ProviderIdentity` persisted on approvals, tasks, and
 * pending results (`X11`). Strips volatile per-delivery fields (`providerEventId`)
 * and any unexpected caller-supplied keys.
 */
export function allowlistProviderIdentity(
  identity: ProviderIdentity | undefined | null
): ProviderIdentity | undefined {
  if (!identity || !isExternalChannelType(identity.medium)) return undefined
  const providerUserId = typeof identity.providerUserId === 'string' ? identity.providerUserId : ''
  const providerChannelId =
    typeof identity.providerChannelId === 'string' ? identity.providerChannelId : ''
  if (!providerUserId.trim() || !providerChannelId.trim()) return undefined

  let providerTarget: ProviderIdentity['providerTarget']
  if (identity.providerTarget && typeof identity.providerTarget === 'object') {
    const t = identity.providerTarget
    if (
      typeof t.hostRef === 'string' &&
      typeof t.communicationChannelNamespace === 'string' &&
      typeof t.communicationChannelName === 'string'
    ) {
      providerTarget = {
        hostRef: t.hostRef,
        communicationChannelNamespace: t.communicationChannelNamespace,
        communicationChannelName: t.communicationChannelName,
        ...(typeof t.providerBotId === 'string' || t.providerBotId === null
          ? { providerBotId: t.providerBotId }
          : {}),
        ...(typeof t.providerBotUsername === 'string' || t.providerBotUsername === null
          ? { providerBotUsername: t.providerBotUsername }
          : {}),
      }
    }
  }

  return {
    medium: identity.medium,
    providerUserId,
    ...(identity.providerWorkspaceId !== undefined
      ? { providerWorkspaceId: identity.providerWorkspaceId }
      : {}),
    providerChannelId,
    ...(identity.providerChannelType !== undefined
      ? { providerChannelType: identity.providerChannelType }
      : {}),
    ...(providerTarget !== undefined ? { providerTarget } : {}),
  }
}

/**
 * Workspace or Telegram bot-target isolation key (`X11`, `R80`).
 * Uses `providerWorkspaceId` for Slack/Teams, falling back to
 * `communicationChannelNamespace/communicationChannelName` (or `hostRef`)
 * from `providerTarget` for Telegram so reconciliation never crosses
 * workspaces, tenants, or bots.
 */
export function workspaceOrTargetKeyForIdentity(
  identity: ProviderIdentity | undefined | null
): string | undefined {
  if (!identity) return undefined
  const workspaceId = identity.providerWorkspaceId?.trim()
  if (workspaceId) return workspaceId
  const target = identity.providerTarget
  if (!target) return undefined
  const ns = target.communicationChannelNamespace?.trim()
  const name = target.communicationChannelName?.trim()
  if (ns && name) return `${ns}/${name}`
  const hostRef = target.hostRef?.trim()
  return hostRef || undefined
}

export type DetailedAuthorizationFailure = 'account_unresolved' | 'channel_access_denied' | 'error'

/**
 * Each broker code is bound to the exact HTTP status control-api emits it with.
 * Splits `404 medium_account_not_found` (`account_unresolved`, workspace-wide)
 * from `403 communication_channel_access_denied` (`channel_access_denied`,
 * single-channel) while preserving `'error'` for 5xx/timeouts/unrecognized codes
 * (`X11`, `R80`).
 */
export function classifyAuthorizationFailureDetailed(error: unknown): DetailedAuthorizationFailure {
  if (error instanceof WorkflowBrokerRequestError && error.code) {
    if (error.code === 'medium_account_not_found' && error.status === 404) {
      return 'account_unresolved'
    }
    if (error.code === 'communication_channel_access_denied' && error.status === 403) {
      return 'channel_access_denied'
    }
  }
  return 'error'
}

export interface ChannelReconcileFilter {
  medium: ExternalChannelType
  workspaceOrTargetKey?: string | null
  providerUserId: string
  /** `null` = workspace/target-wide (`resolved` or `404`); string = single denied channel (`403`). */
  channelScope: string | null
  /** `null` = revoked (matches all in scope); string = resolved live user (matches `linkedUserId !== liveLinkedUserId`). */
  liveLinkedUserId: string | null
}

export interface ChannelIdentityScopedRecord {
  medium?: string | null
  workspaceOrTargetKey?: string | null
  providerUserId?: string | null
  providerChannelId?: string | null
  linkedUserId?: string | null
}

/**
 * Strict scope predicate for `AgentStateMachine.reconcileChannelIdentity` (`R80`).
 */
export function matchesChannelReconcileTarget(
  record: ChannelIdentityScopedRecord,
  filter: ChannelReconcileFilter
): boolean {
  if (record.medium !== filter.medium) return false
  if (record.providerUserId !== filter.providerUserId) return false

  const filterWs = filter.workspaceOrTargetKey?.trim() || null
  const recordWs = record.workspaceOrTargetKey?.trim() || null
  if (filterWs !== null || recordWs !== null) {
    if (filterWs !== recordWs) return false
  }

  if (filter.channelScope !== null) {
    if (record.providerChannelId !== filter.channelScope) return false
  }

  if (filter.liveLinkedUserId === null) {
    return true
  }
  return (record.linkedUserId ?? null) !== filter.liveLinkedUserId
}

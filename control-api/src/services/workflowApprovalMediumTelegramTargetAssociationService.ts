import { pool } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { getUserAgents } from './directory/index.js'
import type { VerifiedMediumAccount } from './workflowApprovalMediumIdentityService.js'
import { removeSlackAssociations } from './workflowApprovalMediumSlackVerificationService.js'
import {
  type TelegramApprovalTarget,
  listTelegramApprovalTargets,
} from './workflowApprovalMediumTelegramVerificationService.js'

type CommunicationChannelResource = {
  metadata?: {
    name?: string
    namespace?: string
  }
  spec?: {
    hostRef?: unknown
    telegram?: unknown
  }
}

type TelegramGroup = {
  channelId?: string
  chatType?: string
  userIds?: string[]
  replyOnlyWhenMentioned?: boolean
  title?: string
  handle?: string
  confirmedByUserId?: string
  confirmedAt?: string
}

type TelegramIdentity = {
  userId?: string
  providerUserId: string
  providerChannelId: string
  providerChannelType?: string
  providerChannelTitle?: string | null
  providerChannelHandle?: string | null
}

export type TelegramTargetAssociationMutation =
  | { changed: false }
  | { changed: true; previousGroup: TelegramGroup | null }

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeTelegramGroups(value: unknown): TelegramGroup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(group => (group && typeof group === 'object' ? (group as TelegramGroup) : null))
    .filter((group): group is TelegramGroup => !!group)
}

function cloneTelegramGroup(group: TelegramGroup): TelegramGroup {
  return {
    ...group,
    userIds: Array.isArray(group.userIds) ? [...group.userIds] : undefined,
  }
}

function telegramSettings(value: unknown): { replyOnlyWhenMentioned?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return {
    replyOnlyWhenMentioned:
      (value as { replyOnlyWhenMentioned?: unknown }).replyOnlyWhenMentioned === true,
  }
}

function groupForIdentity(
  spec: Record<string, unknown>,
  identity: TelegramIdentity
): TelegramGroup {
  const settings = telegramSettings(spec.telegramSettings)
  return {
    channelId: identity.providerChannelId,
    chatType: identityChatType(identity),
    ...(settings.replyOnlyWhenMentioned ? { replyOnlyWhenMentioned: true } : {}),
    ...(identity.providerChannelTitle ? { title: identity.providerChannelTitle } : {}),
    ...(identity.providerChannelHandle ? { handle: identity.providerChannelHandle } : {}),
    confirmedByUserId: identity.userId || identity.providerUserId,
    confirmedAt: new Date().toISOString(),
  }
}

function identityChatType(identity: TelegramIdentity): string {
  return identity.providerChannelType || 'private'
}

function groupMatchesIdentityConversation(
  group: TelegramGroup,
  identity: TelegramIdentity
): boolean {
  return (
    optionalString(group.channelId) === identity.providerChannelId &&
    optionalString(group.chatType) === identityChatType(identity)
  )
}

function groupMatchesIdentityVerifier(group: TelegramGroup, identity: TelegramIdentity): boolean {
  const confirmedByUserId = optionalString(group.confirmedByUserId)
  if (identity.userId && confirmedByUserId === identity.userId) return true
  if (!identity.userId && confirmedByUserId === identity.providerUserId) return true
  return false
}

function groupMatchesIdentity(group: TelegramGroup, identity: TelegramIdentity): boolean {
  return (
    groupMatchesIdentityConversation(group, identity) &&
    groupMatchesIdentityVerifier(group, identity)
  )
}

export async function addTelegramTargetAssociation(
  gateway: K8sGateway,
  target: TelegramApprovalTarget,
  identity: TelegramIdentity
): Promise<TelegramTargetAssociationMutation> {
  let mutation: TelegramTargetAssociationMutation = { changed: false }
  await gateway.mutateResource(
    'communicationchannels',
    target.channelName,
    current => {
      const spec = current.spec ?? {}
      const telegram = normalizeTelegramGroups(spec.telegram)
      const existingIndex = telegram.findIndex(group => groupMatchesIdentity(group, identity))
      const nextGroup = groupForIdentity(spec, identity)
      if (existingIndex >= 0) {
        const existing = telegram[existingIndex]!
        const alreadyAssociated =
          existing.chatType === nextGroup.chatType &&
          existing.confirmedByUserId === nextGroup.confirmedByUserId &&
          existing.replyOnlyWhenMentioned === nextGroup.replyOnlyWhenMentioned &&
          optionalString(existing.title) === optionalString(nextGroup.title) &&
          optionalString(existing.handle) === optionalString(nextGroup.handle)
        if (alreadyAssociated) {
          mutation = { changed: false }
          return null
        }
        mutation = { changed: true, previousGroup: cloneTelegramGroup(existing) }
        const next = telegram.map((group, index) =>
          // Re-verification keeps the confirmed-user row as the single approval source.
          index === existingIndex ? { ...group, ...nextGroup, userIds: undefined } : group
        )
        return { spec: { ...spec, telegram: next } }
      }
      mutation = { changed: true, previousGroup: null }
      const next = [...telegram, nextGroup]
      return { spec: { ...spec, telegram: next } }
    },
    target.channelNamespace
  )
  return mutation
}

export async function removeTelegramAssociations(params: {
  gateway: K8sGateway
  userId: string
  providerChannelId: string
}): Promise<void> {
  const allowed = new Set((await getUserAgents(params.userId)).agentNames)
  const channels = (await params.gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  for (const channel of channels) {
    const name = optionalString(channel.metadata?.name)
    const namespace = optionalString(channel.metadata?.namespace)
    const hostRef = optionalString(channel.spec?.hostRef)
    if (!name || !namespace || !hostRef || !allowed.has(hostRef)) continue
    await params.gateway.mutateResource(
      'communicationchannels',
      name,
      current => {
        const spec = current.spec ?? {}
        const currentHostRef = optionalString(spec.hostRef)
        if (!currentHostRef || !allowed.has(currentHostRef)) return null
        const groups = normalizeTelegramGroups(spec.telegram)
        let changed = false
        const next = groups
          .map(group => {
            if (optionalString(group.channelId) !== params.providerChannelId) return group
            if (optionalString(group.confirmedByUserId) === params.userId) {
              changed = true
              return null
            }
            return group
          })
          .filter((group): group is TelegramGroup => !!group)
        return changed ? { spec: { ...spec, telegram: next } } : null
      },
      namespace
    )
  }
}

export async function removeTelegramTargetAssociation(
  gateway: K8sGateway,
  target: TelegramApprovalTarget,
  identity: TelegramIdentity,
  mutation: TelegramTargetAssociationMutation = { changed: true, previousGroup: null }
): Promise<void> {
  if (!mutation.changed) return
  await gateway.mutateResource(
    'communicationchannels',
    target.channelName,
    current => {
      const spec = current.spec ?? {}
      if (optionalString(spec.hostRef) !== target.agentName) return null
      const groups = normalizeTelegramGroups(spec.telegram)
      let changed = false
      let restoredPreviousGroup = false
      const next = groups
        .map(group => {
          if (!groupMatchesIdentityConversation(group, identity)) return group
          if (!groupMatchesIdentityVerifier(group, identity)) return group
          if (mutation.previousGroup) {
            if (restoredPreviousGroup) return group
            restoredPreviousGroup = true
            changed = true
            // TODO(v2): detect divergent admin edits before restoring this snapshot.
            return cloneTelegramGroup(mutation.previousGroup)
          }
          changed = true
          return null
        })
        .filter((group): group is TelegramGroup => !!group)
      return changed ? { spec: { ...spec, telegram: next } } : null
    },
    target.channelNamespace
  )
}

export async function attachTelegramTargetsToAccounts(
  gateway: K8sGateway,
  userId: string,
  accounts: VerifiedMediumAccount[]
): Promise<
  Array<
    VerifiedMediumAccount & {
      targets?: TelegramApprovalTarget[]
      providerChannelType?: string | null
      providerChannelTitle?: string | null
      providerChannelHandle?: string | null
    }
  >
> {
  const targets = await listTelegramApprovalTargets({ gateway, userId })
  const channels = (await gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  const targetByName = new Map(
    targets.items.map(target => [`${target.channelNamespace}/${target.channelName}`, target])
  )
  return accounts.map(account => {
    if (account.medium !== 'telegram' || !account.providerChannelId || account.disabledAt) {
      return { ...account, targets: [] }
    }
    const matched: TelegramApprovalTarget[] = []
    let matchedGroup: TelegramGroup | null = null
    for (const channel of channels) {
      const key = `${optionalString(channel.metadata?.namespace)}/${optionalString(channel.metadata?.name)}`
      const target = targetByName.get(key)
      if (!target) continue
      if (account.communicationChannelRef && account.communicationChannelRef !== key) continue
      const groups = normalizeTelegramGroups(channel.spec?.telegram)
      const group = groups.find(
        group =>
          optionalString(group.channelId) === account.providerChannelId &&
          optionalString(group.confirmedByUserId) === account.userId
      )
      if (group) {
        matched.push(target)
        matchedGroup = matchedGroup ?? group
      }
    }
    return {
      ...account,
      providerChannelType: matchedGroup?.chatType ?? null,
      providerChannelTitle: matchedGroup?.title ?? null,
      providerChannelHandle: matchedGroup?.handle ?? null,
      targets: matched,
    }
  })
}

export async function disableVerifiedMediumAccountWithTelegramAssociations(params: {
  gateway: K8sGateway
  userId: string
  accountId: string
}): Promise<boolean> {
  const current = await pool.query(
    `SELECT id,
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            disabled_at AS "disabledAt"
       FROM workflow_approval_medium_accounts
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [params.accountId, params.userId]
  )
  if ((current.rowCount ?? 0) === 0) return false
  const row = current.rows[0] as {
    medium: string
    providerUserId: string
    providerWorkspaceId: string | null
    providerChannelId: string | null
    disabledAt: string | null
  }
  if (row.disabledAt) {
    const deleted = await pool.query(
      `DELETE FROM workflow_approval_medium_accounts
        WHERE id = $1 AND user_id = $2 AND disabled_at IS NOT NULL`,
      [params.accountId, params.userId]
    )
    return (deleted.rowCount ?? 0) > 0
  }
  const disabled = await pool.query(
    `UPDATE workflow_approval_medium_accounts
        SET disabled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
    [params.accountId, params.userId]
  )
  if ((disabled.rowCount ?? 0) === 0) return false
  // Lifecycle: if this account was the user's preferred delivery instance, clear
  // it so routing degrades to the automatic default instead of silently blocking
  // delivery under the strict policy. The FK's ON DELETE SET NULL only fires on a
  // hard delete; this soft-disable path needs the explicit clear.
  await pool.query(
    `UPDATE user_notification_preferences
        SET preferred_account_id = NULL, updated_at = NOW()
      WHERE user_id = $1 AND preferred_account_id = $2`,
    [params.userId, params.accountId]
  )
  if (row.medium === 'telegram' && row.providerChannelId) {
    await removeTelegramAssociations({
      gateway: params.gateway,
      userId: params.userId,
      providerChannelId: row.providerChannelId,
    })
  }
  if (row.medium === 'slack' && row.providerChannelId) {
    await removeSlackAssociations({
      gateway: params.gateway,
      userId: params.userId,
      providerUserId: row.providerUserId,
      providerWorkspaceId: row.providerWorkspaceId,
      providerChannelId: row.providerChannelId,
    })
  }
  return true
}

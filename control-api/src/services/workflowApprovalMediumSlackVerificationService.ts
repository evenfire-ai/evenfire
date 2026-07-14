import type { K8sGateway } from '../k8s.js'
import { decodeSlackTargetId, encodeSlackTargetId } from '../utils/slackTargetId.js'
import { getTeamAgents, getUserAgents, listTeams } from './directory/index.js'
import type { VerifiedMediumAccount } from './workflowApprovalMediumIdentityService.js'

type CommunicationChannelResource = {
  metadata?: {
    annotations?: Record<string, string>
    name?: string
    namespace?: string
  }
  spec?: {
    access?: unknown
    credentialsSecretRef?: { name?: string }
    hostRef?: unknown
    slack?: unknown
    slackSettings?: unknown
  }
}

type SlackGroup = {
  channelId?: string
  workspaceId?: string
  userIds?: string[]
  userNames?: string[]
  replyOnlyWhenMentioned?: boolean
  confirmedByUserId?: string
  confirmedAt?: string
}

type CommunicationChannelAccess = {
  users: string[]
  teams: string[]
}

export type SlackApprovalTarget = {
  id: string
  medium: 'slack'
  agentName: string
  channelName: string
  channelNamespace: string
  botLabel: string
  botUsername: string | null
  botDeepLink: string | null
  providerWorkspaceId: string | null
  replyOnlyWhenMentioned: boolean
  status: 'ready'
}

type UserSlackTargetAccess = {
  agentNames: Set<string>
  teamIds: Set<string>
}

export type SlackIdentity = {
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
}

const SLACK_WORKSPACE_ID_RE = /^T[A-Z0-9]+$/

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: string[] = []
  for (const raw of value) {
    const normalized = String(raw ?? '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    items.push(normalized)
  }
  return items
}

function normalizeSlackGroups(value: unknown): SlackGroup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(group => (group && typeof group === 'object' ? (group as SlackGroup) : null))
    .filter((group): group is SlackGroup => !!group)
}

function normalizeChannelAccess(value: unknown): CommunicationChannelAccess {
  const access = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    users: normalizeStringArray(access.users),
    teams: normalizeStringArray(access.teams),
  }
}

function slackSettings(channel: CommunicationChannelResource): Record<string, unknown> {
  return channel.spec?.slackSettings &&
    typeof channel.spec.slackSettings === 'object' &&
    !Array.isArray(channel.spec.slackSettings)
    ? (channel.spec.slackSettings as Record<string, unknown>)
    : {}
}

function workspaceIdForChannel(channel: CommunicationChannelResource): string | null {
  const settingsWorkspaceId = optionalString(slackSettings(channel).workspaceId)
  if (settingsWorkspaceId) return settingsWorkspaceId
  for (const group of normalizeSlackGroups(channel.spec?.slack)) {
    const workspaceId = optionalString(group.workspaceId)
    if (workspaceId) return workspaceId
  }
  return null
}

function hasSlackProviderEnabled(channel: CommunicationChannelResource): boolean {
  if (normalizeSlackGroups(channel.spec?.slack).length > 0) return true
  const settings = slackSettings(channel)
  return ['workspaceId', 'botHandle', 'replyOnlyWhenMentioned', 'replyInThreads'].some(
    key => settings[key] !== undefined
  )
}

async function loadSlackTargetAccess(userId: string): Promise<UserSlackTargetAccess> {
  const [directAgents, teams] = await Promise.all([getUserAgents(userId), listTeams(userId, '')])
  const teamItems = Array.isArray(teams.items) ? teams.items : []
  const teamIds = new Set(teamItems.map(team => String(team.id)).filter(Boolean))
  const agentNames = new Set(directAgents.agentNames)
  await Promise.all(
    [...teamIds].map(async teamId => {
      const teamAgents = await getTeamAgents(teamId)
      for (const agentName of teamAgents.agentNames) {
        agentNames.add(agentName)
      }
    })
  )
  return { agentNames, teamIds }
}

function userCanAccessChannel(
  channel: CommunicationChannelResource,
  userId: string,
  access: UserSlackTargetAccess
): boolean {
  const hostRef = optionalString(channel.spec?.hostRef)
  if (!hostRef || !access.agentNames.has(hostRef)) return false
  const channelAccess = normalizeChannelAccess(channel.spec?.access)
  if (channelAccess.users.includes(userId)) return true
  return channelAccess.teams.some(teamId => access.teamIds.has(teamId))
}

function botHandleForChannel(channel: CommunicationChannelResource): string | null {
  const raw = optionalString(
    slackSettings(channel).botHandle ?? channel.metadata?.annotations?.['clerum.io/slack-bot-label']
  )
  if (!raw) return null
  const withoutAt = raw.replace(/^@/, '').trim()
  return withoutAt || null
}

function projectTarget(channel: CommunicationChannelResource): SlackApprovalTarget | null {
  const name = optionalString(channel.metadata?.name)
  const namespace = optionalString(channel.metadata?.namespace)
  const hostRef = optionalString(channel.spec?.hostRef)
  const credentialName = optionalString(channel.spec?.credentialsSecretRef?.name)
  const workspaceId = workspaceIdForChannel(channel)
  if (!name || !namespace || !hostRef || !credentialName || !hasSlackProviderEnabled(channel)) {
    return null
  }
  if (workspaceId && !SLACK_WORKSPACE_ID_RE.test(workspaceId)) return null
  const botHandle = botHandleForChannel(channel)
  const botLabel =
    optionalString(channel.metadata?.annotations?.['clerum.io/slack-bot-label']) ??
    (botHandle ? botHandle : `${name} Slack app`)
  return {
    id: encodeSlackTargetId(namespace, name),
    medium: 'slack',
    agentName: hostRef,
    channelName: name,
    channelNamespace: namespace,
    botLabel,
    botUsername: botHandle,
    botDeepLink: null,
    providerWorkspaceId: workspaceId,
    replyOnlyWhenMentioned: slackSettings(channel).replyOnlyWhenMentioned === true,
    status: 'ready',
  }
}

export async function listSlackApprovalTargets(params: {
  gateway: K8sGateway
  userId: string
}): Promise<{ items: SlackApprovalTarget[] }> {
  const access = await loadSlackTargetAccess(params.userId)
  if (access.agentNames.size === 0) return { items: [] }
  const channels = (await params.gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  const items = channels
    .flatMap(channel => {
      const target = projectTarget(channel)
      if (!target || !userCanAccessChannel(channel, params.userId, access)) return []
      return [target]
    })
    .sort(
      (a, b) =>
        a.agentName.localeCompare(b.agentName) ||
        a.channelNamespace.localeCompare(b.channelNamespace) ||
        a.channelName.localeCompare(b.channelName)
    )
  return { items }
}

export async function resolveSlackProviderEventTarget(params: {
  gateway: K8sGateway
  userId: string
  targetId: string
}): Promise<SlackApprovalTarget> {
  const decoded = decodeSlackTargetId(params.targetId)
  const channel = (await params.gateway.getResource(
    'communicationchannels',
    decoded.name,
    decoded.namespace
  )) as CommunicationChannelResource
  const target = projectTarget(channel)
  if (!target) throw new Error('slack_target_not_ready')
  const access = await loadSlackTargetAccess(params.userId)
  if (!userCanAccessChannel(channel, params.userId, access)) {
    throw new Error('slack_target_not_found')
  }
  if (target.id !== params.targetId) throw new Error('slack_target_not_found')
  return target
}

export async function userCanAccessSlackCommunicationChannel(params: {
  gateway: K8sGateway
  userId: string
  hostRef: string
  channelName: string
  channelNamespace: string
}): Promise<boolean> {
  let channel: CommunicationChannelResource
  try {
    channel = (await params.gateway.getResource(
      'communicationchannels',
      params.channelName,
      params.channelNamespace
    )) as CommunicationChannelResource
  } catch {
    return false
  }
  const target = projectTarget(channel)
  if (!target || target.agentName !== params.hostRef) return false
  const access = await loadSlackTargetAccess(params.userId)
  return userCanAccessChannel(channel, params.userId, access)
}

export async function resolveSlackCommunicationChannelTarget(params: {
  gateway: K8sGateway
  userId: string
  channelName: string
  channelNamespace: string
}): Promise<SlackApprovalTarget> {
  const channel = (await params.gateway.getResource(
    'communicationchannels',
    params.channelName,
    params.channelNamespace
  )) as CommunicationChannelResource
  const target = projectTarget(channel)
  if (!target) throw new Error('slack_target_not_ready')
  const access = await loadSlackTargetAccess(params.userId)
  if (!userCanAccessChannel(channel, params.userId, access)) {
    throw new Error('slack_target_not_found')
  }
  return target
}

export async function addSlackTargetAssociation(
  gateway: K8sGateway,
  target: SlackApprovalTarget,
  identity: SlackIdentity & { userId: string }
): Promise<void> {
  if (target.providerWorkspaceId && identity.providerWorkspaceId !== target.providerWorkspaceId) {
    throw new Error('slack_workspace_mismatch')
  }
  const confirmedAt = new Date().toISOString()
  await gateway.mutateResource(
    'communicationchannels',
    target.channelName,
    current => {
      const spec = {
        ...(current.spec ?? {}),
      } as Record<string, unknown>
      const settings =
        spec.slackSettings &&
        typeof spec.slackSettings === 'object' &&
        !Array.isArray(spec.slackSettings)
          ? (spec.slackSettings as Record<string, unknown>)
          : {}
      const groups = normalizeSlackGroups(spec.slack)
      const nextGroups = [...groups]
      const existingIndex = nextGroups.findIndex(
        group =>
          group.channelId === identity.providerChannelId &&
          group.workspaceId === identity.providerWorkspaceId
      )
      const existing = existingIndex >= 0 ? nextGroups[existingIndex]! : null
      const userIds = new Set(normalizeStringArray(existing?.userIds))
      userIds.add(identity.providerUserId)
      const nextGroup: SlackGroup = {
        ...(existing ?? {}),
        channelId: identity.providerChannelId,
        workspaceId: identity.providerWorkspaceId,
        userIds: [...userIds],
        confirmedByUserId: identity.userId,
        confirmedAt,
      }
      if (existingIndex >= 0) {
        nextGroups[existingIndex] = nextGroup
      } else {
        nextGroups.push(nextGroup)
      }
      return {
        spec: {
          ...spec,
          slackSettings: {
            ...settings,
            workspaceId: optionalString(settings.workspaceId) ?? identity.providerWorkspaceId,
          },
          slack: nextGroups,
        },
      }
    },
    target.channelNamespace
  )
}

export async function removeSlackAssociations(params: {
  gateway: K8sGateway
  userId: string
  providerUserId: string
  providerWorkspaceId: string | null
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
        const groups = normalizeSlackGroups(spec.slack)
        let changed = false
        const next = groups
          .map(group => {
            if (optionalString(group.channelId) !== params.providerChannelId) return group
            if (
              params.providerWorkspaceId &&
              optionalString(group.workspaceId) !== params.providerWorkspaceId
            ) {
              return group
            }
            const userIds = (group.userIds ?? []).filter(id => id !== params.providerUserId)
            if (userIds.length !== (group.userIds ?? []).length) changed = true
            if (userIds.length > 0) return { ...group, userIds }
            if ((group.userNames ?? []).length > 0) return { ...group, userIds: undefined }
            return null
          })
          .filter((group): group is SlackGroup => !!group)
        return changed ? { spec: { ...spec, slack: next } } : null
      },
      namespace
    )
  }
}

export async function attachSlackTargetsToAccounts(
  gateway: K8sGateway,
  userId: string,
  accounts: VerifiedMediumAccount[]
): Promise<Array<VerifiedMediumAccount & { targets?: SlackApprovalTarget[] }>> {
  const targets = await listSlackApprovalTargets({ gateway, userId })
  const channels = (await gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  const targetByName = new Map(
    targets.items.map(target => [`${target.channelNamespace}/${target.channelName}`, target])
  )
  return accounts.map(account => {
    if (
      account.medium !== 'slack' ||
      !account.providerChannelId ||
      !account.providerWorkspaceId ||
      account.disabledAt
    ) {
      return account.medium === 'slack' ? { ...account, targets: [] } : account
    }
    const matched: SlackApprovalTarget[] = []
    for (const channel of channels) {
      const key = `${optionalString(channel.metadata?.namespace)}/${optionalString(channel.metadata?.name)}`
      const target = targetByName.get(key)
      if (!target) continue
      if (account.communicationChannelRef && account.communicationChannelRef !== key) continue
      const groups = normalizeSlackGroups(channel.spec?.slack)
      const group = groups.find(
        group =>
          optionalString(group.channelId) === account.providerChannelId &&
          optionalString(group.workspaceId) === account.providerWorkspaceId &&
          (group.userIds ?? []).includes(account.providerUserId)
      )
      if (group) matched.push(target)
    }
    return {
      ...account,
      targets: matched,
    }
  })
}

import type { K8sGateway } from '../k8s.js'
import { decodeTeamsTargetId, encodeTeamsTargetId } from '../utils/teamsTargetId.js'
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
    teams?: unknown
    teamsSettings?: unknown
  }
}

type TeamsGroup = {
  channelId?: string
  tenantId?: string
  serviceUrl?: string
  conversationType?: string
  teamId?: string
  teamsChannelId?: string
  userIds?: string[]
  title?: string
  confirmedByUserId?: string
  confirmedAt?: string
  replyInThreads?: boolean
}

type CommunicationChannelAccess = {
  users: string[]
  teams: string[]
}

export type TeamsApprovalTarget = {
  id: string
  medium: 'teams'
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

type UserTeamsTargetAccess = {
  agentNames: Set<string>
  teamIds: Set<string>
}

export type TeamsIdentity = {
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerTeamId?: string | null
  providerTeamsChannelId?: string | null
  serviceUrl?: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function normalizeTeamsGroups(value: unknown): TeamsGroup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(group => (group && typeof group === 'object' ? (group as TeamsGroup) : null))
    .filter((group): group is TeamsGroup => !!group)
}

function normalizeChannelAccess(value: unknown): CommunicationChannelAccess {
  const access = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    users: normalizeStringArray(access.users),
    teams: normalizeStringArray(access.teams),
  }
}

function teamsSettings(channel: CommunicationChannelResource): Record<string, unknown> {
  return channel.spec?.teamsSettings &&
    typeof channel.spec.teamsSettings === 'object' &&
    !Array.isArray(channel.spec.teamsSettings)
    ? (channel.spec.teamsSettings as Record<string, unknown>)
    : {}
}

function hasTeamsProviderEnabled(channel: CommunicationChannelResource): boolean {
  if (normalizeTeamsGroups(channel.spec?.teams).length > 0) return true
  const settings = teamsSettings(channel)
  return ['appName', 'appId', 'tenantId', 'replyOnlyWhenMentioned'].some(
    key => settings[key] !== undefined
  )
}

async function loadTeamsTargetAccess(userId: string): Promise<UserTeamsTargetAccess> {
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
  access: UserTeamsTargetAccess
): boolean {
  const hostRef = optionalString(channel.spec?.hostRef)
  if (!hostRef || !access.agentNames.has(hostRef)) return false
  const channelAccess = normalizeChannelAccess(channel.spec?.access)
  if (channelAccess.users.includes(userId)) return true
  return channelAccess.teams.some(teamId => access.teamIds.has(teamId))
}

function appNameForChannel(channel: CommunicationChannelResource): string | null {
  const raw = optionalString(
    teamsSettings(channel).appName ?? channel.metadata?.annotations?.['clerum.io/teams-app-name']
  )
  return raw || null
}

function projectTarget(channel: CommunicationChannelResource): TeamsApprovalTarget | null {
  const name = optionalString(channel.metadata?.name)
  const namespace = optionalString(channel.metadata?.namespace)
  const hostRef = optionalString(channel.spec?.hostRef)
  const credentialName = optionalString(channel.spec?.credentialsSecretRef?.name)
  const settings = teamsSettings(channel)
  const appName = appNameForChannel(channel)
  const appId = optionalString(settings.appId)
  const tenantId = optionalString(settings.tenantId)
  if (
    !name ||
    !namespace ||
    !hostRef ||
    !credentialName ||
    !hasTeamsProviderEnabled(channel) ||
    !appName ||
    !appId ||
    !tenantId
  ) {
    return null
  }
  if (!UUID_RE.test(appId) || !UUID_RE.test(tenantId)) return null
  return {
    id: encodeTeamsTargetId(namespace, name),
    medium: 'teams',
    agentName: hostRef,
    channelName: name,
    channelNamespace: namespace,
    botLabel: appName,
    botUsername: null,
    botDeepLink: null,
    providerWorkspaceId: tenantId,
    replyOnlyWhenMentioned: settings.replyOnlyWhenMentioned === true,
    status: 'ready',
  }
}

export async function listTeamsApprovalTargets(params: {
  gateway: K8sGateway
  userId: string
}): Promise<{ items: TeamsApprovalTarget[] }> {
  const access = await loadTeamsTargetAccess(params.userId)
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

export async function resolveTeamsProviderEventTarget(params: {
  gateway: K8sGateway
  userId: string
  targetId: string
}): Promise<TeamsApprovalTarget> {
  const decoded = decodeTeamsTargetId(params.targetId)
  const channel = (await params.gateway.getResource(
    'communicationchannels',
    decoded.name,
    decoded.namespace
  )) as CommunicationChannelResource
  const target = projectTarget(channel)
  if (!target) throw new Error('teams_target_not_ready')
  const access = await loadTeamsTargetAccess(params.userId)
  if (!userCanAccessChannel(channel, params.userId, access)) {
    throw new Error('teams_target_not_found')
  }
  if (target.id !== params.targetId) throw new Error('teams_target_not_found')
  return target
}

export async function resolveTeamsCommunicationChannelTarget(params: {
  gateway: K8sGateway
  userId: string
  channelName: string
  channelNamespace: string
}): Promise<TeamsApprovalTarget> {
  const channel = (await params.gateway.getResource(
    'communicationchannels',
    params.channelName,
    params.channelNamespace
  )) as CommunicationChannelResource
  const target = projectTarget(channel)
  if (!target) throw new Error('teams_target_not_ready')
  const access = await loadTeamsTargetAccess(params.userId)
  if (!userCanAccessChannel(channel, params.userId, access)) {
    throw new Error('teams_target_not_found')
  }
  return target
}

export async function addTeamsTargetAssociation(
  gateway: K8sGateway,
  target: TeamsApprovalTarget,
  identity: TeamsIdentity & { userId: string; replyInThreads?: boolean }
): Promise<void> {
  if (target.providerWorkspaceId && identity.providerWorkspaceId !== target.providerWorkspaceId) {
    throw new Error('teams_tenant_mismatch')
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
        spec.teamsSettings &&
        typeof spec.teamsSettings === 'object' &&
        !Array.isArray(spec.teamsSettings)
          ? (spec.teamsSettings as Record<string, unknown>)
          : {}
      const groups = normalizeTeamsGroups(spec.teams)
      const nextGroups = [...groups]
      const existingIndex = nextGroups.findIndex(
        group =>
          group.channelId === identity.providerChannelId &&
          group.tenantId === identity.providerWorkspaceId
      )
      const existing = existingIndex >= 0 ? nextGroups[existingIndex]! : null
      const userIds = new Set(normalizeStringArray(existing?.userIds))
      userIds.add(identity.providerUserId)
      const replyInThreads =
        identity.replyInThreads !== undefined
          ? identity.replyInThreads
          : typeof existing?.replyInThreads === 'boolean'
            ? existing.replyInThreads
            : true
      const nextGroup: TeamsGroup = {
        ...(existing ?? {}),
        channelId: identity.providerChannelId,
        tenantId: identity.providerWorkspaceId,
        ...(identity.serviceUrl ? { serviceUrl: identity.serviceUrl } : {}),
        ...(identity.providerChannelType ? { conversationType: identity.providerChannelType } : {}),
        ...(identity.providerTeamId ? { teamId: identity.providerTeamId } : {}),
        ...(identity.providerTeamsChannelId
          ? { teamsChannelId: identity.providerTeamsChannelId }
          : {}),
        ...(identity.providerChannelTitle ? { title: identity.providerChannelTitle } : {}),
        userIds: [...userIds],
        confirmedByUserId: identity.userId,
        confirmedAt,
        replyInThreads,
      }
      if (existingIndex >= 0) {
        nextGroups[existingIndex] = nextGroup
      } else {
        nextGroups.push(nextGroup)
      }
      return {
        spec: {
          ...spec,
          teamsSettings: {
            ...settings,
            tenantId: optionalString(settings.tenantId) ?? identity.providerWorkspaceId,
          },
          teams: nextGroups,
        },
      }
    },
    target.channelNamespace
  )
}

export async function removeTeamsAssociations(params: {
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
        const groups = normalizeTeamsGroups(spec.teams)
        let changed = false
        const next = groups
          .map(group => {
            if (optionalString(group.channelId) !== params.providerChannelId) return group
            if (
              params.providerWorkspaceId &&
              optionalString(group.tenantId) !== params.providerWorkspaceId
            ) {
              return group
            }
            const userIds = (group.userIds ?? []).filter(id => id !== params.providerUserId)
            if (userIds.length !== (group.userIds ?? []).length) changed = true
            return userIds.length > 0 ? { ...group, userIds } : null
          })
          .filter((group): group is TeamsGroup => !!group)
        return changed ? { spec: { ...spec, teams: next } } : null
      },
      namespace
    )
  }
}

export async function attachTeamsTargetsToAccounts(
  gateway: K8sGateway,
  userId: string,
  accounts: VerifiedMediumAccount[]
): Promise<Array<VerifiedMediumAccount & { targets?: TeamsApprovalTarget[] }>> {
  const targets = await listTeamsApprovalTargets({ gateway, userId })
  const channels = (await gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  const targetByName = new Map(
    targets.items.map(target => [`${target.channelNamespace}/${target.channelName}`, target])
  )
  return accounts.map(account => {
    if (
      account.medium !== 'teams' ||
      !account.providerChannelId ||
      !account.providerWorkspaceId ||
      account.disabledAt
    ) {
      return account.medium === 'teams' ? { ...account, targets: [] } : account
    }
    const matched: TeamsApprovalTarget[] = []
    for (const channel of channels) {
      const key = `${optionalString(channel.metadata?.namespace)}/${optionalString(channel.metadata?.name)}`
      const target = targetByName.get(key)
      if (!target) continue
      if (account.communicationChannelRef && account.communicationChannelRef !== key) continue
      const groups = normalizeTeamsGroups(channel.spec?.teams)
      const group = groups.find(
        group =>
          optionalString(group.channelId) === account.providerChannelId &&
          optionalString(group.tenantId) === account.providerWorkspaceId &&
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

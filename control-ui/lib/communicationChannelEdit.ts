import type { CommunicationChannelProvider } from './communicationChannelProviders'
import type { CommunicationChannelGroup, CommunicationChannelItem } from './communicationChannels'

export type CommunicationChannelDraftState = {
  accessTeamIds: string[]
  accessUserIds: string[]
  credentialsSecretRef?: { name: string }
  hostRef: string
  slack: CommunicationChannelGroup[]
  slackBotHandle: string
  slackReplyOnlyWhenMentioned: boolean
  slackReplyInThreads: boolean
  slackWorkspaceId: string
  teams: CommunicationChannelGroup[]
  teamsAppName: string
  teamsAppId: string
  teamsTenantId: string
  teamsReplyOnlyWhenMentioned: boolean
  telegram: CommunicationChannelGroup[]
  telegramBotHandle: string
  telegramReplyOnlyWhenMentioned: boolean
}

function annotationValue(item: CommunicationChannelItem, keys: readonly string[]): string {
  const annotations = item.metadata?.annotations || {}
  for (const key of keys) {
    const value = annotations[key]?.trim()
    if (value) return value
  }
  return ''
}

export function hasTelegramConfig(
  draft: Pick<
    CommunicationChannelDraftState,
    'telegram' | 'telegramBotHandle' | 'telegramReplyOnlyWhenMentioned'
  >
): boolean {
  return draft.telegram.length > 0 || Boolean(draft.telegramBotHandle.trim())
}

export function hasSlackConfig(
  draft: Pick<
    CommunicationChannelDraftState,
    | 'slack'
    | 'slackBotHandle'
    | 'slackReplyInThreads'
    | 'slackReplyOnlyWhenMentioned'
    | 'slackWorkspaceId'
  >
): boolean {
  return (
    draft.slack.length > 0 ||
    Boolean(draft.slackBotHandle.trim()) ||
    Boolean(draft.slackWorkspaceId.trim())
  )
}

export function hasTeamsConfig(
  draft: Pick<
    CommunicationChannelDraftState,
    'teams' | 'teamsAppName' | 'teamsAppId' | 'teamsTenantId' | 'teamsReplyOnlyWhenMentioned'
  >
): boolean {
  return (
    draft.teams.length > 0 ||
    Boolean(draft.teamsAppName.trim()) ||
    Boolean(draft.teamsAppId.trim()) ||
    Boolean(draft.teamsTenantId.trim())
  )
}

export function createCommunicationChannelDraft(
  item: CommunicationChannelItem
): CommunicationChannelDraftState {
  const spec = item.spec || {}
  return {
    accessTeamIds: spec.access?.teams || [],
    accessUserIds: spec.access?.users || [],
    ...(spec.credentialsSecretRef?.name
      ? { credentialsSecretRef: { name: spec.credentialsSecretRef.name } }
      : {}),
    hostRef: spec.hostRef || '',
    slack: spec.slack || [],
    slackBotHandle:
      spec.slackSettings?.botHandle || annotationValue(item, ['clerum.io/slack-bot-label']),
    slackReplyOnlyWhenMentioned: spec.slackSettings?.replyOnlyWhenMentioned === true,
    slackReplyInThreads: spec.slackSettings?.replyInThreads === true,
    slackWorkspaceId: spec.slackSettings?.workspaceId || '',
    teams: spec.teams || [],
    teamsAppName:
      spec.teamsSettings?.appName || annotationValue(item, ['clerum.io/teams-app-name']),
    teamsAppId: spec.teamsSettings?.appId || '',
    teamsTenantId: spec.teamsSettings?.tenantId || '',
    teamsReplyOnlyWhenMentioned: spec.teamsSettings?.replyOnlyWhenMentioned === true,
    telegram: spec.telegram || [],
    telegramBotHandle:
      spec.telegramSettings?.botHandle ||
      annotationValue(item, ['clerum.io/telegram-bot-username', 'clerum.io/bot-username']),
    telegramReplyOnlyWhenMentioned: spec.telegramSettings?.replyOnlyWhenMentioned === true,
  }
}

export function communicationChannelInitialTab(
  item: CommunicationChannelItem
): CommunicationChannelProvider {
  const draft = createCommunicationChannelDraft(item)
  if (hasTelegramConfig(draft)) return 'telegram'
  if (hasSlackConfig(draft)) return 'slack'
  if (hasTeamsConfig(draft)) return 'teams'
  return 'telegram'
}

export function buildCommunicationChannelSpec(draft: CommunicationChannelDraftState) {
  const telegramEnabled = hasTelegramConfig(draft)
  const slackEnabled = hasSlackConfig(draft)
  const teamsEnabled = hasTeamsConfig(draft)
  return {
    hostRef: draft.hostRef.trim(),
    ...(draft.credentialsSecretRef?.name
      ? { credentialsSecretRef: { name: draft.credentialsSecretRef.name } }
      : {}),
    access: {
      users: draft.accessUserIds,
      teams: draft.accessTeamIds,
    },
    ...(telegramEnabled
      ? {
          telegram: draft.telegram,
          telegramSettings: {
            ...(draft.telegramBotHandle.trim()
              ? { botHandle: draft.telegramBotHandle.trim() }
              : {}),
            replyOnlyWhenMentioned: draft.telegramReplyOnlyWhenMentioned,
          },
        }
      : {}),
    ...(slackEnabled
      ? {
          slack: draft.slack,
          slackSettings: {
            ...(draft.slackBotHandle.trim() ? { botHandle: draft.slackBotHandle.trim() } : {}),
            replyOnlyWhenMentioned: draft.slackReplyOnlyWhenMentioned,
            replyInThreads: draft.slackReplyInThreads,
            ...(draft.slackWorkspaceId.trim()
              ? { workspaceId: draft.slackWorkspaceId.trim() }
              : {}),
          },
        }
      : {}),
    ...(teamsEnabled
      ? {
          teams: draft.teams,
          teamsSettings: {
            ...(draft.teamsAppName.trim() ? { appName: draft.teamsAppName.trim() } : {}),
            ...(draft.teamsAppId.trim() ? { appId: draft.teamsAppId.trim() } : {}),
            ...(draft.teamsTenantId.trim() ? { tenantId: draft.teamsTenantId.trim() } : {}),
            replyOnlyWhenMentioned: draft.teamsReplyOnlyWhenMentioned,
          },
        }
      : {}),
  }
}

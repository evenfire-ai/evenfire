import type { CommunicationChannelProvider } from './communicationChannelProviders'
import type { CommunicationChannelGroup, CommunicationChannelItem } from './communicationChannels'

export type CommunicationChannelDraftState = {
  accessTeamIds: string[]
  accessUserIds: string[]
  credentialsSecretRef?: { name: string }
  hostRef: string
  slack: CommunicationChannelGroup[]
  slackBotHandle: string
  /**
   * True when `slackBotHandle` was seeded from the `clerum.io/slack-bot-label`
   * annotation rather than from `spec.slackSettings` or from typing. Absent
   * means "not from the annotation": a hand-built draft has no annotation
   * history, and anything the operator types clears the flag.
   */
  slackBotHandleFromAnnotation?: boolean
  slackReplyOnlyWhenMentioned: boolean
  slackReplyInThreads: boolean
  slackWorkspaceId: string
  teams: CommunicationChannelGroup[]
  teamsAppName: string
  /**
   * True when `teamsAppName` was seeded from the `clerum.io/teams-app-name`
   * annotation rather than from `spec.teamsSettings` or from typing. Absent
   * means "not from the annotation": a hand-built draft has no annotation
   * history, and anything the operator types clears the flag.
   */
  teamsAppNameFromAnnotation?: boolean
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

/**
 * Gate for the Slack Request URL and app manifest, and for nothing else.
 *
 * `hasSlackConfig` counts a `slackBotHandle` seeded from the
 * `clerum.io/slack-bot-label` annotation, which is how a Telegram-only channel
 * carrying a stale label rendered a copyable Request URL and a full manifest for
 * a Slack app that does not exist. An annotation is a leftover label, not a
 * declaration that this channel has a Slack provider.
 *
 * Everything else keeps reading `hasSlackConfig`: the annotation still fills the
 * visible App Name field, still decides which tab the edit page opens on, and
 * still reaches the saved spec. Only the copyable URL and the manifest wait for
 * a real Slack provider, whether persisted or typed into the open draft.
 */
export function hasSlackConfigForRequestUrl(
  draft: Pick<
    CommunicationChannelDraftState,
    | 'slack'
    | 'slackBotHandle'
    | 'slackBotHandleFromAnnotation'
    | 'slackReplyInThreads'
    | 'slackReplyOnlyWhenMentioned'
    | 'slackWorkspaceId'
  >
): boolean {
  return hasSlackConfig({
    ...draft,
    slackBotHandle: draft.slackBotHandleFromAnnotation ? '' : draft.slackBotHandle,
  })
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

/**
 * Gate for the Teams Request URL, and for nothing else.
 *
 * `hasTeamsConfig` counts a `teamsAppName` seeded from the
 * `clerum.io/teams-app-name` annotation, which is how a Telegram-only channel
 * carrying a stale label rendered a copyable Request URL for a Teams bot that
 * does not exist. An annotation is a leftover label, not a declaration that this
 * channel has a Teams provider.
 *
 * Everything else keeps reading `hasTeamsConfig`: the annotation still fills the
 * visible App Name field, still decides which tab the edit page opens on, and
 * still reaches the saved spec. Only the copyable URL waits for a real Teams
 * provider, whether persisted or typed into the open draft.
 */
export function hasTeamsConfigForRequestUrl(
  draft: Pick<
    CommunicationChannelDraftState,
    | 'teams'
    | 'teamsAppName'
    | 'teamsAppNameFromAnnotation'
    | 'teamsAppId'
    | 'teamsTenantId'
    | 'teamsReplyOnlyWhenMentioned'
  >
): boolean {
  return hasTeamsConfig({
    ...draft,
    teamsAppName: draft.teamsAppNameFromAnnotation ? '' : draft.teamsAppName,
  })
}

export function createCommunicationChannelDraft(
  item: CommunicationChannelItem
): CommunicationChannelDraftState {
  const spec = item.spec || {}
  const slackBotHandleFromSpec = spec.slackSettings?.botHandle || ''
  const slackBotHandleFromLabel = annotationValue(item, ['clerum.io/slack-bot-label'])
  const teamsAppNameFromSpec = spec.teamsSettings?.appName || ''
  const teamsAppNameFromAnnotation = annotationValue(item, ['clerum.io/teams-app-name'])
  return {
    accessTeamIds: spec.access?.teams || [],
    accessUserIds: spec.access?.users || [],
    ...(spec.credentialsSecretRef?.name
      ? { credentialsSecretRef: { name: spec.credentialsSecretRef.name } }
      : {}),
    hostRef: spec.hostRef || '',
    slack: spec.slack || [],
    slackBotHandle: slackBotHandleFromSpec || slackBotHandleFromLabel,
    slackBotHandleFromAnnotation: !slackBotHandleFromSpec && Boolean(slackBotHandleFromLabel),
    slackReplyOnlyWhenMentioned: spec.slackSettings?.replyOnlyWhenMentioned === true,
    slackReplyInThreads: spec.slackSettings?.replyInThreads === true,
    slackWorkspaceId: spec.slackSettings?.workspaceId || '',
    teams: spec.teams || [],
    teamsAppName: teamsAppNameFromSpec || teamsAppNameFromAnnotation,
    teamsAppNameFromAnnotation: !teamsAppNameFromSpec && Boolean(teamsAppNameFromAnnotation),
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

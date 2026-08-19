export type CommunicationChannelChatType = 'private' | 'group' | 'supergroup' | 'channel' | ''

export type CommunicationChannelGroup = {
  channelId?: string
  confirmedAt?: string
  confirmedByUserId?: string
  handle?: string
  serviceUrl?: string
  tenantId?: string
  conversationType?: string
  teamId?: string
  teamsChannelId?: string
  userIds?: string[]
  emails?: string[]
  userNames?: string[]
  workspaceId?: string
  replyOnlyWhenMentioned?: boolean
  chatType?: CommunicationChannelChatType
  title?: string
}

export type CommunicationChannelItem = {
  metadata?: { annotations?: Record<string, string>; name?: string; namespace?: string }
  spec?: {
    access?: {
      users?: string[]
      teams?: string[]
    }
    hostRef?: string
    credentialsSecretRef?: { name: string }
    telegram?: CommunicationChannelGroup[]
    telegramSettings?: {
      botHandle?: string
      replyOnlyWhenMentioned?: boolean
    }
    email?: CommunicationChannelGroup[]
    slack?: CommunicationChannelGroup[]
    slackSettings?: {
      workspaceId?: string
      botHandle?: string
      replyOnlyWhenMentioned?: boolean
      replyInThreads?: boolean
    }
    teams?: CommunicationChannelGroup[]
    teamsSettings?: {
      appName?: string
      appId?: string
      tenantId?: string
      replyOnlyWhenMentioned?: boolean
    }
  }
}

export function formatCommunicationChannelConfirmedAt(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/**
 * Absolute webhook URL for a reader path, or the bare path when this deployment
 * has no public webhook address (the minikube case).
 */
function webhookUrlForPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL?.replace(/\/+$/, '')
  if (base) return `${base}${path}`
  if (typeof window !== 'undefined' && window.location.hostname.startsWith('app.')) {
    const rootDomain = window.location.hostname.slice('app.'.length)
    return `${window.location.protocol}//webhook.${rootDomain}${path}`
  }
  return path
}

/**
 * The Slack target id depends only on the channel's namespace and name, both
 * fixed when the channel is created, which is why callers may build this from an
 * unsaved edit draft: the reader resolves the id whether or not `slackSettings`
 * has been persisted yet. Deciding WHETHER a channel should show a Slack URL is
 * the caller's job, and it is a real decision — a URL on a channel with no Slack
 * provider is a copyable dead end.
 */
export function slackWebhookTargetIdForChannelName(
  name: string,
  namespace = 'channels'
): string | null {
  const trimmedName = name.trim()
  if (!trimmedName) return null
  return `slack:${base64UrlEncode(JSON.stringify({ namespace: namespace.trim() || 'channels', name: trimmedName }))}`
}

export function slackWebhookPathForChannelName(
  name: string,
  namespace = 'channels'
): string | null {
  const targetId = slackWebhookTargetIdForChannelName(name, namespace)
  return targetId ? `/webhooks/slack/${encodeURIComponent(targetId)}` : null
}

export function slackWebhookUrlForChannelName(name: string, namespace = 'channels'): string | null {
  const path = slackWebhookPathForChannelName(name, namespace)
  return path ? webhookUrlForPath(path) : null
}

export function slackWebhookTargetIdForChannel(item: CommunicationChannelItem): string | null {
  const spec = item.spec
  const slackConfigured =
    (spec?.slack?.length ?? 0) > 0 ||
    !!spec?.slackSettings?.workspaceId?.trim() ||
    !!spec?.slackSettings?.botHandle?.trim()
  if (!slackConfigured) return null
  return slackWebhookTargetIdForChannelName(
    item.metadata?.name ?? '',
    item.metadata?.namespace ?? 'channels'
  )
}

export function slackWebhookPathForChannel(item: CommunicationChannelItem): string | null {
  const targetId = slackWebhookTargetIdForChannel(item)
  return targetId ? `/webhooks/slack/${encodeURIComponent(targetId)}` : null
}

export function slackWebhookUrlForChannel(item: CommunicationChannelItem): string | null {
  const path = slackWebhookPathForChannel(item)
  return path ? webhookUrlForPath(path) : null
}

export function teamsWebhookTargetIdForChannel(item: CommunicationChannelItem): string | null {
  const namespace = item.metadata?.namespace?.trim() || 'channels'
  const name = item.metadata?.name?.trim()
  if (!name) return null
  return `teams:${base64UrlEncode(JSON.stringify({ namespace, name }))}`
}

export function teamsWebhookPathForChannel(item: CommunicationChannelItem): string | null {
  const targetId = teamsWebhookTargetIdForChannel(item)
  return targetId ? `/webhooks/teams/${encodeURIComponent(targetId)}` : null
}

export function teamsWebhookPathForChannelName(
  name: string,
  namespace = 'channels'
): string | null {
  return teamsWebhookPathForChannel({
    metadata: {
      name,
      namespace,
    },
  })
}

export function teamsWebhookUrlForChannel(item: CommunicationChannelItem): string | null {
  const path = teamsWebhookPathForChannel(item)
  return path ? webhookUrlForPath(path) : null
}

export function teamsWebhookUrlForChannelName(name: string, namespace = 'channels'): string | null {
  return teamsWebhookUrlForChannel({
    metadata: {
      name,
      namespace,
    },
  })
}

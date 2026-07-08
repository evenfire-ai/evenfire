export type CommunicationChannelChatType = 'private' | 'group' | 'supergroup' | 'channel' | ''

export type CommunicationChannelGroup = {
  channelId?: string
  confirmedAt?: string
  confirmedByUserId?: string
  handle?: string
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

export function slackWebhookTargetIdForChannel(item: CommunicationChannelItem): string | null {
  const namespace = item.metadata?.namespace?.trim() || 'channels'
  const name = item.metadata?.name?.trim()
  if (!name) return null
  return `slack:${base64UrlEncode(JSON.stringify({ namespace, name }))}`
}

export function slackWebhookPathForChannel(item: CommunicationChannelItem): string | null {
  const targetId = slackWebhookTargetIdForChannel(item)
  return targetId ? `/webhooks/slack/${encodeURIComponent(targetId)}` : null
}

export function slackWebhookUrlForChannel(item: CommunicationChannelItem): string | null {
  const path = slackWebhookPathForChannel(item)
  if (!path) return null
  const base = process.env.NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL?.replace(/\/+$/, '')
  if (base) return `${base}${path}`
  if (typeof window !== 'undefined' && window.location.hostname.startsWith('app.')) {
    const rootDomain = window.location.hostname.slice('app.'.length)
    return `${window.location.protocol}//webhook.${rootDomain}${path}`
  }
  return path
}

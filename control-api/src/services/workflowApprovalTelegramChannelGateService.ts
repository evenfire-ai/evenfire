import type { K8sGateway } from '../k8s.js'
import {
  type ProviderTargetBindingInput,
  normalizeTelegramProviderChannelType,
} from './workflowApprovalMediumOperationalIdentityService.js'

type CommunicationChannelResource = {
  metadata?: {
    annotations?: Record<string, string>
    name?: string
    namespace?: string
  }
  spec?: {
    hostRef?: unknown
    telegram?: unknown
    telegramSettings?: unknown
  }
}

type TelegramGroup = {
  channelId?: unknown
  chatType?: unknown
  userIds?: unknown
  confirmedByUserId?: unknown
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeGroups(value: unknown): TelegramGroup[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is TelegramGroup => !!entry && typeof entry === 'object')
    : []
}

function normalizeBotUsername(value: unknown): string | null {
  const username = optionalString(value)?.replace(/^@/, '').toLowerCase()
  return username || null
}

function parseCommunicationChannelRef(
  value: string | null
): { namespace: string; name: string } | null {
  if (!value) return null
  const [namespace, name, ...rest] = value.split('/')
  if (rest.length > 0) return null
  const normalizedNamespace = optionalString(namespace)
  const normalizedName = optionalString(name)
  if (!normalizedNamespace || !normalizedName) return null
  return { namespace: normalizedNamespace, name: normalizedName }
}

function groupMatchesAccount(group: TelegramGroup, accountUserId?: string | null): boolean {
  const userId = optionalString(accountUserId)
  if (!userId) return false
  if (userId && optionalString(group.confirmedByUserId) === userId) return true
  return false
}

export async function verifyTelegramOperationalChannelBinding(params: {
  gateway: K8sGateway
  providerChannelId: string
  providerChannelType?: string | null
  providerTarget?: ProviderTargetBindingInput | null
  communicationChannelRef?: string | null
  accountUserId?: string | null
  providerUserId?: string | null
  requireAccountMatch?: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const providerChannelType = normalizeTelegramProviderChannelType(params.providerChannelType)
  if (
    providerChannelType !== 'private' &&
    providerChannelType !== 'group' &&
    providerChannelType !== 'supergroup'
  ) {
    return { ok: false, error: 'unsupported_chat_type' }
  }
  const target = params.providerTarget
  const ref = parseCommunicationChannelRef(optionalString(params.communicationChannelRef))
  const hostRef = optionalString(target?.hostRef)
  const namespace = optionalString(target?.communicationChannelNamespace) ?? ref?.namespace ?? null
  const name = optionalString(target?.communicationChannelName) ?? ref?.name ?? null
  if (!namespace || !name) {
    return { ok: false, error: 'provider_target_required' }
  }

  let channel: CommunicationChannelResource
  try {
    channel = (await params.gateway.getResource(
      'communicationchannels',
      name,
      namespace
    )) as CommunicationChannelResource
  } catch {
    return { ok: false, error: 'communication_channel_not_found' }
  }

  if (hostRef && optionalString(channel.spec?.hostRef) !== hostRef) {
    return { ok: false, error: 'communication_channel_binding_mismatch' }
  }
  const telegramSettings =
    channel.spec?.telegramSettings &&
    typeof channel.spec.telegramSettings === 'object' &&
    !Array.isArray(channel.spec.telegramSettings)
      ? (channel.spec.telegramSettings as { botHandle?: unknown })
      : {}
  const configuredBotUsername = normalizeBotUsername(
    telegramSettings.botHandle ??
      channel.metadata?.annotations?.['clerum.io/telegram-bot-username'] ??
      channel.metadata?.annotations?.['clerum.io/bot-username']
  )
  const eventBotUsername = normalizeBotUsername(target?.providerBotUsername)
  if (configuredBotUsername && eventBotUsername && configuredBotUsername !== eventBotUsername) {
    return { ok: false, error: 'communication_channel_binding_mismatch' }
  }

  const requireAccountMatch =
    params.requireAccountMatch ?? Boolean(params.accountUserId || params.providerUserId)
  const matched = normalizeGroups(channel.spec?.telegram).some(group => {
    if (optionalString(group.channelId) !== params.providerChannelId) return false
    const chatType = normalizeTelegramProviderChannelType(group.chatType)
    return (
      chatType === providerChannelType &&
      (!requireAccountMatch || groupMatchesAccount(group, params.accountUserId))
    )
  })
  return matched ? { ok: true } : { ok: false, error: 'communication_channel_not_allowed' }
}

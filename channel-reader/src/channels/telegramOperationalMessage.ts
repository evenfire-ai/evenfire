import type {
  Message,
  ProviderAttachmentDescriptorV1,
  ProviderTargetIdentity,
  TelegramProviderChatType,
} from '../types'
import { isAllowedSender, isInlineApprovalCommand } from './base'
import { withTelegramBotIdentity } from './telegramProviderTarget'
import { type TelegramEntity, messageAddressesBotInGroup } from './telegramVerification'

export function buildTelegramOperationalMessage(params: {
  text: string
  chatId: string
  chatType: string
  senderId: string | null
  senderUsername: string
  senderIsBot: boolean
  hasSenderChat: boolean
  messageId: number | string
  date: number
  threadId?: number | string
  attachments?: ProviderAttachmentDescriptorV1[]
  rawMessage: Record<string, unknown>
  allowedSenders: Set<string> | null | undefined
  expectedChatType?: TelegramProviderChatType
  requireMention: boolean
  botId: number | null
  botUsernameLower: string
  providerTarget?: ProviderTargetIdentity
  providerEventId?: string
}): Message | null {
  if (!params.senderId) {
    console.log(`[Telegram] Ignoring message without from.id in chat ${params.chatId}`)
    return null
  }
  if (params.senderIsBot) {
    console.log(
      `[Telegram] Ignoring message from bot sender ${params.senderId} in chat ${params.chatId}`
    )
    return null
  }
  if (params.hasSenderChat) {
    console.log(`[Telegram] Ignoring message sent on behalf of a chat in chat ${params.chatId}`)
    return null
  }
  if (
    params.chatType !== 'private' &&
    params.chatType !== 'group' &&
    params.chatType !== 'supergroup'
  ) {
    console.log(
      `[Telegram] Ignoring message in unsupported chat type ${params.chatType} for chat ${params.chatId}: unsupported_chat_type`
    )
    return null
  }
  if (!params.expectedChatType) {
    console.log(
      `[Telegram] Ignoring message from chat ${params.chatId}: explicit chatType is required`
    )
    return null
  }
  if (params.expectedChatType !== params.chatType) {
    console.log(
      `[Telegram] Ignoring message from chat ${params.chatId}: configured chatType ${params.expectedChatType} does not match provider chatType ${params.chatType}`
    )
    return null
  }
  if (!params.providerTarget) {
    console.log(
      `[Telegram] Ignoring message from chat ${params.chatId}: provider target is required`
    )
    return null
  }
  if (
    params.allowedSenders === undefined ||
    (params.allowedSenders && !isAllowedSender(params.senderId, params.allowedSenders))
  ) {
    const allowedList =
      params.allowedSenders === undefined
        ? 'none (chat not registered)'
        : params.allowedSenders === null
          ? 'all senders delegated to backend authorization'
          : [...params.allowedSenders].join(', ')
    console.log(
      `[Telegram] Ignoring message from unauthorized user ${params.senderId} (@${params.senderUsername}) in chat ${params.chatId}. Allowed: [${allowedList}]`
    )
    return null
  }
  if (params.requireMention && !isInlineApprovalCommand(params.text)) {
    if (params.chatType !== 'private' && params.botId == null) {
      console.warn(
        `[Telegram] replyOnlyWhenMentioned: bot id not available yet; dropping group message chat=${params.chatId}`
      )
      return null
    }
    const replyToFromId = (params.rawMessage as { reply_to_message?: { from?: { id: number } } })
      .reply_to_message?.from?.id
    const rawEntities = params.rawMessage.entities as TelegramEntity[] | undefined
    const rawCaptionEntities = params.rawMessage.caption_entities as TelegramEntity[] | undefined
    const entities =
      rawEntities && rawCaptionEntities
        ? [...rawEntities, ...rawCaptionEntities]
        : (rawEntities ?? rawCaptionEntities)
    if (
      !messageAddressesBotInGroup(
        params.text,
        params.chatType,
        entities,
        replyToFromId,
        params.botId,
        params.botUsernameLower
      )
    ) {
      console.log(
        `[Telegram] Ignoring message (replyOnlyWhenMentioned: need @mention, text_mention, or reply to bot) chat=${params.chatId}`
      )
      return null
    }
  }

  return {
    channelType: 'telegram',
    channelId: params.chatId,
    sender: params.senderId,
    content: params.text,
    timestamp: new Date(params.date * 1000),
    messageId: String(params.messageId),
    threadId: params.threadId === undefined ? undefined : String(params.threadId),
    ...(params.attachments && params.attachments.length > 0
      ? { attachments: params.attachments }
      : {}),
    providerIdentity: {
      medium: 'telegram',
      providerUserId: params.senderId,
      providerWorkspaceId: null,
      providerChannelId: params.chatId,
      providerChannelType: params.chatType,
      providerEventId: params.providerEventId ?? `telegram:${params.chatId}:${params.messageId}`,
      providerTarget: withTelegramBotIdentity(
        params.providerTarget,
        params.botId,
        params.botUsernameLower
      ),
    },
    rawData: params.rawMessage,
  }
}

/**
 * Telegram channel adapter using grammY.
 */
import { Bot, Context } from 'grammy'
import { config } from '../config'
import { RPCClient } from '../rpcClient'
import {
  type TelegramCallbackAction,
  type TelegramToolApprovalDecision,
  parseTelegramCallbackData,
} from '../telegramCallbackData'
import {
  AdapterCredentials,
  Attachment,
  ChannelAdapter,
  ChannelAttachmentDownloadResult,
  DownloadAttachmentOptions,
  FetchMessagesOptions,
  Message,
  ProviderAttachmentDescriptorV1,
  ProviderTargetIdentity,
  SendMessageOptions,
  TelegramProviderChatType,
} from '../types'
import { readBoundedResponseBytes } from './downloadStream'
import { sendTelegramMessage } from './telegramDelivery'
import { buildTelegramOperationalMessage } from './telegramOperationalMessage'
import { withTelegramBotIdentity } from './telegramProviderTarget'
import {
  type TelegramEntity,
  type TelegramVerificationClient,
  handleTelegramVerificationCommand,
  isTelegramVerifyCommand,
  parseTelegramVerifyCommand,
  redactTelegramVerificationText,
  sleep,
  telegramStartFailureMessage,
} from './telegramVerification'

const TELEGRAM_MAX_LENGTH = 4096
const TELEGRAM_CALLBACK_DEBOUNCE_MS = 2_000
const TELEGRAM_DEFAULT_API_ROOT = 'https://api.telegram.org'
const TELEGRAM_GET_FILE_MAX_BYTES = 20 * 1024 * 1024 // 20 MiB Telegram Bot API limit
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000
export const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 800
export const TELEGRAM_MEDIA_GROUP_MAX_ITEMS = 10

type TelegramPhotoSizeLike = {
  file_id?: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}

type TelegramMediaObjectLike = {
  file_id?: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
  is_animated?: boolean
  is_video?: boolean
}

type TelegramIncomingMessageLike = Record<string, unknown> & {
  message_id?: number | string
  date?: number
  message_thread_id?: number | string
  text?: string
  caption?: string
  media_group_id?: string
  entities?: TelegramEntity[]
  caption_entities?: TelegramEntity[]
  reply_to_message?: { from?: { id?: number } }
  sender_chat?: unknown
  photo?: TelegramPhotoSizeLike[]
  document?: TelegramMediaObjectLike
  audio?: TelegramMediaObjectLike
  video?: TelegramMediaObjectLike
  voice?: TelegramMediaObjectLike
  animation?: TelegramMediaObjectLike
  video_note?: TelegramMediaObjectLike
  sticker?: TelegramMediaObjectLike
}

interface PendingMediaGroupItem {
  text: string
  attachments: ProviderAttachmentDescriptorV1[]
  messageId: number | string
  date: number
  threadId?: number | string
  rawMessage: TelegramIncomingMessageLike
}

interface PendingMediaGroupEntry {
  key: string
  chatId: string
  chatType: string
  senderId: string
  senderUsername: string
  senderIsBot: boolean
  hasSenderChat: boolean
  mediaGroupId: string
  items: PendingMediaGroupItem[]
  timer: ReturnType<typeof setTimeout>
}

export function extractTelegramAttachments(
  message: TelegramIncomingMessageLike | undefined
): ProviderAttachmentDescriptorV1[] {
  if (!message || typeof message !== 'object') return []
  const descriptors: ProviderAttachmentDescriptorV1[] = []
  const seenFileIds = new Set<string>()

  const pushDescriptor = (descriptor: ProviderAttachmentDescriptorV1): void => {
    const fileId =
      descriptor.downloadRef.provider === 'telegram' ? descriptor.downloadRef.fileId : ''
    if (!fileId || seenFileIds.has(fileId)) return
    seenFileIds.add(fileId)
    descriptors.push(descriptor)
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    let best: TelegramPhotoSizeLike | null = null
    let bestScore = -1
    for (const candidate of message.photo) {
      if (!candidate?.file_id) continue
      const pixels =
        typeof candidate.width === 'number' && typeof candidate.height === 'number'
          ? candidate.width * candidate.height
          : 0
      const size = typeof candidate.file_size === 'number' ? candidate.file_size : 0
      const score = pixels > 0 ? pixels * 1_000_000 + size : size
      if (!best || score >= bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (best?.file_id) {
      pushDescriptor({
        providerAttachmentId: best.file_unique_id || best.file_id,
        filename: null,
        declaredMediaType: 'image/jpeg',
        reportedSizeBytes: typeof best.file_size === 'number' ? best.file_size : null,
        downloadRef: {
          provider: 'telegram',
          fileId: best.file_id,
          kindHint: 'photo',
        },
      })
    }
  }

  if (message.animation?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.animation.file_unique_id || message.animation.file_id,
      filename: message.animation.file_name ?? null,
      declaredMediaType: message.animation.mime_type ?? null,
      reportedSizeBytes:
        typeof message.animation.file_size === 'number' ? message.animation.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.animation.file_id,
        kindHint: 'animation',
      },
    })
  }

  if (message.document?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.document.file_unique_id || message.document.file_id,
      filename: message.document.file_name ?? null,
      declaredMediaType: message.document.mime_type ?? null,
      reportedSizeBytes:
        typeof message.document.file_size === 'number' ? message.document.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.document.file_id,
        kindHint: 'document',
      },
    })
  }

  if (message.audio?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.audio.file_unique_id || message.audio.file_id,
      filename: message.audio.file_name ?? null,
      declaredMediaType: message.audio.mime_type ?? null,
      reportedSizeBytes:
        typeof message.audio.file_size === 'number' ? message.audio.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.audio.file_id,
        kindHint: 'audio',
      },
    })
  }

  if (message.video?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.video.file_unique_id || message.video.file_id,
      filename: message.video.file_name ?? null,
      declaredMediaType: message.video.mime_type ?? null,
      reportedSizeBytes:
        typeof message.video.file_size === 'number' ? message.video.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.video.file_id,
        kindHint: 'video',
      },
    })
  }

  if (message.voice?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.voice.file_unique_id || message.voice.file_id,
      filename: null,
      declaredMediaType: message.voice.mime_type ?? null,
      reportedSizeBytes:
        typeof message.voice.file_size === 'number' ? message.voice.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.voice.file_id,
        kindHint: 'voice',
      },
    })
  }

  if (message.video_note?.file_id) {
    pushDescriptor({
      providerAttachmentId: message.video_note.file_unique_id || message.video_note.file_id,
      filename: null,
      declaredMediaType: 'video/mp4',
      reportedSizeBytes:
        typeof message.video_note.file_size === 'number' ? message.video_note.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.video_note.file_id,
        kindHint: 'video_note',
      },
    })
  }

  if (message.sticker?.file_id) {
    const declaredMediaType = message.sticker.is_video
      ? 'video/webm'
      : message.sticker.is_animated
        ? 'application/x-tgsticker'
        : 'image/webp'
    pushDescriptor({
      providerAttachmentId: message.sticker.file_unique_id || message.sticker.file_id,
      filename: null,
      declaredMediaType,
      reportedSizeBytes:
        typeof message.sticker.file_size === 'number' ? message.sticker.file_size : null,
      downloadRef: {
        provider: 'telegram',
        fileId: message.sticker.file_id,
        kindHint: 'sticker',
      },
    })
  }

  return descriptors
}

function isSafeTelegramFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false
  if (filePath.includes('\\') || filePath.includes('..')) return false
  if (filePath.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(filePath)) return false
  if (/[\x00-\x1f\x7f?#]/.test(filePath)) return false
  const segments = filePath.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
  }
  return true
}

function reencodeToolApprovalDecision(
  decision: TelegramToolApprovalDecision
): 'a' | 'l' | 'c' | 's' | 'd' | null {
  switch (decision) {
    case 'approve':
      return 'a'
    case 'approveAlways':
      return 'l'
    case 'command':
      return 'c'
    case 'shell':
      return 's'
    case 'deny':
      return 'd'
    default:
      return null
  }
}

type TelegramCallbackQueryMessage = {
  message_id?: number | string
  date?: number
  message_thread_id?: number | string
  chat?: { id?: number | string; type?: string }
}

type TelegramCallbackContext = Context & {
  callbackQuery?: {
    id?: string
    data?: string
    message?: TelegramCallbackQueryMessage
  }
  answerCallbackQuery?: (options?: { text?: string; show_alert?: boolean }) => Promise<unknown>
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const

  private bot: Bot | null = null
  private botToken: string | null = null
  private apiRoot: string = TELEGRAM_DEFAULT_API_ROOT
  private pendingMessages: Message[] = []
  private pendingMediaGroups: Map<string, PendingMediaGroupEntry> = new Map()
  private allowedSendersByChat: Map<string, Set<string> | null> = new Map()
  private replyOnlyWhenMentionedByChat: Map<string, boolean> = new Map()
  private telegramChatTypeByChat: Map<string, TelegramProviderChatType> = new Map()
  private providerTargetByChat: Map<string, ProviderTargetIdentity> = new Map()
  private defaultProviderTarget: ProviderTargetIdentity | null = null
  private defaultProviderTargets: ProviderTargetIdentity[] = []
  private botId: number | null = null
  private botUsernameLower = ''
  private connected: boolean = false
  private readonly recentCallbackActions: Map<string, number> = new Map()
  /** Log once when replyOnlyWhenMentioned is used but the bot has no @username (mention entities differ). */
  private warnedReplyOnlyNoUsername = false
  private readonly verificationClient: TelegramVerificationClient | null

  constructor(verificationClient?: TelegramVerificationClient | null) {
    this.verificationClient =
      verificationClient === undefined ? this.defaultVerificationClient() : verificationClient
  }

  private defaultVerificationClient(): TelegramVerificationClient {
    return new RPCClient(config.mcpHostUrl)
  }

  async connect(credentials?: AdapterCredentials): Promise<void> {
    const token = credentials?.telegramBotToken?.trim()
    if (!token) {
      console.warn('[Telegram] Bot token not configured, skipping')
      return
    }
    if (this.bot) {
      await this.disconnect()
    }
    this.defaultProviderTarget = credentials?.providerTarget ?? null
    this.defaultProviderTargets =
      credentials?.providerTargets && credentials.providerTargets.length > 0
        ? credentials.providerTargets
        : this.defaultProviderTarget
          ? [this.defaultProviderTarget]
          : []

    try {
      const bot = new Bot(
        token,
        config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : undefined
      )
      this.bot = bot
      this.botToken = token
      this.apiRoot = config.telegramApiRoot?.trim() || TELEGRAM_DEFAULT_API_ROOT

      // Set up message handler (all message types: text + photos/documents/media)
      bot.on('message', (ctx: Context) => {
        this.handleMessage(ctx)
      })
      bot.on('callback_query:data', (ctx: Context) => {
        void this.handleCallbackQuery(ctx)
      })

      // Set up error handler
      bot.catch(err => {
        console.error('[Telegram] Bot error:', err.message)
      })

      // Await until long-polling setup succeeds (getMe + deleteWebhook + onStart). The
      // start() promise itself never resolves while polling runs. Telegram can still
      // reject immediately after onStart with getUpdates 409 if a previous long-poll
      // has not fully released, so keep a short startup stability window before
      // reporting the adapter as connected to channel-reader.
      let started = false
      let resolveOnStart!: () => void
      const onStart = new Promise<void>(resolve => {
        resolveOnStart = resolve
      })
      const startFailure = bot
        .start({
          onStart: botInfo => {
            started = true
            this.connected = true
            this.botId = typeof botInfo.id === 'number' ? botInfo.id : null
            this.botUsernameLower = (botInfo.username || '').replace(/^@/, '').toLowerCase()
            console.log(`[Telegram] Connected as @${botInfo.username}`)
            resolveOnStart()
          },
        })
        .then(() => null)
        .catch(err => {
          const error = err instanceof Error ? err : new Error(String(err))
          console.error('[Telegram] Failed to start bot:', telegramStartFailureMessage(error))
          if (this.bot === bot) {
            this.resetConnectionState()
          }
          return error
        })

      const failureBeforeStart = await Promise.race([onStart.then(() => null), startFailure])
      if (failureBeforeStart) {
        throw failureBeforeStart
      }
      if (!started) {
        throw new Error('Telegram bot did not report startup')
      }
      const earlyFailure = await this.waitForStartupStability(startFailure)
      if (earlyFailure) {
        throw earlyFailure
      }
    } catch (err) {
      console.error('[Telegram] Failed to initialize bot:', err)
      this.resetConnectionState()
      throw err
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      try {
        await this.bot.stop()
      } catch (err) {
        // Ignore stop errors
      }
      if (config.telegramShutdownGraceMs > 0) {
        await sleep(config.telegramShutdownGraceMs)
      }
      this.resetConnectionState()
    }
  }

  private resetConnectionState(): void {
    this.bot = null
    this.botToken = null
    this.apiRoot = TELEGRAM_DEFAULT_API_ROOT
    this.connected = false
    this.botId = null
    this.botUsernameLower = ''
    this.warnedReplyOnlyNoUsername = false
    this.defaultProviderTarget = null
    this.defaultProviderTargets = []
    this.recentCallbackActions.clear()
    for (const entry of this.pendingMediaGroups.values()) {
      clearTimeout(entry.timer)
    }
    this.pendingMediaGroups.clear()
  }

  private async waitForStartupStability(
    startFailure: Promise<Error | null>
  ): Promise<Error | null> {
    if (config.telegramStartupStabilityMs > 0) {
      return Promise.race([startFailure, sleep(config.telegramStartupStabilityMs).then(() => null)])
    }
    return Promise.race([startFailure, Promise.resolve(null)])
  }

  private primeVerifiedTelegramChat(params: {
    chatId: string
    chatType: string
    senderId: string | null
    providerTarget: ProviderTargetIdentity | null
  }): void {
    if (!params.chatId || !params.senderId || !params.providerTarget) return
    if (
      params.chatType !== 'private' &&
      params.chatType !== 'group' &&
      params.chatType !== 'supergroup'
    ) {
      return
    }

    const telegramChatType = params.chatType as TelegramProviderChatType
    // This conservative placeholder covers the post-/verify gap for the verifying
    // sender. The next CRD-backed fetchMessages call overwrites group chats with
    // the full channel state, including allowUnlistedSender when configured.
    this.allowedSendersByChat.set(params.chatId, new Set([params.senderId]))
    this.telegramChatTypeByChat.set(params.chatId, telegramChatType)
    this.providerTargetByChat.set(params.chatId, params.providerTarget)
  }

  async fetchMessages(
    channelId: string,
    allowedSenders: Set<string>,
    options?: FetchMessagesOptions
  ): Promise<Message[]> {
    // Update filter criteria for this specific chat
    this.allowedSendersByChat.set(channelId, options?.allowUnlistedSender ? null : allowedSenders)
    this.replyOnlyWhenMentionedByChat.set(channelId, !!options?.replyOnlyWhenMentioned)
    if (options?.telegramChatType) {
      this.telegramChatTypeByChat.set(channelId, options.telegramChatType)
    } else {
      this.telegramChatTypeByChat.delete(channelId)
    }
    if (options?.providerTarget) {
      this.providerTargetByChat.set(channelId, options.providerTarget)
    } else {
      this.providerTargetByChat.delete(channelId)
    }

    if (
      options?.replyOnlyWhenMentioned &&
      this.botId != null &&
      this.botUsernameLower.length === 0 &&
      !this.warnedReplyOnlyNoUsername
    ) {
      this.warnedReplyOnlyNoUsername = true
      console.warn(
        '[Telegram] replyOnlyWhenMentioned is enabled but this bot has no @username. ' +
          'In groups, standard @mention matching will not apply; users can still use reply-to-bot or text_mention.'
      )
    }

    // Return and clear pending messages for this channel only
    const matched: Message[] = []
    const remaining: Message[] = []
    for (const msg of this.pendingMessages) {
      if (msg.channelId === channelId) {
        matched.push(msg)
      } else {
        remaining.push(msg)
      }
    }
    this.pendingMessages = remaining
    return matched
  }

  private async answerCallbackQuery(
    ctx: TelegramCallbackContext,
    text: string,
    showAlert = false
  ): Promise<void> {
    try {
      await ctx.answerCallbackQuery?.({ text, show_alert: showAlert })
    } catch (err) {
      console.warn('[Telegram] Failed to answer callback query:', err)
    }
  }

  private telegramCallbackDebounceKey(action: TelegramCallbackAction, message: Message): string {
    const target = message.providerIdentity?.providerTarget
    const targetKey = target
      ? [
          target.hostRef,
          target.communicationChannelNamespace,
          target.communicationChannelName,
        ].join('/')
      : 'unknown-target'
    const actionKey =
      action.kind === 'toolApprovalDecision'
        ? `tool:${action.actionToken}`
        : action.kind === 'workflowApprovalDecision'
          ? `approval:${action.approvalRequestId}`
          : `result:${action.workflowRunId ?? action.workflowName ?? 'missing'}`
    return [message.sender, message.channelId, targetKey, actionKey].join('|')
  }

  private consumeTelegramCallbackAttempt(key: string, nowMs = Date.now()): boolean {
    for (const [storedKey, seenAtMs] of this.recentCallbackActions) {
      if (nowMs - seenAtMs > TELEGRAM_CALLBACK_DEBOUNCE_MS) {
        this.recentCallbackActions.delete(storedKey)
      }
    }

    const previousMs = this.recentCallbackActions.get(key)
    if (previousMs !== undefined && nowMs - previousMs <= TELEGRAM_CALLBACK_DEBOUNCE_MS) {
      return false
    }

    this.recentCallbackActions.set(key, nowMs)
    return true
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const callbackCtx = ctx as TelegramCallbackContext
    const callbackQuery = callbackCtx.callbackQuery
    const action = parseTelegramCallbackData(callbackQuery?.data)
    if (!action) {
      await this.answerCallbackQuery(callbackCtx, 'Unsupported button.', true)
      return
    }

    const callbackMessage = callbackQuery?.message
    const chatIdRaw = callbackMessage?.chat?.id
    const chatId = chatIdRaw === undefined || chatIdRaw === null ? '' : String(chatIdRaw)
    const chatType = callbackMessage?.chat?.type || 'unknown'
    const rawSenderId = (ctx.from as { id?: number | string } | undefined)?.id
    const senderId = rawSenderId === undefined || rawSenderId === null ? null : String(rawSenderId)
    const senderUsername = ctx.from?.username || 'no-username'
    const senderIsBot = (ctx.from as { is_bot?: boolean } | undefined)?.is_bot === true
    const callbackId = callbackQuery?.id || `unknown-${Date.now()}`
    const messageId = callbackMessage?.message_id ?? callbackId
    const date = callbackMessage?.date ?? Math.floor(Date.now() / 1000)
    const providerTarget = this.providerTargetByChat.get(chatId)

    const rawMessage: Record<string, unknown> = {
      callback_query_id: callbackId,
      callback_data: callbackQuery?.data,
      message_id: messageId,
      chat: callbackMessage?.chat,
      from: ctx.from,
    }

    let content: string
    if (action.kind === 'toolApprovalDecision') {
      const decision = reencodeToolApprovalDecision(action.decision)
      if (!decision) {
        await this.answerCallbackQuery(callbackCtx, 'Unsupported button.', true)
        return
      }
      content = `tool:${decision}:${action.actionToken}`
      rawMessage.telegramToolApprovalActionToken = action.actionToken
      rawMessage.telegramToolApprovalDecision = action.decision
    } else if (action.kind === 'workflowApprovalDecision') {
      content = `/${action.decision} ${action.approvalRequestId}`
      rawMessage.telegramCallbackApprovalRequestId = action.approvalRequestId
      rawMessage.telegramCallbackDecision = action.decision
    } else {
      content = 'Download the completed workflow result'
    }

    const message = buildTelegramOperationalMessage({
      text: content,
      chatId,
      chatType,
      senderId,
      senderUsername,
      senderIsBot,
      hasSenderChat: false,
      messageId,
      date,
      threadId: callbackMessage?.message_thread_id,
      rawMessage,
      allowedSenders: this.allowedSendersByChat.get(chatId),
      expectedChatType: this.telegramChatTypeByChat.get(chatId),
      requireMention: false,
      botId: this.botId,
      botUsernameLower: this.botUsernameLower,
      providerTarget,
      providerEventId: `telegram:${chatId}:callback:${callbackId}`,
    })
    if (!message) {
      await this.answerCallbackQuery(
        callbackCtx,
        'You are not authorized to use this button.',
        true
      )
      return
    }

    const debounceKey = this.telegramCallbackDebounceKey(action, message)
    if (!this.consumeTelegramCallbackAttempt(debounceKey)) {
      await this.answerCallbackQuery(
        callbackCtx,
        action.kind === 'workflowResult'
          ? 'Already fetching result.'
          : 'Already recording decision.'
      )
      return
    }

    if (action.kind === 'workflowResult') {
      await this.answerCallbackQuery(callbackCtx, 'Fetching result...')
      await this.deliverWorkflowResultCallback(message, action.workflowRunId, action.workflowName)
      return
    }

    this.pendingMessages.push(message)
    await this.answerCallbackQuery(callbackCtx, 'Recording decision...')
  }

  private async deliverWorkflowResultCallback(
    message: Message,
    workflowRunId: string | undefined,
    workflowName: string | undefined
  ): Promise<void> {
    if (!workflowRunId && !workflowName) {
      await this.sendMessage(
        message.channelId,
        'This result button is missing its workflow run. Trigger the workflow again.',
        message.messageId
      )
      return
    }
    const result = workflowRunId
      ? await this.verificationClient?.downloadWorkflowResultByRun?.(message, workflowRunId)
      : await this.verificationClient?.downloadWorkflowResult?.(message, workflowName!)
    if (!result) {
      await this.sendMessage(
        message.channelId,
        'Workflow result download is not available from this channel.',
        message.messageId
      )
      return
    }
    if (!result.success) {
      await this.sendMessage(
        message.channelId,
        result.error?.message || 'Workflow result could not be downloaded.',
        message.messageId
      )
      return
    }
    const attachments = result.attachments ?? []
    if (attachments.length > 0) {
      const deliveredMessageId = await this.sendMessage(
        message.channelId,
        '',
        message.messageId,
        attachments
      )
      if (!deliveredMessageId) {
        await this.sendMessage(
          message.channelId,
          'Workflow result was found, but Telegram could not deliver the attached file.',
          message.messageId
        )
      }
      return
    }
    await this.sendMessage(
      message.channelId,
      result.response || 'Workflow result is ready.',
      message.messageId,
      result.attachments
    )
  }

  private flushMediaGroup(key: string): void {
    const entry = this.pendingMediaGroups.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pendingMediaGroups.delete(key)

    const first = entry.items[0]
    if (!first) return

    let combinedText = ''
    let combinedEntities: TelegramEntity[] | undefined
    let combinedCaptionEntities: TelegramEntity[] | undefined
    let replyToMessage: { from?: { id?: number } } | undefined
    const combinedAttachments: ProviderAttachmentDescriptorV1[] = []
    const coalescedMessageIds: Array<number | string> = []

    for (const item of entry.items) {
      coalescedMessageIds.push(item.messageId)
      if (!combinedText && item.text) {
        combinedText = item.text
        combinedEntities = item.rawMessage.entities
        combinedCaptionEntities = item.rawMessage.caption_entities
      }
      if (!replyToMessage && item.rawMessage.reply_to_message) {
        replyToMessage = item.rawMessage.reply_to_message
      }
      for (const att of item.attachments) {
        if (combinedAttachments.length < TELEGRAM_MEDIA_GROUP_MAX_ITEMS) {
          combinedAttachments.push(att)
        }
      }
    }

    const rawMessage: Record<string, unknown> = {
      ...first.rawMessage,
      media_group_id: entry.mediaGroupId,
      coalescedMessageIds,
      ...(combinedEntities ? { entities: combinedEntities } : {}),
      ...(combinedCaptionEntities ? { caption_entities: combinedCaptionEntities } : {}),
      ...(replyToMessage ? { reply_to_message: replyToMessage } : {}),
    }

    const message = buildTelegramOperationalMessage({
      text: combinedText,
      chatId: entry.chatId,
      chatType: entry.chatType,
      senderId: entry.senderId,
      senderUsername: entry.senderUsername,
      senderIsBot: entry.senderIsBot,
      hasSenderChat: entry.hasSenderChat,
      messageId: first.messageId,
      date: first.date,
      threadId: first.threadId,
      attachments: combinedAttachments,
      rawMessage,
      allowedSenders: this.allowedSendersByChat.get(entry.chatId),
      expectedChatType: this.telegramChatTypeByChat.get(entry.chatId),
      requireMention: this.replyOnlyWhenMentionedByChat.get(entry.chatId) ?? false,
      botId: this.botId,
      botUsernameLower: this.botUsernameLower,
      providerTarget: this.providerTargetByChat.get(entry.chatId),
    })
    if (!message) return

    this.pendingMessages.push(message)
    console.log(
      `[Telegram] Flushed media group ${entry.mediaGroupId} (${combinedAttachments.length} attachment(s)) from user ${entry.senderId}`
    )
  }

  private flushOpenMediaGroupsForSender(
    chatId: string,
    senderId: string | null,
    excludeKey?: string
  ): void {
    if (!chatId || !senderId) return
    const keysToFlush: string[] = []
    for (const [key, entry] of this.pendingMediaGroups) {
      if (entry.chatId === chatId && entry.senderId === senderId && key !== excludeKey) {
        keysToFlush.push(key)
      }
    }
    for (const key of keysToFlush) {
      this.flushMediaGroup(key)
    }
  }

  private handleMessage(ctx: Context): void {
    const rawMsg = ctx.message as TelegramIncomingMessageLike | undefined
    if (!rawMsg) {
      return
    }

    const text =
      typeof rawMsg.text === 'string'
        ? rawMsg.text
        : typeof rawMsg.caption === 'string'
          ? rawMsg.caption
          : ''
    const attachments = extractTelegramAttachments(rawMsg)
    if (!text && attachments.length === 0) {
      return
    }

    const rawSenderId = (ctx.from as { id?: number | string } | undefined)?.id
    const senderId = rawSenderId === undefined || rawSenderId === null ? null : String(rawSenderId)
    const senderUsername = ctx.from?.username || 'no-username'
    const chatId = ctx.chat?.id.toString() || ''
    const chatType = ctx.chat?.type || 'unknown'
    const chatRecord = (ctx.chat ?? {}) as {
      title?: string
      username?: string
      first_name?: string
      last_name?: string
    }
    const chatTitle =
      chatRecord.title ||
      [chatRecord.first_name, chatRecord.last_name].filter(Boolean).join(' ') ||
      null
    const chatHandle = chatRecord.username || null
    const senderIsBot = (ctx.from as { is_bot?: boolean } | undefined)?.is_bot === true
    const hasSenderChat = Boolean(rawMsg.sender_chat)
    const logText = redactTelegramVerificationText(text)

    console.log(
      `[Telegram] Message received - chat: ${chatId} (${chatType}), sender: ${senderId ?? 'missing'} (@${senderUsername}), text: "${logText.substring(0, 50)}...", attachments: ${attachments.length}`
    )

    if (text && isTelegramVerifyCommand(text)) {
      this.flushOpenMediaGroupsForSender(chatId, senderId)
      const providerTarget = this.defaultProviderTarget
        ? withTelegramBotIdentity(this.defaultProviderTarget, this.botId, this.botUsernameLower)
        : null
      const providerTargets = this.defaultProviderTargets.map(target =>
        withTelegramBotIdentity(target, this.botId, this.botUsernameLower)
      )
      void handleTelegramVerificationCommand({
        chatId,
        chatType,
        chatTitle,
        chatHandle,
        code: parseTelegramVerifyCommand(text),
        senderId,
        senderIsBot,
        hasSenderChat,
        providerTarget,
        providerTargets,
        verificationClient: this.verificationClient,
        sendReply: async content => {
          if (this.bot) await this.bot.api.sendMessage(chatId, content)
        },
      })
        .then(confirmed => {
          if (confirmed) {
            this.primeVerifiedTelegramChat({ chatId, chatType, senderId, providerTarget })
          }
        })
        .catch(err => {
          console.error(
            '[Telegram] Verification command handler failed:',
            err instanceof Error ? err.message : err
          )
        })
      return
    }

    const mediaGroupId =
      typeof rawMsg.media_group_id === 'string' && rawMsg.media_group_id.trim()
        ? rawMsg.media_group_id.trim()
        : null

    if (mediaGroupId && senderId && attachments.length > 0) {
      const groupKey = `${chatId}\0${senderId}\0${mediaGroupId}`
      // Synchronously flush any distinct open album(s) for this (chatId, senderId) first
      this.flushOpenMediaGroupsForSender(chatId, senderId, groupKey)

      const item: PendingMediaGroupItem = {
        text,
        attachments,
        messageId: rawMsg.message_id ?? Date.now(),
        date: rawMsg.date ?? Math.floor(Date.now() / 1000),
        threadId: rawMsg.message_thread_id,
        rawMessage: rawMsg,
      }

      const existing = this.pendingMediaGroups.get(groupKey)
      if (existing) {
        clearTimeout(existing.timer)
        existing.items.push(item)
        if (existing.items.length >= TELEGRAM_MEDIA_GROUP_MAX_ITEMS) {
          this.flushMediaGroup(groupKey)
        } else {
          existing.timer = setTimeout(
            () => this.flushMediaGroup(groupKey),
            TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS
          )
        }
        return
      }

      const timer = setTimeout(
        () => this.flushMediaGroup(groupKey),
        TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS
      )
      this.pendingMediaGroups.set(groupKey, {
        key: groupKey,
        chatId,
        chatType,
        senderId,
        senderUsername,
        senderIsBot,
        hasSenderChat,
        mediaGroupId,
        items: [item],
        timer,
      })
      return
    }

    // Synchronously flush any open media group buffers for (chatId, senderId) BEFORE
    // pushing a non-album message so rapid follow-up text never overtakes a buffered album (R66).
    this.flushOpenMediaGroupsForSender(chatId, senderId)

    const message = buildTelegramOperationalMessage({
      text,
      chatId,
      chatType,
      senderId,
      senderUsername,
      senderIsBot,
      hasSenderChat,
      messageId: rawMsg.message_id ?? Date.now(),
      date: rawMsg.date ?? Math.floor(Date.now() / 1000),
      threadId: rawMsg.message_thread_id,
      attachments,
      rawMessage: rawMsg,
      allowedSenders: this.allowedSendersByChat.get(chatId),
      expectedChatType: this.telegramChatTypeByChat.get(chatId),
      requireMention: this.replyOnlyWhenMentionedByChat.get(chatId) ?? false,
      botId: this.botId,
      botUsernameLower: this.botUsernameLower,
      providerTarget: this.providerTargetByChat.get(chatId),
    })
    if (!message) return

    this.pendingMessages.push(message)
    console.log(`[Telegram] Received message from user ${senderId}`)
  }

  /**
   * Download raw bytes for a Telegram attachment descriptor using an immutable
   * snapshot of credentials/client captured synchronously before the first await.
   */
  async downloadAttachment(
    descriptor: ProviderAttachmentDescriptorV1,
    options?: DownloadAttachmentOptions
  ): Promise<ChannelAttachmentDownloadResult> {
    if (descriptor.downloadRef.provider !== 'telegram') {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Mismatched attachment descriptor provider for Telegram adapter.',
        retryable: false,
      }
    }

    // Snapshot credentials and API handle synchronously before any await so a
    // concurrent CRD restart() cannot nullify them mid-download (R20).
    const snapshotToken = this.botToken
    const snapshotApiRoot =
      this.apiRoot || config.telegramApiRoot?.trim() || TELEGRAM_DEFAULT_API_ROOT
    const snapshotBotApi = this.bot?.api ?? null

    if (!snapshotToken) {
      return {
        ok: false,
        code: 'provider_not_connected',
        message: 'Telegram adapter is not connected.',
        retryable: true,
      }
    }

    const configuredMax =
      options?.maxBytes ?? config.channelAttachmentMaxBytes ?? TELEGRAM_GET_FILE_MAX_BYTES
    const effectiveMaxBytes = Math.min(configuredMax, TELEGRAM_GET_FILE_MAX_BYTES)

    if (
      typeof descriptor.reportedSizeBytes === 'number' &&
      descriptor.reportedSizeBytes > effectiveMaxBytes
    ) {
      return {
        ok: false,
        code: 'file_too_large',
        message: `Telegram file exceeds the ${effectiveMaxBytes} byte limit.`,
        retryable: false,
      }
    }

    let apiOrigin: string
    try {
      apiOrigin = new URL(snapshotApiRoot).origin
    } catch {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Configured Telegram API root is invalid.',
        retryable: false,
      }
    }

    const fileId = descriptor.downloadRef.fileId
    let filePath: string | undefined
    let fileSize: number | undefined

    try {
      if (snapshotBotApi && typeof snapshotBotApi.getFile === 'function') {
        const fileInfo = (await snapshotBotApi.getFile(fileId)) as {
          file_path?: string
          file_size?: number
        }
        filePath = fileInfo?.file_path
        fileSize = fileInfo?.file_size
      } else {
        const getFileUrl = `${apiOrigin}/bot${snapshotToken}/getFile?file_id=${encodeURIComponent(fileId)}`
        const metaResponse = await fetch(getFileUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
        })
        if (!metaResponse.ok) {
          return {
            ok: false,
            code: 'provider_download_failed',
            message: `Telegram getFile failed (HTTP ${metaResponse.status}).`,
            retryable: metaResponse.status >= 500,
          }
        }
        const metaJson = (await metaResponse.json().catch(() => null)) as {
          ok?: boolean
          result?: { file_path?: string; file_size?: number }
        } | null
        if (!metaJson?.ok || !metaJson.result?.file_path) {
          return {
            ok: false,
            code: 'provider_download_failed',
            message: 'Telegram getFile did not return a downloadable file path.',
            retryable: false,
          }
        }
        filePath = metaJson.result.file_path
        fileSize = metaJson.result.file_size
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/too big/i.test(msg)) {
        return {
          ok: false,
          code: 'file_too_large',
          message: `Telegram rejected file download as too large (20 MiB Bot API cap).`,
          retryable: false,
        }
      }
      return {
        ok: false,
        code: 'provider_download_failed',
        message: 'Failed to resolve Telegram file metadata.',
        retryable: true,
      }
    }

    if (typeof fileSize === 'number' && fileSize > effectiveMaxBytes) {
      return {
        ok: false,
        code: 'file_too_large',
        message: `Telegram file exceeds the ${effectiveMaxBytes} byte limit.`,
        retryable: false,
      }
    }

    if (!filePath || !isSafeTelegramFilePath(filePath)) {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Telegram returned an unsafe file path.',
        retryable: false,
      }
    }

    let downloadUrl: URL
    try {
      downloadUrl = new URL(`/file/bot${snapshotToken}/${filePath}`, apiOrigin)
    } catch {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Could not construct safe Telegram file URL.',
        retryable: false,
      }
    }

    if (
      downloadUrl.origin !== apiOrigin ||
      !downloadUrl.pathname.startsWith(`/file/bot${snapshotToken}/`)
    ) {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Telegram file download URL escaped the configured API origin.',
        retryable: false,
      }
    }

    try {
      const response = await fetch(downloadUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location')
        if (!location) {
          return {
            ok: false,
            code: 'provider_download_rejected',
            message: 'Telegram file download redirected without a valid destination.',
            retryable: false,
          }
        }
        let targetUrl: URL
        try {
          targetUrl = new URL(location, downloadUrl)
        } catch {
          return {
            ok: false,
            code: 'provider_download_rejected',
            message: 'Telegram file download redirected to an invalid URL.',
            retryable: false,
          }
        }
        if (targetUrl.origin !== apiOrigin) {
          return {
            ok: false,
            code: 'provider_download_rejected',
            message: 'Telegram file download attempted an off-origin redirect.',
            retryable: false,
          }
        }
        return {
          ok: false,
          code: 'provider_download_rejected',
          message: 'Unexpected redirect from Telegram file endpoint.',
          retryable: false,
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          code: 'provider_download_failed',
          message: `Telegram file download failed (HTTP ${response.status}).`,
          retryable: response.status >= 500,
        }
      }

      const bounded = await readBoundedResponseBytes(response, effectiveMaxBytes)
      if (!bounded.ok) {
        return bounded
      }

      return {
        ok: true,
        bytes: bounded.bytes,
        filename: descriptor.filename,
        declaredMediaType: descriptor.declaredMediaType,
      }
    } catch {
      return {
        ok: false,
        code: 'provider_download_failed',
        message: 'Network error while downloading Telegram file.',
        retryable: true,
      }
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<string | undefined> {
    if (!this.bot) {
      console.warn('[Telegram] Bot not connected, cannot send message')
      return
    }

    try {
      return await sendTelegramMessage(
        this.bot,
        channelId,
        content,
        replyToMessageId,
        attachments,
        options
      )
    } catch (err) {
      console.error('[Telegram] Failed to send message:', err)
      throw err
    }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (!this.bot) return
    try {
      const text =
        content.length > TELEGRAM_MAX_LENGTH
          ? content.substring(0, TELEGRAM_MAX_LENGTH - 3) + '...'
          : content
      const inlineKeyboard = options?.telegramInlineKeyboard
        ?.map(row =>
          row
            .filter(button => button.text.trim() && button.callbackData.trim())
            .map(button => ({ text: button.text, callback_data: button.callbackData }))
        )
        .filter(row => row.length > 0)
      await this.bot.api.editMessageText(channelId, Number(messageId), text, {
        reply_markup: { inline_keyboard: inlineKeyboard ?? [] },
      })
    } catch (err) {
      // Ignore "message is not modified" errors (Telegram returns 400 if text unchanged)
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('message is not modified')) {
        console.error(`[Telegram] Failed to edit message ${messageId}:`, msg)
      }
    }
  }
}

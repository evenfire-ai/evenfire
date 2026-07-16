/**
 * Telegram channel adapter using grammY.
 */
import { Bot, Context } from 'grammy'
import { config } from '../config'
import { RPCClient } from '../rpcClient'
import { type TelegramCallbackAction, parseTelegramCallbackData } from '../telegramCallbackData'
import {
  AdapterCredentials,
  Attachment,
  ChannelAdapter,
  FetchMessagesOptions,
  Message,
  ProviderTargetIdentity,
  SendMessageOptions,
  TelegramProviderChatType,
} from '../types'
import { sendTelegramMessage } from './telegramDelivery'
import { buildTelegramOperationalMessage } from './telegramOperationalMessage'
import { withTelegramBotIdentity } from './telegramProviderTarget'
import {
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
  private pendingMessages: Message[] = []
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

      // Set up message handler
      bot.on('message:text', (ctx: Context) => {
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
    this.connected = false
    this.botId = null
    this.botUsernameLower = ''
    this.warnedReplyOnlyNoUsername = false
    this.defaultProviderTarget = null
    this.defaultProviderTargets = []
    this.recentCallbackActions.clear()
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
      const decision =
        action.decision === 'approve' ? 'a' : action.decision === 'approveAlways' ? 'l' : 'd'
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

  private handleMessage(ctx: Context): void {
    if (!ctx.message?.text) {
      return
    }

    const rawSenderId = (ctx.from as { id?: number | string } | undefined)?.id
    const senderId = rawSenderId === undefined || rawSenderId === null ? null : String(rawSenderId)
    const senderUsername = ctx.from?.username || 'no-username'
    const text = ctx.message.text
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
    const hasSenderChat = Boolean((ctx.message as { sender_chat?: unknown }).sender_chat)
    const logText = redactTelegramVerificationText(text)

    console.log(
      `[Telegram] Message received - chat: ${chatId} (${chatType}), sender: ${senderId ?? 'missing'} (@${senderUsername}), text: "${logText.substring(0, 50)}..."`
    )

    if (isTelegramVerifyCommand(text)) {
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

    const message = buildTelegramOperationalMessage({
      text,
      chatId,
      chatType,
      senderId,
      senderUsername,
      senderIsBot,
      hasSenderChat,
      messageId: ctx.message.message_id,
      date: ctx.message.date,
      threadId: ctx.message.message_thread_id,
      rawMessage: ctx.message as unknown as Record<string, unknown>,
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

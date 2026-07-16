export type TelegramEntity = {
  type: string
  offset: number
  length: number
  user?: { id: number }
}

export type TelegramVerificationClient = {
  confirmTelegramChallenge(params: {
    code: string
    providerUserId: string
    providerChannelId: string
    providerChannelType: string
    providerChannelTitle?: string | null
    providerChannelHandle?: string | null
    providerTarget: {
      hostRef: string
      communicationChannelNamespace: string
      communicationChannelName: string
      providerBotId?: string | null
      providerBotUsername?: string | null
    }
    providerTargets?: Array<{
      hostRef: string
      communicationChannelNamespace: string
      communicationChannelName: string
      providerBotId?: string | null
      providerBotUsername?: string | null
    }>
  }): Promise<{ ok: true; accountId: string; userEmail?: string } | { ok: false; error: string }>
  downloadWorkflowResultByRun?: (
    message: import('../types').Message,
    workflowRunId: string
  ) => Promise<import('../rpcClient').MessageResponse>
  downloadWorkflowResult?: (
    message: import('../types').Message,
    workflowName: string
  ) => Promise<import('../rpcClient').MessageResponse>
}

const VERIFY_COMMAND_RE = /^\/verify(?:@[A-Za-z0-9_]+)?(?:\s+(\d{6}))?\s*$/i
const VERIFY_PREFIX_RE = /^\/verify(?:@[A-Za-z0-9_]+)?(?:\s|$)/i

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isTelegramVerifyCommand(text: string): boolean {
  return VERIFY_PREFIX_RE.test(text.trim())
}

export function parseTelegramVerifyCommand(text: string): string | null {
  const match = text.trim().match(VERIFY_COMMAND_RE)
  return match?.[1] ?? null
}

export function redactTelegramVerificationText(text: string): string {
  return isTelegramVerifyCommand(text) ? '/verify [redacted]' : text
}

export async function handleTelegramVerificationCommand(params: {
  chatId: string
  chatType: string
  chatTitle?: string | null
  chatHandle?: string | null
  code: string | null
  senderId: string | null
  senderIsBot?: boolean
  hasSenderChat?: boolean
  providerTarget: {
    hostRef: string
    communicationChannelNamespace: string
    communicationChannelName: string
    providerBotId?: string | null
    providerBotUsername?: string | null
  } | null
  providerTargets?: Array<{
    hostRef: string
    communicationChannelNamespace: string
    communicationChannelName: string
    providerBotId?: string | null
    providerBotUsername?: string | null
  }>
  verificationClient: TelegramVerificationClient | null
  sendReply: (content: string) => Promise<void>
}): Promise<boolean> {
  if (!params.chatId) return false
  if (params.chatType === 'channel') {
    await params.sendReply(
      'Telegram channels cannot be connected. Use a private chat, group, or supergroup.'
    )
    return false
  }
  if (
    params.chatType !== 'private' &&
    params.chatType !== 'group' &&
    params.chatType !== 'supergroup'
  ) {
    await params.sendReply(
      'Open a private chat, group, or supergroup with this bot and send /verify followed by your code.'
    )
    return false
  }
  if (!params.code) {
    await params.sendReply('Send /verify followed by the 6 digit code.')
    return false
  }
  if (!params.senderId || params.senderIsBot || params.hasSenderChat) {
    await params.sendReply('Verification failed. Check that the code is active and try again.')
    return false
  }
  if (params.chatType === 'private' && params.chatId !== params.senderId) {
    await params.sendReply('Verification failed. Check that the code is active and try again.')
    return false
  }
  const providerTarget = params.providerTarget ?? params.providerTargets?.[0] ?? null
  if (!providerTarget) {
    await params.sendReply('Telegram verification is not available.')
    return false
  }
  if (!params.verificationClient) {
    await params.sendReply('Telegram verification is not available.')
    return false
  }
  try {
    const result = await params.verificationClient.confirmTelegramChallenge({
      code: params.code,
      providerUserId: params.senderId,
      providerChannelId: params.chatId,
      providerChannelType: params.chatType,
      providerChannelTitle: params.chatTitle,
      providerChannelHandle: params.chatHandle,
      providerTarget,
      ...(params.providerTargets && params.providerTargets.length > 0
        ? { providerTargets: params.providerTargets }
        : {}),
    })
    await params.sendReply(
      result.ok
        ? 'Telegram identity confirmed.'
        : 'Verification failed. Check that the code is active and try again.'
    )
    return result.ok
  } catch (err) {
    console.warn(
      '[Telegram] Verification challenge confirmation failed:',
      err instanceof Error ? err.message : err
    )
    await params.sendReply('Verification failed. Check that the code is active and try again.')
    return false
  }
}

export function telegramStartFailureMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (!/401|404|Not Found|Unauthorized|bad token|getMe|deleteWebhook/i.test(msg)) {
    return msg
  }
  return (
    `${msg} — Typically the bot token is invalid, revoked, or pasted with extra whitespace. ` +
    `Check the per-CC credentials Secret (named cc-<cc-name>-credentials, where <cc-name> ` +
    `is the CommunicationChannel resource name) in namespace channels, key telegram-bot-token. ` +
    `Regenerate the token with @BotFather if unsure.`
  )
}

export function messageAddressesBotInGroup(
  text: string,
  chatType: string,
  entities: TelegramEntity[] | undefined,
  replyToFromId: number | undefined,
  botId: number | null,
  botUsernameLower: string
): boolean {
  if (chatType === 'private') {
    return true
  }
  if (botId == null) {
    return false
  }
  if (replyToFromId === botId) {
    return true
  }
  for (const e of entities || []) {
    if (e.type === 'mention') {
      const slice = text.slice(e.offset, e.offset + e.length)
      const name = slice.startsWith('@') ? slice.slice(1).toLowerCase() : slice.toLowerCase()
      if (name === botUsernameLower && botUsernameLower.length > 0) {
        return true
      }
    }
    if (e.type === 'text_mention' && e.user?.id === botId) {
      return true
    }
  }
  return false
}

/**
 * Slack channel adapter using @slack/web-api.
 */
import { WebClient } from '@slack/web-api'
import { config } from '../config'
import { RPCClient } from '../rpcClient'
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
} from '../types'
import { isAllowedSender, isInlineApprovalCommand, isWorkflowApprovalDecisionCommand } from './base'
import { readBoundedResponseBytes } from './downloadStream'
import {
  type SlackVerificationClient,
  handleSlackVerificationCommand,
  isSlackVerifyCommand,
  parseSlackVerifyCommand,
  redactSlackVerificationText,
} from './slackVerification'

const SLACK_CONVERSATION_LIST_MAX_PAGES = 50
const SLACK_CHANNEL_NAME_CACHE_MAX = 1000
const SLACK_USER_CACHE_MAX = 5000
const SLACK_DOWNLOAD_TIMEOUT_MS = 30_000
const SLACK_MAX_REDIRECTS = 3

export function isAllowedSlackDownloadHost(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const hostname = url.hostname.toLowerCase()
  return hostname === 'slack.com' || hostname.endsWith('.slack.com')
}

function isSlackSignInPath(url: URL): boolean {
  const path = url.pathname.toLowerCase()
  return (
    path === '/signin' ||
    path.startsWith('/signin/') ||
    path === '/workspace-signin' ||
    path.startsWith('/workspace-signin/') ||
    path.startsWith('/ssb/redirect')
  )
}

function isSlackMissingScopeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as { message?: unknown; data?: { error?: unknown } }
  if (record.data?.error === 'missing_scope') return true
  if (typeof record.message === 'string' && /missing_scope/i.test(record.message)) return true
  return false
}

function looksLikeSlackLoginHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4096).toString('utf8').toLowerCase()
  return (
    head.includes('sign in to your workspace') ||
    head.includes('slack_signin') ||
    head.includes('slack.com/signin') ||
    (head.includes('/signin') && head.includes('slack'))
  )
}

export function extractSlackFileDescriptors(files: unknown): ProviderAttachmentDescriptorV1[] {
  if (!Array.isArray(files)) return []
  const descriptors: ProviderAttachmentDescriptorV1[] = []
  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue
    const file = raw as Record<string, unknown>
    const id = typeof file.id === 'string' ? file.id.trim() : ''
    if (!id) continue
    const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : null
    const title = typeof file.title === 'string' && file.title.trim() ? file.title.trim() : null
    const mimetype =
      typeof file.mimetype === 'string' && file.mimetype.trim() ? file.mimetype.trim() : null
    const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null
    const urlPrivateDownload =
      typeof file.url_private_download === 'string' && file.url_private_download.trim()
        ? file.url_private_download.trim()
        : null
    const urlPrivate =
      typeof file.url_private === 'string' && file.url_private.trim()
        ? file.url_private.trim()
        : null
    const fileAccess =
      typeof file.file_access === 'string' && file.file_access.trim()
        ? file.file_access.trim()
        : null
    const isExternal = file.is_external === true
    descriptors.push({
      providerAttachmentId: id,
      filename: name ?? title,
      declaredMediaType: mimetype,
      reportedSizeBytes: size,
      downloadRef: {
        provider: 'slack',
        fileId: id,
        urlPrivateDownload,
        urlPrivate,
        fileAccess,
        isExternal,
      },
    })
  }
  return descriptors
}
const WORKFLOW_DOCUMENT_MIME_BY_EXT = new Map([
  ['json', 'application/json'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])
const INTERNAL_GENERATED_ARTIFACT_DOCUMENTS = [
  ['clerum__generate_markdown', 'md', 'text/markdown'],
  ['clerum__generate_pdf', 'pdf', 'application/pdf'],
  [
    'clerum__generate_docx',
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  [
    'clerum__generate_xlsx',
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  [
    'clerum__generate_pptx',
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['clerum__generate_chart', 'png', 'image/png'],
] as const
const INTERNAL_GENERATED_ARTIFACT_MIME_BY_EXT = new Map<string, string>(
  INTERNAL_GENERATED_ARTIFACT_DOCUMENTS.map(([, format, mimeType]) => [format, mimeType])
)
const INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL = new Map<string, string>(
  INTERNAL_GENERATED_ARTIFACT_DOCUMENTS.map(([tool, format]) => [tool, format])
)
const INTERNAL_GENERATED_ARTIFACT_PRODUCER = 'mcp-host-internal-tool'

function approxDecodedBytes(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

function attachmentExtension(filename: string | undefined): string {
  if (!filename) return ''
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : ''
}

function safeDocumentFilename(filename: string | undefined, fallback: string): string {
  const raw = (filename || fallback).replace(/\\/g, '/').split('/').pop() || fallback
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function isAllowedWorkflowDocument(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.sourceTool !== 'workflow_result') return false
  const expected = WORKFLOW_DOCUMENT_MIME_BY_EXT.get(attachmentExtension(attachment.filename))
  if (!expected) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expected
}

function isAllowedInternalGeneratedDocument(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.lane !== 'internal_generated_artifact') return false
  if (attachment.producer !== INTERNAL_GENERATED_ARTIFACT_PRODUCER) return false
  const expectedFormat = attachment.sourceTool
    ? INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL.get(attachment.sourceTool)
    : undefined
  if (!expectedFormat) return false
  if (attachment.artifactFormat !== expectedFormat) return false
  if (attachmentExtension(attachment.filename) !== expectedFormat) return false
  const expectedMime = INTERNAL_GENERATED_ARTIFACT_MIME_BY_EXT.get(expectedFormat)
  if (!expectedMime) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expectedMime
}

function slackDocumentAttachments(attachments?: Attachment[]): Attachment[] {
  return (attachments || [])
    .filter(
      attachment =>
        isAllowedWorkflowDocument(attachment) ||
        (config.enableResponseAttachments && isAllowedInternalGeneratedDocument(attachment))
    )
    .slice(0, config.attachmentMaxCount)
}

function unsupportedAttachmentNote(count: number): string {
  const label = count === 1 ? 'attachment was' : 'attachments were'
  return `${count} ${label} generated but could not be delivered to Slack.`
}

type SlackConversationMetadata = {
  providerChannelType?: string | null
  providerChannelTitle?: string | null
}

function recordBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function slackConversationType(channel: Record<string, unknown>): string | null {
  if (recordBoolean(channel, 'is_im')) return 'im'
  if (recordBoolean(channel, 'is_mpim')) return 'mpim'
  if (recordBoolean(channel, 'is_private') || recordBoolean(channel, 'is_group')) {
    return 'private_channel'
  }
  if (recordBoolean(channel, 'is_channel')) return 'channel'
  return null
}

function slackConversationName(channel: Record<string, unknown>): string | null {
  const name = typeof channel.name === 'string' ? channel.name.trim() : ''
  return name || null
}

export class SlackAdapter implements ChannelAdapter {
  readonly channelType = 'slack' as const

  private client: WebClient | null = null
  private botToken: string | null = null
  private lastTimestamps: Map<string, string> = new Map()
  private userCache: Map<string, string> = new Map()
  private channelIdByNameCache: Map<string, string> = new Map()
  private verifiedSendersByChannel: Map<string, Set<string>> = new Map()
  private botUserId: string | null = null
  private teamId: string | null = null
  private defaultProviderTarget: ProviderTargetIdentity | null = null
  private warnedReplyOnlyNoUserId = false
  private readonly verificationClient: SlackVerificationClient | null

  constructor(verificationClient?: SlackVerificationClient | null) {
    this.verificationClient =
      verificationClient === undefined ? this.defaultVerificationClient() : verificationClient
  }

  private defaultVerificationClient(): SlackVerificationClient {
    return new RPCClient(config.mcpHostUrl)
  }

  private resetConnectionState(): void {
    this.client = null
    this.botToken = null
    this.botUserId = null
    this.teamId = null
    this.defaultProviderTarget = null
    this.warnedReplyOnlyNoUserId = false
    this.lastTimestamps.clear()
    this.userCache.clear()
    this.channelIdByNameCache.clear()
    this.verifiedSendersByChannel.clear()
  }

  private cacheChannelName(name: string | undefined, id: string | undefined): void {
    const normalized = name?.trim().replace(/^#/, '')
    if (!normalized || !id) return
    if (this.channelIdByNameCache.has(normalized)) {
      this.channelIdByNameCache.delete(normalized)
    } else if (this.channelIdByNameCache.size >= SLACK_CHANNEL_NAME_CACHE_MAX) {
      const firstKey = this.channelIdByNameCache.keys().next().value
      if (firstKey) this.channelIdByNameCache.delete(firstKey)
    }
    this.channelIdByNameCache.set(normalized, id)
  }

  private cacheUsername(userId: string, username: string): void {
    if (!userId || !username) return
    if (this.userCache.has(userId)) {
      this.userCache.delete(userId)
    } else if (this.userCache.size >= SLACK_USER_CACHE_MAX) {
      const firstKey = this.userCache.keys().next().value
      if (firstKey) this.userCache.delete(firstKey)
    }
    this.userCache.set(userId, username)
  }

  async connect(credentials?: AdapterCredentials): Promise<void> {
    this.resetConnectionState()
    const token = credentials?.slackBotToken?.trim()
    if (!token) {
      console.warn('[Slack] Bot token not configured, skipping')
      return
    }

    this.defaultProviderTarget = credentials?.providerTarget ?? null
    this.client = new WebClient(token)
    this.botToken = token

    try {
      const response = await this.client.auth.test()
      this.botUserId = typeof response.user_id === 'string' ? response.user_id : null
      this.teamId = typeof response.team_id === 'string' ? response.team_id : null
      console.log(`[Slack] Connected as @${response.user}`)
    } catch (error) {
      console.error('[Slack] Failed to connect:', error)
      this.client = null
      this.botToken = null
      this.botUserId = null
      this.teamId = null
    }
  }

  async disconnect(): Promise<void> {
    this.resetConnectionState()
  }

  async fetchMessages(
    channelId: string,
    allowedSenders: Set<string>,
    options?: FetchMessagesOptions
  ): Promise<Message[]> {
    if (!this.client) {
      console.log('[Slack] Not connected, skipping')
      return []
    }

    const messages: Message[] = []

    if (options?.replyOnlyWhenMentioned && !this.botUserId && !this.warnedReplyOnlyNoUserId) {
      this.warnedReplyOnlyNoUserId = true
      console.warn(
        '[Slack] replyOnlyWhenMentioned is enabled but bot user_id is missing from auth.test; ' +
          'non-approval messages will be dropped until Slack returns a valid user_id.'
      )
    }

    try {
      // Conversation-wide mode intentionally discovers readable Slack conversations before
      // fetching messages, so the first poll can block on conversations.list pagination.
      const resolvedChannelIds = options?.scanSlackConversations
        ? await this.listConversationIds()
        : [await this.resolveChannelId(channelId)].filter((id): id is string => !!id)
      if (resolvedChannelIds.length === 0) {
        console.warn(`[Slack] Could not resolve channel ${channelId}`)
        return []
      }

      for (const resolvedChannelId of resolvedChannelIds) {
        const timestampKey = this.timestampKey(channelId, resolvedChannelId, options)
        const oldest = this.lastTimestamps.get(timestampKey) || '0'

        const response = await this.client.conversations.history({
          channel: resolvedChannelId,
          oldest,
          limit: 100,
        })

        for (const msg of response.messages || []) {
          // Skip bot messages and non-user messages
          if (msg.subtype || !msg.user) {
            continue
          }

          const userId = msg.user
          const text = msg.text || ''
          const ts = msg.ts || ''
          const logText = redactSlackVerificationText(text)

          const configuredWorkspaceId = options?.providerWorkspaceId?.trim() || null
          const providerWorkspaceId =
            this.teamId ??
            ((msg as Record<string, unknown>).team as string | undefined) ??
            ((msg as Record<string, unknown>).team_id as string | undefined) ??
            null
          if (
            configuredWorkspaceId &&
            providerWorkspaceId &&
            configuredWorkspaceId !== providerWorkspaceId
          ) {
            console.log(
              `[Slack] Ignoring message from workspace ${providerWorkspaceId}; configured workspace is ${configuredWorkspaceId}`
            )
            continue
          }

          const currentLast = this.lastTimestamps.get(timestampKey) || '0'
          if (ts > currentLast) {
            this.lastTimestamps.set(timestampKey, ts)
          }

          if (isSlackVerifyCommand(text)) {
            const providerTarget = options?.providerTarget ?? this.defaultProviderTarget
            const conversationMetadata = await this.getConversationMetadata(
              resolvedChannelId,
              userId
            )
            void handleSlackVerificationCommand({
              channelId: resolvedChannelId,
              nonce: parseSlackVerifyCommand(text),
              providerUserId: userId,
              providerWorkspaceId,
              providerChannelType: conversationMetadata.providerChannelType ?? null,
              providerChannelTitle: conversationMetadata.providerChannelTitle ?? null,
              providerTarget,
              verificationClient: this.verificationClient,
              sendReply: async content => {
                await this.sendMessage(resolvedChannelId, content, ts)
              },
            })
              .then(confirmed => {
                if (confirmed) {
                  this.primeVerifiedSlackChannel(resolvedChannelId, userId)
                }
              })
              .catch(err => {
                console.error(
                  '[Slack] Verification command handler failed:',
                  err instanceof Error ? err.message : err
                )
              })
            console.log(
              `[Slack] Verification command received - channel: ${resolvedChannelId}, sender: ${userId}, text: "${logText.substring(0, 50)}..."`
            )
            continue
          }

          if (options?.slackVerificationOnly) {
            continue
          }

          // Get username for legacy allowlists and logs. Workflow approval
          // decisions use providerIdentity.providerUserId, not this display name.
          const username = await this.getUsername(userId)

          // Prefer stable Slack user IDs. Legacy username allowlists remain for
          // non-workflow chat compatibility while CommunicationChannel configs
          // migrate to userIds.
          const allowedByUserId = isAllowedSender(userId, allowedSenders)
          const allowedByVerifiedSender = this.verifiedSendersByChannel
            .get(resolvedChannelId)
            ?.has(userId)
          const allowedByUsername = isAllowedSender(username, allowedSenders)
          const workflowApprovalCommand = isWorkflowApprovalDecisionCommand(text)
          if (workflowApprovalCommand && !providerWorkspaceId) {
            console.log(
              `[Slack] Ignoring workflow approval command from ${userId}; workspace identity is unavailable`
            )
            continue
          }
          if (workflowApprovalCommand && !allowedByUserId && !allowedByVerifiedSender) {
            console.log(
              `[Slack] Ignoring workflow approval command from ${userId}; stable user_id is not allowlisted`
            )
            continue
          }
          if (
            !workflowApprovalCommand &&
            !allowedByUserId &&
            !allowedByVerifiedSender &&
            !allowedByUsername
          ) {
            console.log(`[Slack] Ignoring message from unauthorized user ${userId} (@${username})`)
            continue
          }

          const requireMention = !!options?.replyOnlyWhenMentioned
          if (requireMention && !isInlineApprovalCommand(text)) {
            if (!this.botUserId) {
              continue
            }
            if (!text.includes(`<@${this.botUserId}>`)) {
              console.log(`[Slack] Ignoring message (replyOnlyWhenMentioned: no app mention)`)
              continue
            }
          }

          const providerIdentity = providerWorkspaceId
            ? {
                medium: 'slack' as const,
                providerUserId: userId,
                providerWorkspaceId,
                providerChannelId: resolvedChannelId,
                providerEventId: `slack:${providerWorkspaceId}:${resolvedChannelId}:${ts}`,
                ...(options?.providerTarget ? { providerTarget: options.providerTarget } : {}),
              }
            : undefined

          messages.push({
            channelType: 'slack',
            channelId: resolvedChannelId,
            sender: userId,
            content: text,
            timestamp: new Date(parseFloat(ts) * 1000),
            messageId: ts,
            threadId: (msg as Record<string, unknown>).thread_ts as string | undefined,
            ...(providerIdentity ? { providerIdentity } : {}),
            rawData: msg as unknown as Record<string, unknown>,
          })

          console.log(`[Slack] Received message from ${userId} (@${username})`)
        }
      }
    } catch (error) {
      console.error('[Slack] API error:', error)
    }

    return messages
  }

  private timestampKey(
    channelId: string,
    resolvedChannelId: string,
    options?: FetchMessagesOptions
  ): string {
    if (options?.scanSlackConversations) {
      const target = options.providerTarget
        ? `${options.providerTarget.communicationChannelNamespace}/${options.providerTarget.communicationChannelName}`
        : 'default'
      return `scan:${target}:${resolvedChannelId}`
    }
    return channelId
  }

  private primeVerifiedSlackChannel(channelId: string, userId: string): void {
    if (!channelId || !userId) return
    const current = this.verifiedSendersByChannel.get(channelId) ?? new Set<string>()
    current.add(userId)
    this.verifiedSendersByChannel.set(channelId, current)
  }

  private async listConversationIds(): Promise<string[]> {
    if (!this.client) return []
    const ids: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      pages += 1
      const response = await this.client.conversations.list({
        types: 'public_channel,private_channel,im,mpim',
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })
      for (const channel of response.channels || []) {
        const record = channel as Record<string, unknown>
        const botCanRead =
          record.is_member === true || record.is_im === true || record.is_mpim === true
        this.cacheChannelName(
          typeof channel.name === 'string' ? channel.name : undefined,
          channel.id
        )
        if (channel.id && botCanRead) ids.push(channel.id)
      }
      cursor = response.response_metadata?.next_cursor || undefined
      if (cursor && pages >= SLACK_CONVERSATION_LIST_MAX_PAGES) {
        console.warn(
          `[Slack] Stopping conversation scan after ${SLACK_CONVERSATION_LIST_MAX_PAGES} pages; Slack returned more pages than expected`
        )
        break
      }
    } while (cursor)
    return ids
  }

  private async resolveChannelId(channelId: string): Promise<string | null> {
    // If it looks like an ID (starts with C, D, or G), return as-is
    if (channelId && /^[CDG]/.test(channelId)) {
      return channelId
    }

    const normalizedName = channelId.replace(/^#/, '')
    const cached = this.channelIdByNameCache.get(normalizedName)
    if (cached) return cached

    console.warn(
      `[Slack] Resolving channel "${channelId}" by name. Configure a stable Slack channel ID to avoid lookup delays and rate-limit pressure.`
    )

    // Otherwise, try to find by name.
    try {
      let cursor: string | undefined
      let pages = 0
      do {
        pages += 1
        const response = await this.client!.conversations.list({
          types: 'public_channel,private_channel,im,mpim',
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })

        for (const channel of response.channels || []) {
          this.cacheChannelName(
            typeof channel.name === 'string' ? channel.name : undefined,
            channel.id
          )
          if (channel.name === normalizedName) {
            return channel.id || null
          }
        }

        cursor = response.response_metadata?.next_cursor || undefined
        if (cursor && pages >= SLACK_CONVERSATION_LIST_MAX_PAGES) {
          console.warn(
            `[Slack] Stopping channel name lookup after ${SLACK_CONVERSATION_LIST_MAX_PAGES} pages; Slack returned more pages than expected`
          )
          break
        }
      } while (cursor)
    } catch (error) {
      console.warn(
        `[Slack] Failed to resolve channel ${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    return null
  }

  private async getUsername(userId: string): Promise<string> {
    // Check cache
    const cached = this.userCache.get(userId)
    if (cached) {
      return cached
    }

    try {
      const response = await this.client!.users.info({ user: userId })
      const username = response.user?.name || userId
      this.cacheUsername(userId, username)
      return username
    } catch {
      return userId
    }
  }

  async getConversationMetadata(
    channelId: string,
    providerUserId?: string | null
  ): Promise<SlackConversationMetadata> {
    if (!this.client) return {}
    const resolvedChannelId = await this.resolveChannelId(channelId)
    if (!resolvedChannelId) return {}

    try {
      const response = await this.client.conversations.info({ channel: resolvedChannelId })
      const channel =
        response.channel && typeof response.channel === 'object'
          ? (response.channel as Record<string, unknown>)
          : {}
      const providerChannelType = slackConversationType(channel)
      let title: string | null = null

      if (providerChannelType === 'im') {
        const slackUserId =
          (typeof channel.user === 'string' ? channel.user.trim() : '') ||
          providerUserId?.trim() ||
          ''
        const username = slackUserId ? await this.getUsername(slackUserId) : ''
        title = username ? `@${username.replace(/^@/, '')}` : null
      } else {
        const name = slackConversationName(channel)
        title = name && providerChannelType !== 'mpim' ? `#${name.replace(/^#/, '')}` : name
      }

      return {
        ...(providerChannelType ? { providerChannelType } : {}),
        ...(title ? { providerChannelTitle: title } : {}),
      }
    } catch (err) {
      console.warn(
        `[Slack] Could not read conversation metadata for ${channelId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return {}
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<string | undefined> {
    if (!this.client) {
      console.warn('[Slack] Not connected, cannot send message')
      return undefined
    }

    try {
      const resolvedChannelId = await this.resolveChannelId(channelId)
      if (!resolvedChannelId) {
        console.error(`[Slack] Could not resolve channel ${channelId}`)
        return undefined
      }

      const documentAttachments = slackDocumentAttachments(attachments)
      const unsupportedAttachmentCount = Math.max(
        0,
        (attachments?.length || 0) - documentAttachments.length
      )
      const contentWithUnsupportedAttachmentNote =
        unsupportedAttachmentCount > 0
          ? `${content.trim()}\n\n[Note: ${unsupportedAttachmentNote(unsupportedAttachmentCount)}]`
          : content
      const hasText = !!content.trim()
      const hasBlocks = !!options?.slackBlocks?.length
      const slackBlocks =
        hasBlocks && unsupportedAttachmentCount > 0
          ? [
              ...(options!.slackBlocks || []),
              {
                type: 'section' as const,
                text: {
                  type: 'mrkdwn' as const,
                  text: `_Note: ${unsupportedAttachmentNote(unsupportedAttachmentCount)}_`,
                },
              },
            ]
          : options?.slackBlocks
      const fallbackText =
        unsupportedAttachmentCount > 0
          ? unsupportedAttachmentNote(unsupportedAttachmentCount)
          : 'Generated document attachments could not be delivered.'
      let messageTs: string | undefined

      if (!hasText && !hasBlocks && (!attachments || attachments.length === 0)) {
        return undefined
      }

      if (
        hasText ||
        hasBlocks ||
        documentAttachments.length === 0 ||
        unsupportedAttachmentCount > 0
      ) {
        const result = await this.client.chat.postMessage({
          channel: resolvedChannelId,
          text: hasText ? contentWithUnsupportedAttachmentNote : fallbackText,
          thread_ts: replyToMessageId,
          ...(hasBlocks ? { blocks: slackBlocks as never } : {}),
        })
        messageTs = result.ts
      }

      if (documentAttachments.length > 0) {
        const fileUploads: Array<{ file: Buffer; filename: string; title: string }> = []
        for (const attachment of documentAttachments) {
          const estimatedBytes = approxDecodedBytes(attachment.dataBase64)
          if (estimatedBytes > config.attachmentMaxBytes) {
            console.warn(
              `[Slack] Skipping oversized document attachment ${attachment.id} (${estimatedBytes} bytes)`
            )
            continue
          }

          try {
            const filename = safeDocumentFilename(attachment.filename, `${attachment.id}.dat`)
            fileUploads.push({
              file: Buffer.from(attachment.dataBase64, 'base64'),
              filename,
              title: filename,
            })
          } catch (err) {
            console.warn(`[Slack] Failed to decode document attachment ${attachment.id}:`, err)
          }
        }

        if (fileUploads.length > 0) {
          try {
            await this.client.files.uploadV2({
              channel_id: resolvedChannelId,
              ...(replyToMessageId ? { thread_ts: replyToMessageId } : {}),
              file_uploads: fileUploads,
            })
            console.log(
              `[Slack] Sent reply to channel ${channelId} (${fileUploads.length} document attachment(s))`
            )
            return messageTs
          } catch (err) {
            console.warn('[Slack] Failed to deliver document attachments:', err)
          }
        }

        if (messageTs) {
          await this.client.chat.postMessage({
            channel: resolvedChannelId,
            text: 'Generated document attachments could not be delivered.',
            thread_ts: replyToMessageId,
          })
          return messageTs
        }
        const fallback = await this.client.chat.postMessage({
          channel: resolvedChannelId,
          text: 'Generated document attachments could not be delivered.',
          thread_ts: replyToMessageId,
        })
        return fallback.ts
      }

      console.log(`[Slack] Sent reply to channel ${channelId}`)
      return messageTs
    } catch (err) {
      console.error('[Slack] Failed to send message:', err)
      throw err
    }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (!this.client) {
      console.warn('[Slack] Not connected, cannot edit message')
      return
    }

    try {
      const resolvedChannelId = await this.resolveChannelId(channelId)
      if (!resolvedChannelId) {
        console.error(`[Slack] Could not resolve channel ${channelId}`)
        return
      }

      await this.client.chat.update({
        channel: resolvedChannelId,
        ts: messageId,
        text: content,
        blocks: (options?.slackBlocks ?? []) as never,
      })
    } catch (err) {
      console.error(
        `[Slack] Failed to edit message ${messageId}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  async sendEphemeral(channelId: string, userId: string, content: string): Promise<void> {
    if (!this.client) {
      console.warn('[Slack] Not connected, cannot send ephemeral message')
      return
    }
    try {
      await this.client.chat.postEphemeral({ channel: channelId, user: userId, text: content })
    } catch (error) {
      // Never let a failed notice break message processing.
      console.warn(
        `[Slack] Could not send ephemeral notice to ${userId} in ${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /**
   * Hydrate `files[]` for a single `event_callback` `app_mention` that arrived
   * without embedded attachments. Uses `conversations.replies` (limit 10,
   * matching `m.ts === messageTs`) when `threadTs` is present, or
   * `conversations.history` (limit 1) for top-level messages (R9/R56).
   */
  async hydrateMessageAttachments(params: {
    channelId: string
    messageTs: string
    threadTs?: string | null
  }): Promise<ProviderAttachmentDescriptorV1[]> {
    const client = this.client
    if (!client || !params.channelId?.trim() || !params.messageTs?.trim()) {
      return []
    }
    const channel = params.channelId.trim()
    const messageTs = params.messageTs.trim()
    const threadTs = params.threadTs?.trim() || null

    try {
      if (threadTs) {
        const response = await client.conversations.replies({
          channel,
          ts: threadTs,
          latest: messageTs,
          oldest: messageTs,
          inclusive: true,
          limit: 10,
        })
        const matched = (response.messages || []).find(
          item => (item as Record<string, unknown>).ts === messageTs
        ) as Record<string, unknown> | undefined
        return extractSlackFileDescriptors(matched?.files)
      }

      const response = await client.conversations.history({
        channel,
        latest: messageTs,
        oldest: messageTs,
        inclusive: true,
        limit: 1,
      })
      const matched = (response.messages || []).find(
        item => (item as Record<string, unknown>).ts === messageTs
      ) as Record<string, unknown> | undefined
      return extractSlackFileDescriptors(matched?.files)
    } catch (error) {
      console.warn(
        `[Slack] Failed to hydrate message attachments for ${channel}:${messageTs}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return []
    }
  }

  /**
   * Download raw bytes for a Slack attachment descriptor using snapshotted
   * credentials safe across CRD restarts (R10, R11, R12, R20).
   */
  async downloadAttachment(
    descriptor: ProviderAttachmentDescriptorV1,
    options?: DownloadAttachmentOptions
  ): Promise<ChannelAttachmentDownloadResult> {
    if (descriptor.downloadRef.provider !== 'slack') {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Mismatched attachment descriptor provider for Slack adapter.',
        retryable: false,
      }
    }

    // Snapshot client and token synchronously before any await (R20).
    const snapshotClient = this.client
    const snapshotToken = this.botToken

    if (!snapshotToken) {
      return {
        ok: false,
        code: 'provider_not_connected',
        message: 'Slack adapter is not connected.',
        retryable: true,
      }
    }

    const maxBytes = options?.maxBytes ?? config.channelAttachmentMaxBytes ?? 11_534_336
    const ref = descriptor.downloadRef

    if (ref.isExternal === true) {
      return {
        ok: false,
        code: 'provider_remote_file_unsupported',
        message: 'External remote Slack files are not supported.',
        retryable: false,
      }
    }

    if (
      typeof descriptor.reportedSizeBytes === 'number' &&
      descriptor.reportedSizeBytes > maxBytes
    ) {
      return {
        ok: false,
        code: 'file_too_large',
        message: `Slack file exceeds the ${maxBytes} byte limit.`,
        retryable: false,
      }
    }

    let downloadUrl = ref.urlPrivateDownload?.trim() || ref.urlPrivate?.trim() || null
    let filename = descriptor.filename
    let declaredMediaType = descriptor.declaredMediaType

    if (ref.fileAccess === 'check_file_info' || (!downloadUrl && ref.fileId)) {
      if (!snapshotClient?.files?.info) {
        return {
          ok: false,
          code: 'provider_file_unavailable',
          message: 'Slack files.info API is unavailable to resolve file access.',
          retryable: false,
        }
      }
      try {
        const info = (await snapshotClient.files.info({ file: ref.fileId })) as {
          ok?: boolean
          error?: string
          file?: Record<string, unknown>
        }
        if (info.error === 'missing_scope') {
          return {
            ok: false,
            code: 'slack_files_read_scope_missing',
            message:
              'Slack app is missing the files:read scope. Reinstall the Slack app with files:read permission.',
            retryable: false,
          }
        }
        const file = info.file
        if (!file) {
          return {
            ok: false,
            code: 'provider_file_unavailable',
            message: 'Slack file metadata was unavailable.',
            retryable: false,
          }
        }
        if (file.is_external === true) {
          return {
            ok: false,
            code: 'provider_remote_file_unsupported',
            message: 'External remote Slack files are not supported.',
            retryable: false,
          }
        }
        if (typeof file.size === 'number' && file.size > maxBytes) {
          return {
            ok: false,
            code: 'file_too_large',
            message: `Slack file exceeds the ${maxBytes} byte limit.`,
            retryable: false,
          }
        }
        downloadUrl =
          (typeof file.url_private_download === 'string' && file.url_private_download.trim()) ||
          (typeof file.url_private === 'string' && file.url_private.trim()) ||
          null
        if (!filename && typeof file.name === 'string' && file.name.trim()) {
          filename = file.name.trim()
        }
        if (!declaredMediaType && typeof file.mimetype === 'string' && file.mimetype.trim()) {
          declaredMediaType = file.mimetype.trim()
        }
      } catch (err) {
        if (isSlackMissingScopeError(err)) {
          return {
            ok: false,
            code: 'slack_files_read_scope_missing',
            message:
              'Slack app is missing the files:read scope. Reinstall the Slack app with files:read permission.',
            retryable: false,
          }
        }
        return {
          ok: false,
          code: 'provider_file_unavailable',
          message: 'Slack files.info lookup failed for this attachment.',
          retryable: false,
        }
      }
    }

    if (!downloadUrl) {
      return {
        ok: false,
        code: 'provider_file_unavailable',
        message: 'Slack file has no downloadable private URL.',
        retryable: false,
      }
    }

    let currentUrl: URL
    try {
      currentUrl = new URL(downloadUrl)
    } catch {
      return {
        ok: false,
        code: 'provider_remote_file_unsupported',
        message: 'Slack file URL is malformed.',
        retryable: false,
      }
    }

    if (!isAllowedSlackDownloadHost(currentUrl)) {
      return {
        ok: false,
        code: 'provider_remote_file_unsupported',
        message: 'Slack file download URL points to a non-Slack host.',
        retryable: false,
      }
    }

    if (isSlackSignInPath(currentUrl)) {
      return {
        ok: false,
        code: 'slack_files_read_scope_missing',
        message: 'Slack file URL points to sign-in. Ensure the Slack app has the files:read scope.',
        retryable: false,
      }
    }

    try {
      let response: Response | null = null
      for (let hop = 0; hop <= SLACK_MAX_REDIRECTS; hop += 1) {
        if (!isAllowedSlackDownloadHost(currentUrl)) {
          return {
            ok: false,
            code: 'provider_remote_file_unsupported',
            message: 'Slack file redirected to a non-Slack host.',
            retryable: false,
          }
        }
        response = await fetch(currentUrl.toString(), {
          method: 'GET',
          headers: {
            authorization: `Bearer ${snapshotToken}`,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(SLACK_DOWNLOAD_TIMEOUT_MS),
        })

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location')
          if (!location) {
            return {
              ok: false,
              code: 'provider_download_failed',
              message: 'Slack file download returned a redirect without a Location header.',
              retryable: false,
            }
          }
          let nextUrl: URL
          try {
            nextUrl = new URL(location, currentUrl)
          } catch {
            return {
              ok: false,
              code: 'provider_remote_file_unsupported',
              message: 'Slack file redirected to an invalid URL.',
              retryable: false,
            }
          }
          if (isSlackSignInPath(nextUrl)) {
            return {
              ok: false,
              code: 'slack_files_read_scope_missing',
              message:
                'Slack redirected the file download to sign-in. Ensure the Slack app has the files:read scope.',
              retryable: false,
            }
          }
          if (!isAllowedSlackDownloadHost(nextUrl)) {
            return {
              ok: false,
              code: 'provider_remote_file_unsupported',
              message: 'Slack file redirected to an external non-Slack host.',
              retryable: false,
            }
          }
          currentUrl = nextUrl
          continue
        }
        break
      }

      if (!response || (response.status >= 300 && response.status < 400)) {
        return {
          ok: false,
          code: 'provider_download_failed',
          message: 'Slack file download exceeded maximum redirect hops.',
          retryable: false,
        }
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: 'slack_files_read_scope_missing',
          message: `Slack denied file download (HTTP ${response.status}). Ensure the Slack app has the files:read scope.`,
          retryable: false,
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          code: 'provider_download_failed',
          message: `Slack file download failed (HTTP ${response.status}).`,
          retryable: response.status >= 500,
        }
      }

      const contentType = (response.headers?.get?.('content-type') || '').toLowerCase()
      const bounded = await readBoundedResponseBytes(response, maxBytes)
      if (!bounded.ok) {
        return bounded
      }

      const declaredLower = (declaredMediaType || '').split(';', 1)[0]?.trim().toLowerCase()
      if (
        contentType.includes('text/html') &&
        (declaredLower !== 'text/html' || looksLikeSlackLoginHtml(bounded.bytes))
      ) {
        return {
          ok: false,
          code: 'slack_files_read_scope_missing',
          message:
            'Slack returned an HTML login page instead of file bytes. Ensure the Slack app has the files:read scope.',
          retryable: false,
        }
      }

      return {
        ok: true,
        bytes: bounded.bytes,
        filename,
        declaredMediaType,
      }
    } catch {
      return {
        ok: false,
        code: 'provider_download_failed',
        message: 'Network error while downloading Slack file.',
        retryable: true,
      }
    }
  }
}

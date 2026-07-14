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
  FetchMessagesOptions,
  Message,
  ProviderTargetIdentity,
  SendMessageOptions,
} from '../types'
import { isAllowedSender, isInlineApprovalCommand, isWorkflowApprovalDecisionCommand } from './base'
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

export class SlackAdapter implements ChannelAdapter {
  readonly channelType = 'slack' as const

  private client: WebClient | null = null
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

    try {
      const response = await this.client.auth.test()
      this.botUserId = typeof response.user_id === 'string' ? response.user_id : null
      this.teamId = typeof response.team_id === 'string' ? response.team_id : null
      console.log(`[Slack] Connected as @${response.user}`)
    } catch (error) {
      console.error('[Slack] Failed to connect:', error)
      this.client = null
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
            void handleSlackVerificationCommand({
              channelId: resolvedChannelId,
              nonce: parseSlackVerifyCommand(text),
              providerUserId: userId,
              providerWorkspaceId,
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

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
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
      })
    } catch (err) {
      console.error(
        `[Slack] Failed to edit message ${messageId}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}

import { config } from '../config'
import {
  AdapterCredentials,
  Attachment,
  ChannelAdapter,
  FetchMessagesOptions,
  Message,
  SendMessageOptions,
} from '../types'

type BotToken = {
  accessToken: string
  expiresAtMs: number
}

type TeamsActivityResponse = {
  id?: string
}

export type TeamsFileConsentContext = {
  workflowRunId: string
  artifactName: string
}

export type TeamsFileUploadInfo = {
  contentUrl: string
  uploadUrl: string
  uniqueId: string
  name?: string
  fileType?: string
}

const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default'
const MICROSOFT_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const TEXT_ATTACHMENT_MIME = new Set([
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
])

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function rootTeamsConversationId(value: string): string {
  return value.replace(/[;?&]messageid=[^;?&]+.*/i, '')
}

export function isAllowedTeamsServiceUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    return (
      hostname === 'botframework.com' ||
      hostname.endsWith('.botframework.com') ||
      hostname === 'trafficmanager.net' ||
      hostname.endsWith('.trafficmanager.net')
    )
  } catch {
    return false
  }
}

export function isAllowedTeamsFileUploadUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    return [
      'sharepoint.com',
      'sharepoint-df.com',
      'sharepointonline.com',
      'onedrive.com',
      '1drv.com',
    ].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

function safeDocumentFilename(filename: string | undefined, fallback: string): string {
  const raw = (filename || fallback).replace(/\\/g, '/').split('/').pop() || fallback
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function decodedAttachmentText(attachment: Attachment): string | null {
  const mime = attachment.mimeType.split(';', 1)[0]?.toLowerCase() || ''
  if (!TEXT_ATTACHMENT_MIME.has(mime)) return null
  const approxBytes = Math.floor((attachment.dataBase64.length * 3) / 4)
  if (approxBytes > Math.min(config.attachmentMaxBytes, 64 * 1024)) return null
  try {
    return Buffer.from(attachment.dataBase64, 'base64').toString('utf8')
  } catch {
    return null
  }
}

function codeFenceForAttachment(attachment: Attachment, text: string): string {
  const filename = safeDocumentFilename(attachment.filename, `${attachment.id}.txt`)
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() || '' : ''
  const info = ext === 'md' ? 'markdown' : ext === 'json' ? 'json' : ''
  return `Generated file: ${filename}\n\n\`\`\`${info}\n${text.slice(0, 4000)}\n\`\`\``
}

function adaptiveCard(
  content: string,
  options?: SendMessageOptions
): Record<string, unknown> | null {
  const actions = options?.teamsActions ?? []
  if (actions.length === 0) return null
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      type: 'AdaptiveCard',
      $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: content,
          wrap: true,
        },
      ],
      actions: actions.map(action => ({
        type: 'Action.Submit',
        title: action.title,
        data: {
          action: action.value,
          msteams: {
            type: 'messageBack',
            displayText: action.title,
            text: action.value,
            value: { action: action.value },
          },
        },
        ...(action.style === 'destructive' ? { style: 'destructive' } : {}),
        ...(action.style === 'positive' ? { style: 'positive' } : {}),
      })),
    },
  }
}

export class TeamsAdapter implements ChannelAdapter {
  readonly channelType = 'teams' as const

  private appId: string | null = null
  private appPassword: string | null = null
  private tenantId: string | null = null
  private token: BotToken | null = null
  private serviceUrlByConversationId = new Map<string, string>()

  async connect(credentials?: AdapterCredentials): Promise<void> {
    this.appId = credentials?.teamsAppId?.trim() || null
    this.appPassword = credentials?.teamsAppPassword?.trim() || null
    this.tenantId = credentials?.teamsTenantId?.trim() || null
    this.token = null
    this.serviceUrlByConversationId = new Map(credentials?.teamsServiceUrlsByConversationId ?? [])
    if (!this.appId || !this.appPassword || !this.tenantId) {
      console.warn('[Teams] App id, tenant id, or client secret is missing, skipping')
      return
    }
    console.log('[Teams] Adapter configured')
  }

  async disconnect(): Promise<void> {
    this.appId = null
    this.appPassword = null
    this.tenantId = null
    this.token = null
    this.serviceUrlByConversationId.clear()
  }

  rememberConversation(conversationId: string, serviceUrl: string): void {
    const normalizedConversationId = conversationId.trim()
    const normalizedServiceUrl = serviceUrl.trim()
    if (!normalizedConversationId || !normalizedServiceUrl) return
    if (!isAllowedTeamsServiceUrl(normalizedServiceUrl)) {
      console.warn(`[Teams] Ignoring unsupported serviceUrl host for ${normalizedConversationId}`)
      return
    }
    this.serviceUrlByConversationId.set(normalizedConversationId, normalizedServiceUrl)
  }

  async fetchMessages(
    _channelId: string,
    _allowedSenders: Set<string>,
    _options?: FetchMessagesOptions
  ): Promise<Message[]> {
    return []
  }

  private async accessToken(): Promise<string> {
    if (!this.appId || !this.appPassword || !this.tenantId) {
      throw new Error('teams_credentials_missing')
    }
    if (this.token && Date.now() < this.token.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.token.accessToken
    }

    const body = new URLSearchParams()
    body.set('client_id', this.appId)
    body.set('client_secret', this.appPassword)
    body.set('grant_type', 'client_credentials')
    body.set('scope', BOT_CONNECTOR_SCOPE)
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(MICROSOFT_REQUEST_TIMEOUT_MS),
      }
    )
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    if (!response.ok || !payload.access_token) {
      const aadErrorCode = payload.error_description?.match(/\bAADSTS\d+\b/)?.[0]
      throw new Error(
        ['teams_token_failed', payload.error, aadErrorCode || String(response.status)]
          .filter(Boolean)
          .join(':')
      )
    }
    this.token = {
      accessToken: payload.access_token,
      expiresAtMs: Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000,
    }
    return this.token.accessToken
  }

  async verifyCredentials(): Promise<void> {
    await this.accessToken()
  }

  private serviceUrlForConversation(channelId: string): string {
    const serviceUrl =
      this.serviceUrlByConversationId.get(channelId) ||
      this.serviceUrlByConversationId.get(rootTeamsConversationId(channelId))
    if (!serviceUrl) {
      throw new Error(`teams_service_url_missing:${channelId}`)
    }
    if (!isAllowedTeamsServiceUrl(serviceUrl)) {
      throw new Error(`teams_service_url_unsupported:${channelId}`)
    }
    return trimTrailingSlash(serviceUrl)
  }

  private async postActivity(
    channelId: string,
    activity: Record<string, unknown>,
    replyToActivityId?: string
  ): Promise<string | undefined> {
    const token = await this.accessToken()
    const serviceUrl = this.serviceUrlForConversation(channelId)
    const base = `${serviceUrl}/v3/conversations/${encodeURIComponent(channelId)}/activities`
    const url = replyToActivityId ? `${base}/${encodeURIComponent(replyToActivityId)}` : base
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(MICROSOFT_REQUEST_TIMEOUT_MS),
    })
    const payload = (await response.json().catch(() => ({}))) as TeamsActivityResponse & {
      error?: string
    }
    if (!response.ok) {
      throw new Error(payload.error || `teams_activity_failed_${response.status}`)
    }
    return payload.id
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<string | undefined> {
    const card = adaptiveCard(content, options)
    const activity: Record<string, unknown> = card
      ? {
          type: 'message',
          summary: content,
          attachments: [card],
        }
      : {
          type: 'message',
          text: content || ' ',
        }
    if (replyToMessageId) {
      activity.replyToId = replyToMessageId
    }

    const messageId = await this.postActivity(channelId, activity, replyToMessageId)
    const documents = (attachments ?? []).slice(0, config.attachmentMaxCount)
    let unsupported = 0
    for (const attachment of documents) {
      const text = decodedAttachmentText(attachment)
      if (!text) {
        unsupported += 1
        continue
      }
      await this.postActivity(
        channelId,
        {
          type: 'message',
          text: codeFenceForAttachment(attachment, text),
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        },
        replyToMessageId
      )
    }
    if (unsupported > 0) {
      await this.postActivity(
        channelId,
        {
          type: 'message',
          text: `${unsupported} generated file(s) could not be delivered to Teams.`,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        },
        replyToMessageId
      )
    }
    return messageId
  }

  async sendFileConsent(
    channelId: string,
    attachment: Attachment,
    context: TeamsFileConsentContext,
    replyToMessageId?: string
  ): Promise<string | undefined> {
    const filename = safeDocumentFilename(attachment.filename, `${attachment.id}.bin`)
    const sizeInBytes = Buffer.byteLength(attachment.dataBase64, 'base64')
    return this.postActivity(
      channelId,
      {
        type: 'message',
        ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.card.file.consent',
            name: filename,
            content: {
              description: 'Workflow result',
              sizeInBytes,
              acceptContext: context,
              declineContext: context,
            },
          },
        ],
      },
      replyToMessageId
    )
  }

  async uploadConsentedFile(
    channelId: string,
    attachment: Attachment,
    uploadInfo: TeamsFileUploadInfo,
    replyToMessageId?: string
  ): Promise<string | undefined> {
    if (
      !isAllowedTeamsFileUploadUrl(uploadInfo.uploadUrl) ||
      !isAllowedTeamsFileUploadUrl(uploadInfo.contentUrl)
    ) {
      throw new Error('teams_file_upload_url_unsupported')
    }
    const body = Buffer.from(attachment.dataBase64, 'base64')
    const uploadResponse = await fetch(uploadInfo.uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(body.byteLength),
        'content-range': `bytes 0-${Math.max(0, body.byteLength - 1)}/${body.byteLength}`,
      },
      body,
      signal: AbortSignal.timeout(MICROSOFT_REQUEST_TIMEOUT_MS),
    })
    if (!uploadResponse.ok) {
      throw new Error(`teams_file_upload_failed_${uploadResponse.status}`)
    }

    const filename = safeDocumentFilename(
      uploadInfo.name || attachment.filename,
      `${attachment.id}.bin`
    )
    const fileType =
      uploadInfo.fileType?.trim() || filename.split('.').pop()?.toLowerCase() || 'bin'
    return this.postActivity(
      channelId,
      {
        type: 'message',
        ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.card.file.info',
            contentUrl: uploadInfo.contentUrl,
            name: filename,
            content: {
              uniqueId: uploadInfo.uniqueId,
              fileType,
            },
          },
        ],
      },
      replyToMessageId
    )
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const token = await this.accessToken()
    const serviceUrl = this.serviceUrlForConversation(channelId)
    const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(
      channelId
    )}/activities/${encodeURIComponent(messageId)}`
    const card = adaptiveCard(content, options)
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        card
          ? {
              type: 'message',
              summary: content || ' ',
              attachments: [card],
            }
          : { type: 'message', text: content || ' ', attachments: [] }
      ),
      signal: AbortSignal.timeout(MICROSOFT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`teams_activity_edit_failed_${response.status}`)
    }
  }
}

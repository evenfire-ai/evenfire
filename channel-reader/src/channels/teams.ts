import { config } from '../config'
import {
  AdapterCredentials,
  Attachment,
  ChannelAdapter,
  ChannelAttachmentDownloadResult,
  DownloadAttachmentOptions,
  FetchMessagesOptions,
  Message,
  ProviderAttachmentDescriptorV1,
  SendMessageOptions,
} from '../types'
import { readBoundedResponseBytes } from './downloadStream'

type BotToken = {
  accessToken: string
  expiresAtMs: number
}

export interface TeamsFileDownloadRequest {
  downloadUrl: string
  uniqueId?: string | null
  descriptor: ProviderAttachmentDescriptorV1
}

export interface TeamsFileDownloadAuthStrategy {
  prepareDownloadRequest(
    request: TeamsFileDownloadRequest
  ): Promise<
    | { ok: true; url: URL; headers: Record<string, string> }
    | { ok: false; code: string; message: string; retryable?: boolean }
  >
}

export class DefaultTeamsFileDownloadAuthStrategy implements TeamsFileDownloadAuthStrategy {
  async prepareDownloadRequest(
    request: TeamsFileDownloadRequest
  ): Promise<
    | { ok: true; url: URL; headers: Record<string, string> }
    | { ok: false; code: string; message: string; retryable?: boolean }
  > {
    const rawUrl = request.downloadUrl?.trim()
    if (!rawUrl) {
      return {
        ok: false,
        code: 'provider_scope_unsupported',
        message: 'Teams did not provide a downloadable file URL for this attachment.',
        retryable: false,
      }
    }
    if (!isAllowedTeamsFileUploadUrl(rawUrl)) {
      return {
        ok: false,
        code: 'provider_download_host_rejected',
        message: 'Teams file download URL host is not an allowlisted SharePoint or OneDrive host.',
        retryable: false,
      }
    }
    return {
      ok: true,
      url: new URL(rawUrl),
      headers: {},
    }
  }
}

export interface TeamsAdapterOptions {
  fileDownloadAuthStrategy?: TeamsFileDownloadAuthStrategy
}

type TeamsCredentialsSnapshot = {
  appId: string | null
  appPassword: string | null
  tenantId: string | null
  token: BotToken | null
  fileDownloadAuthStrategy: TeamsFileDownloadAuthStrategy
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
const TEAMS_DOWNLOAD_TIMEOUT_MS = 30_000
const TEAMS_MAX_REDIRECTS = 3
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

/**
 * Strictly allow Bot Framework bearer tokens ONLY on the exact HTTPS origin of
 * the JWT-verified `serviceUrl` or explicitly pinned Microsoft attachment hosts
 * (`smba.trafficmanager.net`, `*.botframework.com`, `*.asm.skype.com`).
 * NEVER allows wildcard `*.trafficmanager.net` (R14, R15, SF4).
 */
export function isAllowedTeamsInlineContentUrl(
  contentUrl: string,
  verifiedServiceUrl?: string | null
): boolean {
  try {
    const parsedContent = new URL(contentUrl.trim())
    if (parsedContent.protocol !== 'https:' || parsedContent.username || parsedContent.password) {
      return false
    }
    const hostname = parsedContent.hostname.toLowerCase()
    if (
      hostname === 'smba.trafficmanager.net' ||
      hostname === 'botframework.com' ||
      hostname.endsWith('.botframework.com') ||
      hostname === 'asm.skype.com' ||
      hostname.endsWith('.asm.skype.com')
    ) {
      return true
    }
    if (verifiedServiceUrl?.trim() && isAllowedTeamsServiceUrl(verifiedServiceUrl)) {
      const parsedService = new URL(verifiedServiceUrl.trim())
      if (parsedService.protocol === 'https:' && parsedContent.origin === parsedService.origin) {
        return true
      }
    }
    return false
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
          type: 'RichTextBlock',
          inlines: [{ type: 'TextRun', text: content }],
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
  private fileDownloadAuthStrategy: TeamsFileDownloadAuthStrategy

  constructor(options: TeamsAdapterOptions = {}) {
    this.fileDownloadAuthStrategy =
      options.fileDownloadAuthStrategy ?? new DefaultTeamsFileDownloadAuthStrategy()
  }

  setFileDownloadAuthStrategy(strategy: TeamsFileDownloadAuthStrategy): void {
    this.fileDownloadAuthStrategy = strategy
  }

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
    return this.accessTokenWithSnapshot({
      appId: this.appId,
      appPassword: this.appPassword,
      tenantId: this.tenantId,
      token: this.token,
      fileDownloadAuthStrategy: this.fileDownloadAuthStrategy,
    })
  }

  private async accessTokenWithSnapshot(snapshot: TeamsCredentialsSnapshot): Promise<string> {
    if (!snapshot.appId || !snapshot.appPassword || !snapshot.tenantId) {
      throw new Error('teams_credentials_missing')
    }
    if (snapshot.token && Date.now() < snapshot.token.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return snapshot.token.accessToken
    }

    const body = new URLSearchParams()
    body.set('client_id', snapshot.appId)
    body.set('client_secret', snapshot.appPassword)
    body.set('grant_type', 'client_credentials')
    body.set('scope', BOT_CONNECTOR_SCOPE)
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(snapshot.tenantId)}/oauth2/v2.0/token`,
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
    const nextToken: BotToken = {
      accessToken: payload.access_token,
      expiresAtMs: Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000,
    }
    if (
      this.appId === snapshot.appId &&
      this.appPassword === snapshot.appPassword &&
      this.tenantId === snapshot.tenantId
    ) {
      this.token = nextToken
    }
    return nextToken.accessToken
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

  /**
   * Download raw bytes for a Teams attachment descriptor using snapshotted
   * credentials safe across CRD restarts (R13, R14, R15, R16, R20, R70).
   */
  async downloadAttachment(
    descriptor: ProviderAttachmentDescriptorV1,
    options?: DownloadAttachmentOptions
  ): Promise<ChannelAttachmentDownloadResult> {
    if (descriptor.downloadRef.provider !== 'teams') {
      return {
        ok: false,
        code: 'provider_download_rejected',
        message: 'Mismatched attachment descriptor provider for Teams adapter.',
        retryable: false,
      }
    }

    // Snapshot credentials & strategy synchronously before any await (R20).
    const snapshot: TeamsCredentialsSnapshot = {
      appId: this.appId,
      appPassword: this.appPassword,
      tenantId: this.tenantId,
      token: this.token,
      fileDownloadAuthStrategy: this.fileDownloadAuthStrategy,
    }
    const maxBytes = options?.maxBytes ?? config.channelAttachmentMaxBytes ?? 20_971_520

    if (
      typeof descriptor.reportedSizeBytes === 'number' &&
      descriptor.reportedSizeBytes > maxBytes
    ) {
      return {
        ok: false,
        code: 'file_too_large',
        message: `Teams file exceeds the ${maxBytes} byte limit.`,
        retryable: false,
      }
    }

    const ref = descriptor.downloadRef
    if (ref.mode === 'file_download_info') {
      const prepared = await snapshot.fileDownloadAuthStrategy.prepareDownloadRequest({
        downloadUrl: ref.downloadUrl,
        uniqueId: ref.uniqueId,
        descriptor,
      })
      if (!prepared.ok) {
        return prepared
      }

      let currentUrl = prepared.url
      let currentHeaders: Record<string, string> = { ...prepared.headers }

      try {
        let response: Response | null = null
        for (let hop = 0; hop <= TEAMS_MAX_REDIRECTS; hop += 1) {
          response = await fetch(currentUrl.toString(), {
            method: 'GET',
            headers: currentHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(TEAMS_DOWNLOAD_TIMEOUT_MS),
          })
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location')
            if (!location) {
              return {
                ok: false,
                code: 'provider_download_failed',
                message: 'Teams file download redirected without a Location header.',
                retryable: false,
              }
            }
            let nextUrl: URL
            try {
              nextUrl = new URL(location, currentUrl)
            } catch {
              return {
                ok: false,
                code: 'provider_download_host_rejected',
                message: 'Teams file download redirected to an invalid URL.',
                retryable: false,
              }
            }
            if (!isAllowedTeamsFileUploadUrl(nextUrl.toString())) {
              return {
                ok: false,
                code: 'provider_download_host_rejected',
                message: 'Teams file download redirected to a disallowed host.',
                retryable: false,
              }
            }
            if (nextUrl.origin !== currentUrl.origin) {
              // Strip Authorization on any cross-origin redirect.
              const stripped: Record<string, string> = {}
              for (const [k, v] of Object.entries(currentHeaders)) {
                if (k.toLowerCase() !== 'authorization') stripped[k] = v
              }
              currentHeaders = stripped
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
            message: 'Teams file download exceeded maximum redirect hops.',
            retryable: false,
          }
        }
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            code: 'provider_download_auth_required',
            message: `Teams file download requires storage authorization (HTTP ${response.status}).`,
            retryable: false,
          }
        }
        if (response.status === 410) {
          return {
            ok: false,
            code: 'provider_download_expired',
            message: 'The temporary Teams file download link has expired. Please resend the file.',
            retryable: false,
          }
        }
        if (!response.ok) {
          return {
            ok: false,
            code: 'provider_download_failed',
            message: `Teams file download failed (HTTP ${response.status}).`,
            retryable: response.status >= 500,
          }
        }

        const bounded = await readBoundedResponseBytes(response, maxBytes)
        if (!bounded.ok) return bounded

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
          message: 'Network error while downloading Teams file.',
          retryable: true,
        }
      }
    }

    // Inline content (`image/*`): Bot Framework bearer token ONLY to exact
    // JWT-verified `serviceUrl` origin or pinned Microsoft hosts, with ZERO
    // token forwarding on cross-origin redirects (R14, R15, SF4).
    const rawContentUrl = ref.contentUrl?.trim()
    if (!rawContentUrl) {
      return {
        ok: false,
        code: 'provider_scope_unsupported',
        message: 'Teams inline attachment has no downloadable content URL.',
        retryable: false,
      }
    }
    if (!isAllowedTeamsInlineContentUrl(rawContentUrl, ref.serviceUrl)) {
      return {
        ok: false,
        code: 'provider_download_host_rejected',
        message: 'Teams inline attachment URL is not on an allowlisted Microsoft host.',
        retryable: false,
      }
    }

    let botToken: string
    try {
      botToken = await this.accessTokenWithSnapshot(snapshot)
    } catch {
      return {
        ok: false,
        code: 'provider_download_auth_required',
        message: 'Teams bot credentials are unavailable to download inline attachment.',
        retryable: true,
      }
    }

    let currentUrl = new URL(rawContentUrl)
    let sendAuth = true

    try {
      let response: Response | null = null
      for (let hop = 0; hop <= TEAMS_MAX_REDIRECTS; hop += 1) {
        response = await fetch(currentUrl.toString(), {
          method: 'GET',
          headers: sendAuth ? { authorization: `Bearer ${botToken}` } : {},
          redirect: 'manual',
          signal: AbortSignal.timeout(TEAMS_DOWNLOAD_TIMEOUT_MS),
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location')
          if (!location) {
            return {
              ok: false,
              code: 'provider_download_failed',
              message: 'Teams inline attachment redirected without a Location header.',
              retryable: false,
            }
          }
          let nextUrl: URL
          try {
            nextUrl = new URL(location, currentUrl)
          } catch {
            return {
              ok: false,
              code: 'provider_download_host_rejected',
              message: 'Teams inline attachment redirected to an invalid URL.',
              retryable: false,
            }
          }
          if (nextUrl.origin !== currentUrl.origin) {
            // Never forward Bot Framework bearer token across origins.
            sendAuth = false
            if (!isAllowedTeamsInlineContentUrl(nextUrl.toString(), ref.serviceUrl)) {
              return {
                ok: false,
                code: 'provider_download_host_rejected',
                message: 'Teams inline attachment redirected to a disallowed host.',
                retryable: false,
              }
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
          message: 'Teams inline attachment exceeded maximum redirect hops.',
          retryable: false,
        }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: 'provider_download_auth_required',
          message: `Teams denied inline attachment download (HTTP ${response.status}).`,
          retryable: false,
        }
      }
      if (response.status === 410) {
        return {
          ok: false,
          code: 'provider_download_expired',
          message: 'The Teams inline attachment link has expired. Please resend the file.',
          retryable: false,
        }
      }
      if (!response.ok) {
        return {
          ok: false,
          code: 'provider_download_failed',
          message: `Teams inline attachment download failed (HTTP ${response.status}).`,
          retryable: response.status >= 500,
        }
      }

      const bounded = await readBoundedResponseBytes(response, maxBytes)
      if (!bounded.ok) return bounded

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
        message: 'Network error while downloading Teams inline attachment.',
        retryable: true,
      }
    }
  }
}

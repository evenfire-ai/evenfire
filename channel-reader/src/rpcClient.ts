/**
 * HTTP client for sending messages to mcp-host.
 */
import { config } from './config'
import type {
  FetchDeliveriesResponse,
  NotificationDelivery,
  NotificationDeliveryMedium,
} from './notificationDeliveryClient'
import type { TraceContextV1 } from './traceContext'
import { Message, ProviderIdentity } from './types'
import type {
  Attachment,
  ChannelAttachmentIngestError,
  ChannelAttachmentIngestMetadataV1,
  ChannelAttachmentReceiptV1,
  ProviderTargetIdentity,
} from './types'

/**
 * Message payload sent to mcp-host.
 */
export interface OutgoingMessage {
  content: string
  channelType: 'telegram' | 'email' | 'slack' | 'teams'
  channelId: string
  sender: string
  timestamp: string
  messageId: string
  hostRef: string
  threadId?: string
  channelAttachmentIds?: string[]
  attachmentIngestErrors?: ChannelAttachmentIngestError[]
  metadata?: Record<string, unknown>
  providerIdentity?: ProviderIdentity
  traceContext?: TraceContextV1
}

/**
 * Structured error returned by mcp-host when an LLM call fails.
 * Mirrors the TaskError shape from mcp-host/src/queue/types.ts.
 */
export interface TaskError {
  code: string
  message: string
  retryable: boolean
  provider: string
}

/**
 * Response from mcp-host.
 */
export interface ShellCardDescriptor {
  channelCommandOffered: boolean
  desktopCommandOffered: boolean
}

export type ShellAction = 'once' | 'command' | 'shell'

export interface MessageResponse {
  success: boolean
  /** "completed" for normal responses, "waiting_approval" when a tool needs user approval, "pending" when polling for a result, "failed"/"cancelled" for terminal failures. */
  status?: 'completed' | 'waiting_approval' | 'pending' | 'failed' | 'cancelled'
  response?: string
  attachments?: Attachment[]
  error?: TaskError
  model?: string
  taskId?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** Present when status is "waiting_approval". */
  approval?: {
    taskId: string
    requestId: string
    userId: string
    notification: string
    /**
     * Present and false when this card cannot store a lasting grant. Absent
     * means the card may. The Host is the authority; channel buttons follow it.
     */
    alwaysApproveAllowed?: false
    /** Present on an auto shell card. Absent means today's approve / always / deny buttons. */
    shellCard?: ShellCardDescriptor
  }
}

export interface WorkflowApprovalDecisionPayload {
  approvalRequestId: string
  decision: 'approve' | 'deny'
  providerIdentity: ProviderIdentity
  note?: string | null
}

export interface WorkflowApprovalDecisionResponse {
  success: boolean
  duplicate?: boolean
  status?: string
  run?: Record<string, unknown> | null
  error?: string
}

export interface WorkflowApprovalResolvePayload {
  recipeName: string
  providerIdentity: ProviderIdentity
}

export interface WorkflowApprovalResolveResponse {
  approvalRequestId?: string
  error?: string
}

export interface WorkflowResultRequestPayload {
  workflowName?: string
  workflowRunId?: string
  artifactName?: string
  providerIdentity: ProviderIdentity
  source: {
    channelType: 'telegram' | 'slack' | 'teams'
    channelId: string
    sender: string
    messageId: string
    timestamp: string
    threadId?: string
  }
}

export type TelegramConfirmResponse =
  | {
      ok: true
      accountId: string
      userEmail?: string
    }
  | {
      ok?: false
      error?: string
    }

export type SlackLinkSessionConfirmResponse =
  | {
      ok: true
      account?: unknown
    }
  | {
      ok?: false
      error?: string
    }

export type TeamsLinkSessionConfirmResponse =
  | {
      ok: true
      account?: unknown
      replyInThreads?: boolean | null
    }
  | {
      ok?: false
      error?: string
    }

export interface ChannelReaderRuntimeSource {
  channelType: 'telegram' | 'email' | 'slack' | 'teams'
  channelId: string
  sender: string
}

export interface RPCClientOptions {
  sleep?: (ms: number) => Promise<void>
  drainRetryMaxMs?: number
  drainRetryBaseDelayMs?: number
  drainRetryMaxDelayMs?: number
}

const DEFAULT_DRAIN_RETRY_MAX_MS = 30_000
const DEFAULT_DRAIN_RETRY_BASE_DELAY_MS = 500
const DEFAULT_DRAIN_RETRY_MAX_DELAY_MS = 5_000
const MAX_ATTACHMENT_META_HEADER_BYTES = 16 * 1024

export class TaskResultHttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'TaskResultHttpError'
    this.status = status
    if (code !== undefined) {
      this.code = code
    }
  }
}

function isHostDrainingResponseBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  if (record.code === 'host_draining' || record.error === 'host_draining') return true
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (nested.code === 'host_draining') return true
  }
  return false
}

function isStructuredErrorMessageResponse(body: unknown): body is MessageResponse {
  if (!body || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  if (record.success !== false) return false
  if (!record.error || typeof record.error !== 'object') return false
  const errObj = record.error as Record<string, unknown>
  return typeof errObj.code === 'string' && errObj.code.trim().length > 0
}

/**
 * RPC Client for communicating with mcp-host.
 */
export class RPCClient {
  private readonly baseUrl: string
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly drainRetryMaxMs: number
  private readonly drainRetryBaseDelayMs: number
  private readonly drainRetryMaxDelayMs: number

  constructor(baseUrl: string, options: RPCClientOptions = {}) {
    this.baseUrl = baseUrl
    this.sleepImpl = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.drainRetryMaxMs = options.drainRetryMaxMs ?? DEFAULT_DRAIN_RETRY_MAX_MS
    this.drainRetryBaseDelayMs = options.drainRetryBaseDelayMs ?? DEFAULT_DRAIN_RETRY_BASE_DELAY_MS
    this.drainRetryMaxDelayMs = options.drainRetryMaxDelayMs ?? DEFAULT_DRAIN_RETRY_MAX_DELAY_MS
    console.log(`[RPC] Client initialized with URL: ${this.baseUrl}`)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private runtimeHeaders(
    source?: ChannelReaderRuntimeSource,
    contentType: string = 'application/json'
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': config.hostRef,
    }
    if (source) {
      headers['x-clerum-edge-channel-type'] = source.channelType
      headers['x-clerum-edge-channel-id'] = source.channelId
      headers['x-clerum-edge-sender'] = source.sender
    }
    return headers
  }

  /**
   * Stream raw attachment bytes to mcp-host's PVC-backed intake endpoint.
   * Retries HTTP 503 `host_draining` with bounded exponential backoff up to 30 s.
   * Fails closed on HTTP 404 (older mcp-host during rolling upgrade).
   */
  async ingestChannelAttachment(
    metadata: ChannelAttachmentIngestMetadataV1,
    body: Buffer | Uint8Array | ReadableStream<Uint8Array>
  ): Promise<ChannelAttachmentReceiptV1> {
    const encodedMeta = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
    if (Buffer.byteLength(encodedMeta, 'utf8') > MAX_ATTACHMENT_META_HEADER_BYTES) {
      return {
        ok: false,
        error: {
          code: 'attachment_metadata_too_large',
          message: 'Attachment metadata header exceeded the 16 KiB limit.',
          retryable: false,
        },
      }
    }

    const headers: Record<string, string> = {
      ...this.runtimeHeaders(
        {
          channelType: metadata.channelType,
          channelId: metadata.channelId,
          sender: metadata.sender,
        },
        'application/octet-stream'
      ),
      'x-clerum-attachment-meta': encodedMeta,
    }

    const isRetryableBody = body instanceof Uint8Array || Buffer.isBuffer(body)
    const startedAt = Date.now()
    let attempt = 0

    for (;;) {
      attempt += 1
      try {
        const requestInit: RequestInit & { duplex?: 'half' } = {
          method: 'POST',
          headers,
          body: body as RequestInit['body'],
          ...(isRetryableBody ? {} : { duplex: 'half' as const }),
        }
        const response = await fetch(
          `${this.baseUrl}/v1/runtime/channel-attachments/ingest`,
          requestInit
        )
        const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null

        if (response.status === 404) {
          return {
            ok: false,
            error: {
              code: 'host_attachment_ingest_unsupported',
              message:
                'Attachment upload is temporarily unavailable while the host is upgrading. Please try again shortly.',
              retryable: false,
            },
          }
        }

        if (response.status === 503 && isHostDrainingResponseBody(parsed)) {
          const elapsed = Date.now() - startedAt
          const delayMs = Math.min(
            this.drainRetryBaseDelayMs * Math.pow(2, attempt - 1),
            this.drainRetryMaxDelayMs
          )
          if (isRetryableBody && elapsed + delayMs <= this.drainRetryMaxMs) {
            console.warn(
              `[RPC] Attachment ingest hit 503 host_draining (attempt ${attempt}); retrying in ${delayMs}ms`
            )
            await this.sleepImpl(delayMs)
            continue
          }
          return {
            ok: false,
            error: {
              code: 'host_draining',
              message: 'The assistant host is restarting. Please resend your attachment shortly.',
              retryable: true,
            },
          }
        }

        if (
          response.ok &&
          parsed &&
          parsed.ok === true &&
          typeof parsed.attachmentId === 'string' &&
          parsed.attachmentId.trim()
        ) {
          return parsed as unknown as ChannelAttachmentReceiptV1
        }

        if (parsed && parsed.ok === false && parsed.error && typeof parsed.error === 'object') {
          const errObj = parsed.error as Record<string, unknown>
          return {
            ok: false,
            error: {
              code:
                typeof errObj.code === 'string' ? errObj.code : `ingest_http_${response.status}`,
              message:
                typeof errObj.message === 'string'
                  ? errObj.message
                  : `Attachment ingest failed (HTTP ${response.status})`,
              retryable:
                typeof errObj.retryable === 'boolean' ? errObj.retryable : response.status >= 500,
            },
          }
        }

        return {
          ok: false,
          error: {
            code:
              typeof parsed?.code === 'string'
                ? parsed.code
                : typeof parsed?.error === 'string'
                  ? parsed.error
                  : `ingest_http_${response.status}`,
            message:
              typeof parsed?.message === 'string'
                ? parsed.message
                : `Attachment ingest failed (HTTP ${response.status}: ${response.statusText})`,
            retryable: response.status >= 500,
          },
        }
      } catch (error) {
        console.error('[RPC] Attachment ingest network error:', error)
        return {
          ok: false,
          error: {
            code: 'ingest_network_error',
            message: error instanceof Error ? error.message : 'Unknown error',
            retryable: true,
          },
        }
      }
    }
  }

  /**
   * Send a message to mcp-host for processing.
   * Retries HTTP 503 `host_draining` with bounded exponential backoff up to 30 s.
   */
  async sendMessage(
    message: Message,
    options?: { async?: boolean; traceContext?: TraceContextV1 }
  ): Promise<MessageResponse> {
    const payload: OutgoingMessage = {
      content: message.content,
      channelType: message.channelType,
      channelId: message.channelId,
      sender: message.sender,
      timestamp: message.timestamp.toISOString(),
      messageId: message.messageId,
      hostRef: config.hostRef,
      threadId: message.threadId,
      ...(message.channelAttachmentIds && message.channelAttachmentIds.length > 0
        ? { channelAttachmentIds: message.channelAttachmentIds }
        : {}),
      ...(message.attachmentIngestErrors && message.attachmentIngestErrors.length > 0
        ? { attachmentIngestErrors: message.attachmentIngestErrors }
        : {}),
      metadata: message.rawData,
      ...(message.providerIdentity ? { providerIdentity: message.providerIdentity } : {}),
      ...(options?.traceContext ? { traceContext: options.traceContext } : {}),
    }

    console.log(`[RPC] Sending message to mcp-host: ${message.messageId}`)

    const query = options?.async ? '?async=true' : ''
    const startedAt = Date.now()
    let attempt = 0

    for (;;) {
      attempt += 1
      try {
        const response = await fetch(`${this.baseUrl}/v1/runtime/messages${query}`, {
          method: 'POST',
          headers: this.runtimeHeaders(message),
          body: JSON.stringify(payload),
        })

        if (response.status === 503) {
          const parsed503 = (await response.json().catch(() => null)) as unknown
          if (isHostDrainingResponseBody(parsed503)) {
            const elapsed = Date.now() - startedAt
            const delayMs = Math.min(
              this.drainRetryBaseDelayMs * Math.pow(2, attempt - 1),
              this.drainRetryMaxDelayMs
            )
            if (elapsed + delayMs <= this.drainRetryMaxMs) {
              console.warn(
                `[RPC] sendMessage hit 503 host_draining (attempt ${attempt}); retrying in ${delayMs}ms`
              )
              await this.sleepImpl(delayMs)
              continue
            }
            return {
              success: false,
              error: {
                code: 'host_draining',
                message: 'The assistant host is restarting. Please try again in a moment.',
                retryable: true,
                provider: 'mcp-host',
              },
            }
          }
          if (isStructuredErrorMessageResponse(parsed503)) {
            return parsed503
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const result = (await response.json()) as MessageResponse

        if (result.success) {
          if (result.status === 'waiting_approval') {
            console.log(`[RPC] Tool approval needed (request: ${result.approval?.requestId})`)
          } else {
            console.log(`[RPC] Message processed successfully by ${result.model}`)
          }
        } else {
          console.error(
            `[RPC] Message processing failed: ${result.error?.message ?? 'unknown error'}`
          )
        }

        return result
      } catch (error) {
        console.error(`[RPC] Failed to send message:`, error)
        return {
          success: false,
          error: {
            code: 'LLM_API_CALL_FAILED',
            message: error instanceof Error ? error.message : 'Unknown error',
            retryable: true,
            provider: 'unknown',
          },
        }
      }
    }
  }

  async authorizeProviderMessage(
    identity: ProviderIdentity
  ): Promise<{ authorized: boolean; reason?: 'unresolved' | 'error' }> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/provider-messages/authorize`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders({
          channelType: identity.medium,
          channelId: identity.providerChannelId,
          sender: identity.providerUserId,
        }),
        body: JSON.stringify({ providerIdentity: identity }),
      })
      if (!response.ok) return { authorized: false, reason: 'error' }
      const body = (await response.json()) as { authorized?: unknown; reason?: unknown } | null
      if (!body || typeof body !== 'object') return { authorized: false, reason: 'error' }
      if (body.authorized === true) return { authorized: true }
      return body.reason === 'unresolved'
        ? { authorized: false, reason: 'unresolved' }
        : { authorized: false, reason: 'error' }
    } catch (error) {
      console.warn(
        '[RPC] Provider message authorization failed closed:',
        error instanceof Error ? error.message : error
      )
      return { authorized: false, reason: 'error' }
    }
  }

  /**
   * Send an approval decision to mcp-host.
   */
  async sendApproval(
    userId: string,
    requestId: string,
    alwaysApprove: boolean,
    channelType: string,
    channelId: string,
    options?: { shellAction?: ShellAction }
  ): Promise<{
    success: boolean
    error?: string
    cancelled?: boolean
    retryable?: boolean
    status?: number
  }> {
    console.log(`[RPC] Sending approval for request ${requestId}`)
    const shellAction = options?.shellAction
    const forwardedShellAction =
      shellAction === 'once' || shellAction === 'command' || shellAction === 'shell'
        ? shellAction
        : undefined
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/approvals/approve`, {
        method: 'POST',
        headers: this.runtimeHeaders({
          channelType: channelType as ChannelReaderRuntimeSource['channelType'],
          channelId,
          sender: userId,
        }),
        body: JSON.stringify({
          userId,
          requestId,
          alwaysApprove,
          channelType,
          channelId,
          ...(forwardedShellAction ? { shellAction: forwardedShellAction } : {}),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean
        error?: string
        cancelled?: boolean
        retryable?: boolean
      }
      return {
        success: body.success === true && response.ok,
        ...(body.error !== undefined ? { error: body.error } : {}),
        ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
        ...(body.retryable !== undefined ? { retryable: body.retryable } : {}),
        ...(response.ok ? {} : { status: response.status }),
      }
    } catch (error) {
      console.error(`[RPC] Failed to send approval:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Send a denial decision to mcp-host.
   */
  async sendDenial(
    userId: string,
    requestId: string,
    channelType: string,
    channelId: string
  ): Promise<{
    success: boolean
    error?: string
    cancelled?: boolean
    retryable?: boolean
    status?: number
  }> {
    console.log(`[RPC] Sending denial for request ${requestId}`)
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/approvals/deny`, {
        method: 'POST',
        headers: this.runtimeHeaders({
          channelType: channelType as ChannelReaderRuntimeSource['channelType'],
          channelId,
          sender: userId,
        }),
        body: JSON.stringify({
          userId,
          requestId,
          channelType,
          channelId,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean
        error?: string
        cancelled?: boolean
        retryable?: boolean
      }
      return {
        success: body.success === true && response.ok,
        ...(body.error !== undefined ? { error: body.error } : {}),
        ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
        ...(body.retryable !== undefined ? { retryable: body.retryable } : {}),
        ...(response.ok ? {} : { status: response.status }),
      }
    } catch (error) {
      console.error(`[RPC] Failed to send denial:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Send a provider-originated workflow approval decision to mcp-host.
   */
  async sendWorkflowApprovalDecision(
    decision: WorkflowApprovalDecisionPayload
  ): Promise<WorkflowApprovalDecisionResponse> {
    console.log(`[RPC] Sending workflow approval decision for ${decision.approvalRequestId}`)
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: this.runtimeHeaders({
          channelType: decision.providerIdentity.medium,
          channelId: decision.providerIdentity.providerChannelId,
          sender: decision.providerIdentity.providerUserId,
        }),
        body: JSON.stringify(decision),
      })
      const body = (await response.json().catch(() => ({}))) as WorkflowApprovalDecisionResponse
      if (!response.ok) {
        return {
          success: false,
          error: body.error ?? `HTTP ${response.status}: ${response.statusText}`,
        }
      }
      return body
    } catch (error) {
      console.error(`[RPC] Failed to send workflow approval decision:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async resolveWorkflowApproval(
    payload: WorkflowApprovalResolvePayload
  ): Promise<{ approvalRequestId: string } | null> {
    console.log(`[RPC] Resolving workflow approval for ${payload.recipeName}`)
    const response = await fetch(`${this.baseUrl}/v1/runtime/workflow-approvals/resolve`, {
      method: 'POST',
      headers: this.runtimeHeaders({
        channelType: payload.providerIdentity.medium,
        channelId: payload.providerIdentity.providerChannelId,
        sender: payload.providerIdentity.providerUserId,
      }),
      body: JSON.stringify(payload),
    })
    const body = (await response.json().catch(() => ({}))) as WorkflowApprovalResolveResponse
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(body.error ?? `pending workflow approval resolve failed (${response.status})`)
    }
    return typeof body.approvalRequestId === 'string' && body.approvalRequestId.trim()
      ? { approvalRequestId: body.approvalRequestId }
      : null
  }

  async downloadWorkflowResult(message: Message, workflowName: string): Promise<MessageResponse> {
    return this.requestWorkflowResult(message, { workflowName })
  }

  async downloadWorkflowResultByRun(
    message: Message,
    workflowRunId: string,
    artifactName?: string
  ): Promise<MessageResponse> {
    return this.requestWorkflowResult(message, {
      workflowRunId,
      ...(artifactName?.trim() ? { artifactName: artifactName.trim() } : {}),
    })
  }

  private async requestWorkflowResult(
    message: Message,
    result: Pick<WorkflowResultRequestPayload, 'workflowName' | 'workflowRunId' | 'artifactName'>
  ): Promise<MessageResponse> {
    if (!message.providerIdentity || message.channelType === 'email') {
      return {
        success: false,
        error: {
          code: 'WORKFLOW_RESULT_UNAUTHORIZED',
          message: 'Provider identity is required to download workflow results',
          retryable: false,
          provider: 'unknown',
        },
      }
    }

    const payload: WorkflowResultRequestPayload = {
      ...result,
      providerIdentity: message.providerIdentity,
      source: {
        channelType: message.channelType,
        channelId: message.channelId,
        sender: message.sender,
        messageId: message.messageId,
        timestamp: message.timestamp.toISOString(),
        threadId: message.threadId,
      },
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/workflow-results/latest`, {
        method: 'POST',
        headers: this.runtimeHeaders(message),
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as MessageResponse & {
        error?: unknown
      }
      if (!response.ok) {
        return {
          success: false,
          error:
            body.error && typeof body.error === 'object'
              ? body.error
              : {
                  code: 'WORKFLOW_RESULT_UNAVAILABLE',
                  message:
                    typeof body.error === 'string'
                      ? body.error
                      : `Workflow result download failed (${response.status})`,
                  retryable: response.status >= 500,
                  provider: 'unknown',
                },
        }
      }
      return body
    } catch (error) {
      console.error('[RPC] Failed to download workflow result:', error)
      return {
        success: false,
        error: {
          code: 'WORKFLOW_RESULT_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: true,
          provider: 'unknown',
        },
      }
    }
  }

  async fetchDeliveries(params: {
    medium: NotificationDeliveryMedium
    providerChannelIds: string[]
    providerWorkspaceId?: string | null
    hostRef: string
    limit: number
  }): Promise<NotificationDelivery[]> {
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/workflow-approval-notifications/claim`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders(),
        body: JSON.stringify(params),
      }
    )
    const body = (await response.json().catch(() => ({}))) as FetchDeliveriesResponse & {
      error?: string
    }
    if (!response.ok) {
      throw new Error(body.error ?? `notification delivery fetch failed (${response.status})`)
    }
    return Array.isArray(body.deliveries) ? body.deliveries : []
  }

  async acknowledge(
    id: string,
    params: {
      medium: NotificationDeliveryMedium
      providerUserId: string
      providerChannelId: string
      providerWorkspaceId?: string | null
      hostRef: string
    }
  ): Promise<void> {
    await this.postNotificationDeliveryTerminal(id, 'ack', params)
  }

  async fail(
    id: string,
    params: {
      medium: NotificationDeliveryMedium
      providerUserId: string
      providerChannelId: string
      providerWorkspaceId?: string | null
      hostRef: string
    }
  ): Promise<void> {
    await this.postNotificationDeliveryTerminal(id, 'fail', params)
  }

  private async postNotificationDeliveryTerminal(
    id: string,
    action: 'ack' | 'fail',
    params: {
      medium: NotificationDeliveryMedium
      providerUserId: string
      providerChannelId: string
      providerWorkspaceId?: string | null
      hostRef: string
    }
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/workflow-approval-notifications/deliveries/${encodeURIComponent(id)}/${action}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders({
          channelType: params.medium,
          channelId: params.providerChannelId,
          sender: params.providerUserId,
        }),
        body: JSON.stringify(params),
      }
    )
    if (!response.ok && response.status !== 404) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `notification delivery ${action} failed (${response.status})`)
    }
  }

  async confirmTelegramChallenge(params: {
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
  }): Promise<{ ok: true; accountId: string; userEmail?: string } | { ok: false; error: string }> {
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders({
          channelType: 'telegram',
          channelId: params.providerChannelId,
          sender: params.providerUserId,
        }),
        body: JSON.stringify(params),
      }
    )
    const body = (await response.json().catch(() => ({}))) as TelegramConfirmResponse
    if (response.ok && body.ok && body.accountId) {
      return {
        ok: true,
        accountId: body.accountId,
        ...(body.userEmail ? { userEmail: body.userEmail } : {}),
      }
    }
    return {
      ok: false,
      error:
        body && typeof body === 'object' && 'error' in body && body.error
          ? String(body.error)
          : `telegram_verification_failed_${response.status}`,
    }
  }

  async confirmSlackLinkSession(params: {
    nonce: string
    providerUserId: string
    providerWorkspaceId: string
    providerChannelId: string
    providerChannelType?: string | null
    providerChannelTitle?: string | null
    providerTarget: ProviderTargetIdentity
  }): Promise<{ ok: true; account?: unknown } | { ok: false; error: string }> {
    const communicationChannelRef =
      params.providerTarget.communicationChannelNamespace &&
      params.providerTarget.communicationChannelName
        ? `${params.providerTarget.communicationChannelNamespace}/${params.providerTarget.communicationChannelName}`
        : ''
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/workflow-approval-mediums/link-sessions/confirm`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders({
          channelType: 'slack',
          channelId: params.providerChannelId,
          sender: params.providerUserId,
        }),
        body: JSON.stringify({
          nonce: params.nonce,
          medium: 'slack',
          providerUserId: params.providerUserId,
          providerWorkspaceId: params.providerWorkspaceId,
          providerChannelId: params.providerChannelId,
          providerChannelType: params.providerChannelType ?? null,
          providerChannelTitle: params.providerChannelTitle ?? null,
          communicationChannelRef,
        }),
      }
    )
    const body = (await response.json().catch(() => ({}))) as SlackLinkSessionConfirmResponse
    if (response.ok && body.ok) {
      return {
        ok: true,
        ...(body.account !== undefined ? { account: body.account } : {}),
      }
    }
    return {
      ok: false,
      error:
        body && typeof body === 'object' && 'error' in body && body.error
          ? String(body.error)
          : `slack_verification_failed_${response.status}`,
    }
  }

  async confirmTeamsLinkSession(params: {
    nonce: string
    providerUserId: string
    providerWorkspaceId: string
    providerChannelId: string
    providerChannelType?: string | null
    providerChannelTitle?: string | null
    providerTeamId?: string | null
    providerTeamsChannelId?: string | null
    serviceUrl?: string | null
    providerTarget: ProviderTargetIdentity
  }): Promise<
    { ok: true; account?: unknown; replyInThreads?: boolean | null } | { ok: false; error: string }
  > {
    const communicationChannelRef =
      params.providerTarget.communicationChannelNamespace &&
      params.providerTarget.communicationChannelName
        ? `${params.providerTarget.communicationChannelNamespace}/${params.providerTarget.communicationChannelName}`
        : ''
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/workflow-approval-mediums/link-sessions/confirm`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: this.runtimeHeaders({
          channelType: 'teams',
          channelId: params.providerChannelId,
          sender: params.providerUserId,
        }),
        body: JSON.stringify({
          nonce: params.nonce,
          medium: 'teams',
          providerUserId: params.providerUserId,
          providerWorkspaceId: params.providerWorkspaceId,
          providerChannelId: params.providerChannelId,
          providerChannelType: params.providerChannelType ?? null,
          providerChannelTitle: params.providerChannelTitle ?? null,
          providerTeamId: params.providerTeamId ?? null,
          providerTeamsChannelId: params.providerTeamsChannelId ?? null,
          serviceUrl: params.serviceUrl ?? null,
          communicationChannelRef,
        }),
      }
    )
    const body = (await response.json().catch(() => ({}))) as TeamsLinkSessionConfirmResponse
    if (response.ok && body.ok) {
      return {
        ok: true,
        ...(body.account !== undefined ? { account: body.account } : {}),
        ...(body.replyInThreads !== undefined ? { replyInThreads: body.replyInThreads } : {}),
      }
    }
    return {
      ok: false,
      error:
        body && typeof body === 'object' && 'error' in body && body.error
          ? String(body.error)
          : `teams_verification_failed_${response.status}`,
    }
  }

  /**
   * Get the result of a task (async message or approval flow).
   */
  async getTaskResult(
    taskId: string,
    source?: ChannelReaderRuntimeSource
  ): Promise<MessageResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/runtime/tasks/${encodeURIComponent(taskId)}/result`,
      {
        method: 'GET',
        headers: this.runtimeHeaders(source),
      }
    )
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      const code =
        typeof body?.code === 'string'
          ? body.code
          : typeof body?.error === 'string'
            ? body.error
            : body?.error &&
                typeof body.error === 'object' &&
                typeof (body.error as Record<string, unknown>).code === 'string'
              ? ((body.error as Record<string, unknown>).code as string)
              : undefined
      throw new TaskResultHttpError(
        response.status,
        `Failed to get task result: ${response.status}`,
        code
      )
    }
    return response.json() as Promise<MessageResponse>
  }

  /**
   * Get pending cron task results for delivery.
   */
  async getCronResults(): Promise<
    Array<{
      id: string
      origin: ChannelReaderRuntimeSource
      response: string
      attachments?: Attachment[]
      cronJobId: string
      cronJobName: string
      timestamp: string
      status?: 'completed'
    }>
  > {
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/cron/results`, {
        method: 'GET',
        headers: this.runtimeHeaders(),
      })
      if (!response.ok) return []
      const data = (await response.json()) as {
        results: Array<{
          id: string
          origin: ChannelReaderRuntimeSource
          response: string
          attachments?: Attachment[]
          cronJobId: string
          cronJobName: string
          timestamp: string
          status?: 'completed'
        }>
      }
      return data.results || []
    } catch {
      // Silent — cron results are best-effort
      return []
    }
  }

  /**
   * Acknowledge delivery of a cron result.
   */
  async acknowledgeCronResult(taskId: string, source: ChannelReaderRuntimeSource): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/runtime/cron/results/${taskId}`, {
      method: 'DELETE',
      headers: this.runtimeHeaders(source),
    })
    if (!response.ok) {
      throw new Error(`Failed to acknowledge cron result: ${response.status}`)
    }
  }

  /**
   * Check if mcp-host is healthy.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/health`, {
        method: 'GET',
      })
      return response.ok
    } catch {
      return false
    }
  }
}

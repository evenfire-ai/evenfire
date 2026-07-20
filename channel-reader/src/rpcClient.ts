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
import type { Attachment, ProviderTargetIdentity } from './types'

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
export interface MessageResponse {
  success: boolean
  /** "completed" for normal responses, "waiting_approval" when a tool needs user approval, "pending" when polling for a result. */
  status?: 'completed' | 'waiting_approval' | 'pending'
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

/**
 * RPC Client for communicating with mcp-host.
 */
export class RPCClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    console.log(`[RPC] Client initialized with URL: ${this.baseUrl}`)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private runtimeHeaders(source?: ChannelReaderRuntimeSource): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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
   * Send a message to mcp-host for processing.
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
      metadata: message.rawData,
      ...(message.providerIdentity ? { providerIdentity: message.providerIdentity } : {}),
      ...(options?.traceContext ? { traceContext: options.traceContext } : {}),
    }

    console.log(`[RPC] Sending message to mcp-host: ${message.messageId}`)

    try {
      const query = options?.async ? '?async=true' : ''
      const response = await fetch(`${this.baseUrl}/v1/runtime/messages${query}`, {
        method: 'POST',
        headers: this.runtimeHeaders(message),
        body: JSON.stringify(payload),
      })

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

  async authorizeProviderMessage(identity: ProviderIdentity): Promise<boolean> {
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
      if (!response.ok) return false
      const body = (await response.json()) as { authorized?: unknown }
      return body.authorized === true
    } catch (error) {
      console.warn(
        '[RPC] Provider message authorization failed closed:',
        error instanceof Error ? error.message : error
      )
      return false
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
    channelId: string
  ): Promise<{ success: boolean; error?: string }> {
    console.log(`[RPC] Sending approval for request ${requestId}`)
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
        }),
      })
      return (await response.json()) as { success: boolean; error?: string }
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
  ): Promise<{ success: boolean; error?: string }> {
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
      return (await response.json()) as { success: boolean; error?: string }
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
      throw new Error(`Failed to get task result: ${response.status}`)
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
    try {
      await fetch(`${this.baseUrl}/v1/runtime/cron/results/${taskId}`, {
        method: 'DELETE',
        headers: this.runtimeHeaders(source),
      })
    } catch (error) {
      console.error(`[RPC] Failed to acknowledge cron result ${taskId}:`, error)
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

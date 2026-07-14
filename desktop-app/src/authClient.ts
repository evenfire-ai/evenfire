import { config } from './config.js'
import { ApiError, requestJson } from './httpClient.js'
import {
  DesktopEnvironmentDiscovery,
  DesktopReleasePolicy,
  ExternalChannelAccount,
  ExternalChannelTarget,
  LoginResult,
  PendingWorkflowApproval,
  RpcScope,
  SdkNotificationSummary,
  SessionMe,
  TeamAgents,
  TeamContexts,
  TeamDirectoryResult,
  TeamMember,
  TeamSummary,
  UserAgents,
  UserContexts,
  UserNotificationPreferences,
  WorkflowApprovalDecisionResult,
  WorkflowNotificationStreamEvent,
  WorkflowRecipeListResult,
  WorkflowRunArtifactsResult,
  WorkflowRunCompletedNotification,
  WorkflowRunsResult,
} from './types.js'

function url(path: string): string {
  return `${config.externalRestApiBaseUrl.replace(/\/+$/, '')}${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parsePendingWorkflowApproval(value: unknown): PendingWorkflowApproval | null {
  if (!isRecord(value)) return null
  const payload = isRecord(value.payload) ? value.payload : null
  const target = isRecord(value.target) ? value.target : null
  if (
    typeof value.id !== 'string' ||
    typeof value.recipeNamespace !== 'string' ||
    typeof value.recipeName !== 'string' ||
    typeof value.requestedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !payload ||
    typeof payload.message !== 'string' ||
    !target
  ) {
    return null
  }

  const correlation = isRecord(value.correlation)
    ? {
        ...(typeof value.correlation.taskId === 'string'
          ? { taskId: value.correlation.taskId }
          : {}),
        ...(typeof value.correlation.stepId === 'string'
          ? { stepId: value.correlation.stepId }
          : {}),
      }
    : null

  return {
    id: value.id,
    recipeNamespace: value.recipeNamespace,
    recipeName: value.recipeName,
    requestedAt: value.requestedAt,
    expiresAt: value.expiresAt,
    payload: {
      message: payload.message,
      ...(Array.isArray(payload.options)
        ? { options: payload.options.map(option => String(option)) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'metadata')
        ? { metadata: payload.metadata }
        : {}),
    },
    correlation,
    target: {
      userId: typeof target.userId === 'string' ? target.userId : null,
      teamId: typeof target.teamId === 'string' ? target.teamId : null,
      teamName: typeof target.teamName === 'string' ? target.teamName : null,
    },
  }
}

function parseWorkflowRunCompletedNotification(
  value: unknown
): WorkflowRunCompletedNotification | null {
  if (!isRecord(value)) return null
  const target = isRecord(value.target) ? value.target : null
  if (
    typeof value.workflowRunId !== 'string' ||
    typeof value.approvalRequestId !== 'string' ||
    typeof value.recipeNamespace !== 'string' ||
    typeof value.recipeName !== 'string' ||
    !['Succeeded', 'Failed', 'Canceled'].includes(String(value.phase || '')) ||
    typeof value.completedAt !== 'string' ||
    !target
  ) {
    return null
  }

  return {
    workflowRunId: value.workflowRunId,
    approvalRequestId: value.approvalRequestId,
    recipeNamespace: value.recipeNamespace,
    recipeName: value.recipeName,
    phase: value.phase as WorkflowRunCompletedNotification['phase'],
    completedAt: value.completedAt,
    message: typeof value.message === 'string' ? value.message : null,
    target: {
      userId: typeof target.userId === 'string' ? target.userId : null,
      teamId: typeof target.teamId === 'string' ? target.teamId : null,
      teamName: typeof target.teamName === 'string' ? target.teamName : null,
    },
  }
}

function parseSdkNotificationSummary(value: unknown): SdkNotificationSummary | null {
  if (!isRecord(value)) return null
  const actionRef = isRecord(value.actionRef)
    ? {
        type: String(value.actionRef.type || ''),
        id: String(value.actionRef.id || ''),
        ...(typeof value.actionRef.urlRef === 'string' ? { urlRef: value.actionRef.urlRef } : {}),
      }
    : null
  if (
    typeof value.notificationId !== 'string' ||
    value.origin !== 'plugin_workload_sdk' ||
    typeof value.recipeNamespace !== 'string' ||
    typeof value.recipeName !== 'string' ||
    typeof value.callerRef !== 'string' ||
    typeof value.eventType !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string'
  ) {
    return null
  }
  const data =
    isRecord(value.data) && !Array.isArray(value.data)
      ? (value.data as Record<string, unknown>)
      : {}
  return {
    notificationId: value.notificationId,
    origin: 'plugin_workload_sdk',
    recipeNamespace: value.recipeNamespace,
    recipeName: value.recipeName,
    callerRef: value.callerRef,
    eventType: value.eventType,
    title: value.title,
    body: value.body,
    data,
    actionRef: actionRef && actionRef.type && actionRef.id ? actionRef : null,
    deliveryPolicyRef: typeof value.deliveryPolicyRef === 'string' ? value.deliveryPolicyRef : null,
  }
}

function parseWorkflowNotificationStreamEvent(
  value: unknown
): WorkflowNotificationStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'notification.snapshot') {
    if (!Array.isArray(value.items) || typeof value.observedAt !== 'string') return null
    const items = value.items.map(parsePendingWorkflowApproval)
    if (items.some(item => item === null)) return null
    return {
      type: 'notification.snapshot',
      items: items as PendingWorkflowApproval[],
      cursor: typeof value.cursor === 'string' ? value.cursor : null,
      observedAt: value.observedAt,
    }
  }
  if (value.type === 'approval.requested') {
    const approval = parsePendingWorkflowApproval(value.approval)
    if (
      !approval ||
      typeof value.id !== 'string' ||
      typeof value.cursor !== 'string' ||
      typeof value.observedAt !== 'string'
    ) {
      return null
    }
    return {
      type: 'approval.requested',
      id: value.id,
      cursor: value.cursor,
      approval,
      observedAt: value.observedAt,
    }
  }
  if (value.type === 'approval.updated') {
    const status = typeof value.status === 'string' ? value.status : ''
    if (
      typeof value.id !== 'string' ||
      typeof value.cursor !== 'string' ||
      typeof value.approvalRequestId !== 'string' ||
      typeof value.observedAt !== 'string' ||
      !['approved', 'denied', 'cancelled', 'expired', 'consumed'].includes(status)
    ) {
      return null
    }
    return {
      type: 'approval.updated',
      id: value.id,
      cursor: value.cursor,
      approvalRequestId: value.approvalRequestId,
      status: status as 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed',
      observedAt: value.observedAt,
    }
  }
  if (value.type === 'workflow.run.completed') {
    const workflowRun = parseWorkflowRunCompletedNotification(value.workflowRun)
    if (
      !workflowRun ||
      typeof value.id !== 'string' ||
      typeof value.cursor !== 'string' ||
      typeof value.observedAt !== 'string'
    ) {
      return null
    }
    return {
      type: 'workflow.run.completed',
      id: value.id,
      cursor: value.cursor,
      workflowRun,
      observedAt: value.observedAt,
    }
  }
  if (value.type === 'sdk.notification') {
    const notification = parseSdkNotificationSummary(value.notification)
    if (
      !notification ||
      typeof value.id !== 'string' ||
      typeof value.cursor !== 'string' ||
      typeof value.observedAt !== 'string'
    ) {
      return null
    }
    return {
      type: 'sdk.notification',
      id: value.id,
      cursor: value.cursor,
      notification,
      observedAt: value.observedAt,
    }
  }
  if (value.type === 'heartbeat' && typeof value.observedAt === 'string') {
    return { type: 'heartbeat', observedAt: value.observedAt }
  }
  if (
    value.type === 'stream.closing' &&
    typeof value.reason === 'string' &&
    typeof value.observedAt === 'string'
  ) {
    return { type: 'stream.closing', reason: value.reason, observedAt: value.observedAt }
  }
  return null
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    return error instanceof Error
      ? `Failed to read error body: ${error.message}`
      : 'Failed to read error body'
  }
}

export class AuthClient {
  async health(): Promise<{ status: string }> {
    return requestJson<{ status: string }>('GET', url('/health'))
  }

  async getDesktopEnvironment(): Promise<DesktopEnvironmentDiscovery> {
    return requestJson<DesktopEnvironmentDiscovery>('GET', url('/api/v1/desktop/environment'))
  }

  async getDesktopReleasePolicy(token: string): Promise<DesktopReleasePolicy> {
    return requestJson<DesktopReleasePolicy>('GET', url('/api/v1/desktop/release'), { token })
  }

  async googleLogin(idToken: string): Promise<LoginResult> {
    return requestJson<LoginResult>('POST', url('/api/v1/auth/google'), {
      body: { idToken },
    })
  }

  async passwordLogin(email: string, password: string): Promise<LoginResult> {
    return requestJson<LoginResult>('POST', url('/api/v1/auth/password-login'), {
      body: { email, password },
    })
  }

  async getMe(sessionToken: string): Promise<SessionMe> {
    return requestJson<SessionMe>('GET', url('/api/v1/me'), {
      token: sessionToken,
    })
  }

  async listTeams(sessionToken: string): Promise<{ currentTeamId: string; items: TeamSummary[] }> {
    return requestJson<{ currentTeamId: string; items: TeamSummary[] }>(
      'GET',
      url('/api/v1/me/teams'),
      {
        token: sessionToken,
      }
    )
  }

  async getInitialTeamDirectory(sessionToken: string): Promise<TeamDirectoryResult> {
    return requestJson<TeamDirectoryResult>('GET', url('/api/v1/me/teams/directory'), {
      token: sessionToken,
    })
  }

  async switchTeam(
    sessionToken: string,
    teamId: string
  ): Promise<{ token: string; team: TeamSummary }> {
    return requestJson<{ token: string; team: TeamSummary }>(
      'POST',
      url('/api/v1/me/switch-team'),
      {
        token: sessionToken,
        body: { teamId },
      }
    )
  }

  async getMyContexts(sessionToken: string): Promise<UserContexts> {
    return requestJson<UserContexts>('GET', url('/api/v1/me/contexts'), { token: sessionToken })
  }

  async getMyAgents(sessionToken: string): Promise<UserAgents> {
    return requestJson<UserAgents>('GET', url('/api/v1/me/agents'), { token: sessionToken })
  }

  async getTeamContexts(sessionToken: string): Promise<TeamContexts> {
    return requestJson<TeamContexts>('GET', url('/api/v1/team/contexts'), { token: sessionToken })
  }

  async getTeamAgents(sessionToken: string): Promise<TeamAgents> {
    return requestJson<TeamAgents>('GET', url('/api/v1/team/agents'), { token: sessionToken })
  }

  async getTeamMembers(sessionToken: string): Promise<{ items: TeamMember[] }> {
    return requestJson<{ items: TeamMember[] }>('GET', url('/api/v1/team/members'), {
      token: sessionToken,
    })
  }

  async listPendingWorkflowApprovals(
    sessionToken: string,
    limit = 20
  ): Promise<{ items: PendingWorkflowApproval[] }> {
    const query = new URLSearchParams({ limit: String(limit) })
    return requestJson<{ items: PendingWorkflowApproval[] }>(
      'GET',
      url(`/api/v1/workflow-approvals?${query.toString()}`),
      { token: sessionToken }
    )
  }

  async decideWorkflowApproval(
    sessionToken: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    note?: string
  ): Promise<WorkflowApprovalDecisionResult> {
    return requestJson<WorkflowApprovalDecisionResult>(
      'POST',
      url(`/api/v1/workflow-approvals/${encodeURIComponent(approvalId)}/decide`),
      {
        token: sessionToken,
        body: note ? { decision, note } : { decision },
      }
    )
  }

  async acknowledgeNotificationDelivery(
    sessionToken: string,
    notificationId: string
  ): Promise<{ ok: boolean; status: string }> {
    return requestJson<{ ok: boolean; status: string }>(
      'POST',
      url(`/api/v1/notifications/${encodeURIComponent(notificationId)}/ack`),
      { token: sessionToken }
    )
  }

  async getNotificationPreferences(sessionToken: string): Promise<UserNotificationPreferences> {
    return requestJson<UserNotificationPreferences>(
      'GET',
      url('/api/v1/me/notification-preferences'),
      { token: sessionToken }
    )
  }

  async listExternalChannelTargets(
    sessionToken: string
  ): Promise<{ items: ExternalChannelTarget[] }> {
    return requestJson<{ items: ExternalChannelTarget[] }>(
      'GET',
      url('/api/v1/workflow-approval-mediums/targets'),
      { token: sessionToken }
    )
  }

  async listExternalChannelAccounts(
    sessionToken: string
  ): Promise<{ items: ExternalChannelAccount[] }> {
    return requestJson<{ items: ExternalChannelAccount[] }>(
      'GET',
      url('/api/v1/workflow-approval-mediums'),
      { token: sessionToken }
    )
  }

  async updateNotificationPreferences(
    sessionToken: string,
    body: {
      preferredMedium: 'telegram' | 'slack' | null
      channelFallbackEnabled: boolean
    }
  ): Promise<UserNotificationPreferences> {
    return requestJson<UserNotificationPreferences>(
      'PUT',
      url('/api/v1/me/notification-preferences'),
      { token: sessionToken, body }
    )
  }

  async openWorkflowNotificationStream(
    sessionToken: string,
    onEvent: (event: WorkflowNotificationStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const response = await fetch(url('/api/v1/notifications/stream'), {
      method: 'GET',
      headers: {
        accept: 'application/x-ndjson',
        authorization: `Bearer ${sessionToken}`,
      },
      signal,
    })
    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new ApiError(
        `Notification stream failed (${response.status}): ${body || response.statusText}`,
        response.status,
        body
      )
    }
    if (!response.body) {
      throw new Error('Notification stream missing response body')
    }

    onEvent({ type: 'open' })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processChunk = (chunk: string) => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const rawLine = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!rawLine) continue
        try {
          const parsed = parseWorkflowNotificationStreamEvent(JSON.parse(rawLine) as unknown)
          if (parsed) {
            onEvent(parsed)
          } else {
            onEvent({ type: 'error', message: 'Invalid notification stream payload' })
          }
        } catch {
          onEvent({ type: 'error', message: 'Invalid notification stream JSON' })
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      processChunk(decoder.decode(value, { stream: true }))
    }
    const trailing = decoder.decode()
    if (trailing) processChunk(trailing)
  }

  async listWorkflows(sessionToken: string): Promise<WorkflowRecipeListResult> {
    return requestJson<WorkflowRecipeListResult>('GET', url('/api/v1/workflows'), {
      token: sessionToken,
      retryTransientOnce: true,
    })
  }

  async readWorkflow(sessionToken: string, ns: string, name: string): Promise<unknown> {
    return requestJson<unknown>(
      'GET',
      url(`/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`),
      { token: sessionToken, retryTransientOnce: true }
    )
  }

  async getWorkflowHealth(sessionToken: string, ns: string, name: string): Promise<unknown> {
    return requestJson<unknown>(
      'GET',
      url(`/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/health`),
      { token: sessionToken, retryTransientOnce: true }
    )
  }

  async triggerWorkflow(
    sessionToken: string,
    ns: string,
    name: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<unknown> {
    return requestJson<unknown>(
      'POST',
      url(`/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/trigger`),
      {
        token: sessionToken,
        body,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        retryTransientOnce: Boolean(idempotencyKey),
      }
    )
  }

  async listWorkflowRuns(
    sessionToken: string,
    ns: string,
    name: string,
    limit?: number
  ): Promise<WorkflowRunsResult> {
    const query = new URLSearchParams()
    if (limit) query.set('limit', String(limit))
    const qs = query.toString()
    return requestJson<WorkflowRunsResult>(
      'GET',
      url(
        `/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs${qs ? `?${qs}` : ''}`
      ),
      { token: sessionToken, retryTransientOnce: true }
    )
  }

  async listWorkflowRunArtifacts(
    sessionToken: string,
    ns: string,
    name: string,
    runId: string
  ): Promise<WorkflowRunArtifactsResult> {
    return requestJson<WorkflowRunArtifactsResult>(
      'GET',
      url(
        `/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts`
      ),
      { token: sessionToken, retryTransientOnce: true }
    )
  }

  async downloadWorkflowRunArtifact(
    sessionToken: string,
    ns: string,
    name: string,
    runId: string,
    artifactName: string
  ): Promise<Buffer> {
    const response = await fetch(
      url(
        `/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`
      ),
      {
        method: 'GET',
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      }
    )
    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new ApiError(
        `Download workflow artifact failed (${response.status}): ${body || response.statusText}`,
        response.status,
        body
      )
    }
    return Buffer.from(await response.arrayBuffer())
  }

  async issueRpcToken(
    sessionToken: string,
    scopes: RpcScope[],
    hostRefs?: string[]
  ): Promise<{
    token: string
    accessScope: 'team' | 'user'
    teamId: string | null
    scopes: RpcScope[]
    hostRefs: string[]
    expiresInSeconds: number
  }> {
    return requestJson('POST', url('/api/v1/rpc/token'), {
      token: sessionToken,
      body: {
        scopes,
        hostRefs: hostRefs && hostRefs.length ? hostRefs : undefined,
      },
    })
  }
}

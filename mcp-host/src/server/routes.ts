import type { Request, Response } from 'express'
import type { ApprovalDecision } from '../core/extensions/approvalTypes'
import { isTraceContextV1 } from '../core/types'
import { getRuntimeCallerContext } from './edgeRuntimeAuth'
import { badRequest, json } from './httpUtils'
import type {
  ActivitySnapshotHandler,
  ActivityStreamHandler,
  ApprovalHandler,
  CompactionHandler,
  ContextBreakdownHandler,
  CronResultAckHandler,
  CronResultsHandler,
  HostActivityEvent,
  IncomingMessage,
  MessageHandler,
  ModelsListHandler,
  ProgressStreamHandler,
  ProviderMessageAuthorizationHandler,
  ProviderWorkflowApprovalDecision,
  ProviderWorkflowApprovalDecisionHandler,
  ProviderWorkflowApprovalResolve,
  ProviderWorkflowApprovalResolveHandler,
  ProviderWorkflowResultRequest,
  ProviderWorkflowResultRequestHandler,
  SessionMessagesHandler,
  SessionSearchHandler,
  SessionsListHandler,
  SetModelHandler,
  StatusHandler,
  TaskResultHandler,
  TelegramWorkflowApprovalVerificationHandler,
  WorkflowApprovalMediumEnrollmentHandler,
  WorkflowApprovalNotificationClaimHandler,
  WorkflowApprovalNotificationTerminalHandler,
} from './types'
import type { RuntimeCallerContext } from './types'

export type RouteHandlers = {
  messageHandler: MessageHandler | null
  statusHandler: StatusHandler | null
  approvalHandler: ApprovalHandler | null
  providerWorkflowApprovalDecisionHandler: ProviderWorkflowApprovalDecisionHandler | null
  providerWorkflowApprovalResolveHandler: ProviderWorkflowApprovalResolveHandler | null
  providerWorkflowResultRequestHandler: ProviderWorkflowResultRequestHandler | null
  providerMessageAuthorizationHandler: ProviderMessageAuthorizationHandler | null
  workflowApprovalNotificationClaimHandler: WorkflowApprovalNotificationClaimHandler | null
  workflowApprovalNotificationTerminalHandler: WorkflowApprovalNotificationTerminalHandler | null
  workflowApprovalMediumEnrollmentHandler: WorkflowApprovalMediumEnrollmentHandler | null
  telegramWorkflowApprovalVerificationHandler: TelegramWorkflowApprovalVerificationHandler | null
  activitySnapshotHandler: ActivitySnapshotHandler | null
  activityStreamHandler: ActivityStreamHandler | null
  taskResultHandler: TaskResultHandler | null
  cronResultsHandler: CronResultsHandler | null
  cronResultAckHandler: CronResultAckHandler | null
  progressStreamHandler?: ProgressStreamHandler
  sessionsListHandler: SessionsListHandler | null
  sessionMessagesHandler: SessionMessagesHandler | null
  contextBreakdownHandler?: ContextBreakdownHandler | null
  sessionSearchHandler?: SessionSearchHandler | null
  compactionHandler?: CompactionHandler | null
  modelsListHandler?: ModelsListHandler | null
  setModelHandler?: SetModelHandler | null
}

function parseSessionsCursorParam(cursor: unknown): string | undefined | null {
  if (cursor === undefined) return undefined
  if (typeof cursor !== 'string' || cursor.length > 2048) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      updatedAt?: unknown
      key?: unknown
    }
    if (typeof parsed.updatedAt !== 'string' || typeof parsed.key !== 'string') return null
    if (!Number.isFinite(Date.parse(parsed.updatedAt))) return null
    return cursor
  } catch {
    return null
  }
}

function channelRuntimeSourceMismatch(
  caller: RuntimeCallerContext | undefined,
  source: { channelType?: string; channelId?: string; sender?: string }
): boolean {
  if (
    caller?.caller !== 'channel-reader' &&
    caller?.caller !== 'workflow-approval-request-reader'
  ) {
    return false
  }
  return (
    caller.channelType !== source.channelType ||
    caller.channelId !== source.channelId ||
    caller.sender !== source.sender
  )
}

export function runtimeApiInfo() {
  return {
    name: 'MCP Host',
    description: 'AI agent service with message queue and state machine',
    version: '1.0.0',
    endpoints: {
      'GET /v1/runtime': 'Runtime API information page',
      'GET /v1/runtime/health': 'Health check endpoint',
      'GET /v1/runtime/live': 'Liveness check endpoint',
      'GET /metrics': 'Prometheus metrics endpoint',
      'GET /v1/runtime/status': 'Get agent and queue status (includes pendingApprovals)',
      'GET /v1/runtime/activity': 'Get host activity timeline snapshot',
      'GET /v1/runtime/activity/stream': 'Read-only host activity stream (SSE)',
      'POST /v1/runtime/messages': 'Submit a message for processing',
      'POST /v1/runtime/provider-messages/authorize':
        'Authorize a provider message against current identity and channel access',
      'POST /v1/runtime/approvals/approve': 'Approve a pending tool execution',
      'POST /v1/runtime/approvals/deny': 'Deny a pending tool execution',
      'POST /v1/runtime/workflow-approvals/decide':
        'Submit a provider-originated workflow approval decision',
      'POST /v1/runtime/workflow-approvals/resolve':
        'Resolve a provider-originated pending workflow approval through the host',
      'POST /v1/runtime/workflow-results/latest':
        'Download the latest workflow result artifact for a verified provider conversation',
      'POST /v1/runtime/workflow-approval-notifications/claim':
        'Claim workflow approval notifications through the host',
      'POST /v1/runtime/workflow-approval-notifications/deliveries/:id/:action':
        'Ack or fail workflow approval notification delivery through the host',
      'POST /v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event':
        'Confirm a Telegram workflow approval verification challenge through the host',
      'GET /v1/runtime/tasks/:taskId/progress/stream': 'Task-scoped progress event stream (SSE)',
      'GET /v1/runtime/tasks/:id/result': 'Poll for task result after approval',
      'GET /v1/runtime/cron/results': 'Get pending cron task results for delivery',
      'DELETE /v1/runtime/cron/results/:id': 'Acknowledge cron result delivery',
      'GET /v1/runtime/sessions': 'List active sessions for the authenticated user',
      'GET /v1/runtime/sessions/:agent/:chatId/messages': 'Get message history for a session',
      'GET /v1/runtime/sessions/search':
        'Full-text search across past messages of the authenticated user',
      'GET /v1/runtime/models': 'List selectable models for the session (per-session selection)',
      'POST /v1/runtime/model': 'Set the per-session model (applies next task)',
      'POST /v1/runtime/compact':
        'Force compaction for a session with optional focus topic (operator-only)',
    },
    rpcCounterparts: {
      'GET /v1/runtime/status': 'onStatus(handler)',
      'GET /v1/runtime/activity': 'onActivitySnapshot(handler)',
      'GET /v1/runtime/activity/stream': 'onActivityStream(handler)',
      'POST /v1/runtime/messages': 'onMessage(handler)',
      'POST /v1/runtime/provider-messages/authorize': 'onProviderMessageAuthorization(handler)',
      'POST /v1/runtime/approvals/approve': 'onApproval(handler)',
      'POST /v1/runtime/approvals/deny': 'onApproval(handler)',
      'POST /v1/runtime/workflow-approvals/decide': 'onProviderWorkflowApprovalDecision(handler)',
      'POST /v1/runtime/workflow-approvals/resolve': 'onProviderWorkflowApprovalResolve(handler)',
      'POST /v1/runtime/workflow-results/latest': 'onProviderWorkflowResultRequest(handler)',
      'POST /v1/runtime/workflow-approval-notifications/claim':
        'onWorkflowApprovalNotificationClaim(handler)',
      'POST /v1/runtime/workflow-approval-notifications/deliveries/:id/:action':
        'onWorkflowApprovalNotificationTerminal(handler)',
      'POST /v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event':
        'onTelegramWorkflowApprovalVerification(handler)',
      'GET /v1/runtime/tasks/:taskId/progress/stream': 'onProgressStream(handler)',
      'GET /v1/runtime/tasks/:id/result': 'onTaskResult(handler)',
      'GET /v1/runtime/cron/results': 'onCronResults(handler)',
      'DELETE /v1/runtime/cron/results/:id': 'onCronResultAck(handler)',
      'GET /v1/runtime/sessions': 'onSessionsList(handler)',
      'GET /v1/runtime/sessions/:agent/:chatId/messages': 'onSessionMessages(handler)',
      'GET /v1/runtime/sessions/search': 'onSessionSearch(handler)',
      'GET /v1/runtime/models': 'onModelsList(handler)',
      'POST /v1/runtime/model': 'onSetModel(handler)',
      'POST /v1/runtime/compact': 'onCompaction(handler)',
    },
  }
}

/**
 * T1.1 — POST /v1/runtime/compact. Force compaction for a single session.
 * Wraps the injected handler and translates the discriminated `CompactionResult`
 * into HTTP status codes. Authz via `requireScope('host:compaction:invoke')`
 * is applied at the server layer.
 */
export async function handleCompactionRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.compactionHandler) {
      json(res, 501, { error: 'Compaction handler not configured' })
      return
    }
    const body = (req.body as Record<string, unknown>) || {}
    const queryFocus = typeof req.query.focus === 'string' ? req.query.focus : undefined
    const bodyFocus = typeof body.focus === 'string' ? body.focus : undefined
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
    const useMainLlm = typeof body.useMainLlm === 'boolean' ? body.useMainLlm : undefined

    if (!sessionKey) {
      badRequest(res, 'sessionKey required')
      return
    }

    const focus = (queryFocus || bodyFocus)?.trim() || undefined
    const result = await handlers.compactionHandler({ sessionKey, focus, useMainLlm })

    switch (result.kind) {
      case 'ok':
        json(res, 200, {
          ok: true,
          before: result.before,
          after: result.after,
          focus: result.focus,
        })
        return
      case 'not_found':
        json(res, 404, { error: 'session not found' })
        return
      case 'pending_approval':
        json(res, 409, { error: 'cannot compact while approval pending' })
        return
      case 'session_busy':
        json(res, 409, { error: 'session is currently busy — retry once idle' })
        return
      case 'error':
        json(res, 500, { error: result.message })
        return
      default: {
        const _exhaustive: never = result
        void _exhaustive
        json(res, 500, { error: 'unknown compaction result' })
      }
    }
  } catch (error) {
    console.error('[Server] Error during compaction:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

export async function handleStatusRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.statusHandler) {
      json(res, 200, { status: 'ok', message: 'Status handler not configured' })
      return
    }

    const status = await handlers.statusHandler()
    json(res, 200, status)
  } catch (error) {
    console.error('[Server] Error getting status:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

export async function handleMessageRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const message = req.body as IncomingMessage

    if (message?.traceContext != null && !isTraceContextV1(message.traceContext)) {
      badRequest(res, 'Invalid traceContext')
      return
    }

    // Identity invariant for the desktop / rpc channel: the sender MUST be the
    // trusted rpc-proxy edge user, regardless of what the body claims.
    // rpc-proxy already does this; re-enforcing here is defense-in-depth for
    // the direct rpc-proxy -> mcp-host hop after removing forwarded JWT.
    //
    if (message?.channelType === 'rpc') {
      const caller = getRuntimeCallerContext(req)
      if (caller?.caller === 'rpc-proxy' && caller.userId) {
        message.sender = caller.userId
        if (caller.teamId) {
          message.metadata = { ...(message.metadata ?? {}), teamId: caller.teamId }
        }
      } else {
        json(res, 401, { error: 'Missing rpc edge caller context' })
        return
      }
    } else {
      const caller = getRuntimeCallerContext(req)
      if (
        caller?.caller !== 'channel-reader' &&
        caller?.caller !== 'workflow-approval-request-reader'
      ) {
        json(res, 403, { error: 'Runtime edge source mismatch' })
        return
      }
      if (
        channelRuntimeSourceMismatch(caller, {
          channelType: message.channelType,
          channelId: message.channelId,
          sender: message.sender,
        })
      ) {
        json(res, 403, { error: 'Runtime edge source mismatch' })
        return
      }
    }

    console.log(`[Server] Received message from ${message.channelType}/${message.sender}`)

    if (!handlers.messageHandler) {
      json(res, 500, { success: false, error: 'No message handler configured' })
      return
    }

    const isAsync = req.query.async === 'true'
    // Await BOTH branches. `executeAsync()` returns its ack (`{ taskId, ... }`)
    // synchronously, so awaiting it is a no-op and the background task still
    // runs fire-and-forget. But the piggybacked-model path wraps the handler in
    // an async IIFE (it must persist `message.model` before enqueue), so the
    // async branch can return a Promise; without this await `json()` would
    // `JSON.stringify` a Promise to `{}` and drop `taskId`.
    const response = await handlers.messageHandler(message, isAsync ? { async: true } : undefined)
    json(res, 200, response)
  } catch (error) {
    console.error('[Server] Error processing message:', error)
    json(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

export async function handleActivityRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.activitySnapshotHandler) {
      json(res, 501, { hostRef: 'unknown', version: '1.0', items: [], nextCursor: null })
      return
    }
    const limitRaw = String(req.query.limit || '50')
    const limit = Number(limitRaw)
    if (!Number.isFinite(limit) || limit <= 0) {
      badRequest(res, 'limit must be a positive number')
      return
    }
    const sinceEventId =
      typeof req.query.sinceEventId === 'string' ? req.query.sinceEventId : undefined
    const snapshot = await handlers.activitySnapshotHandler(limit, sinceEventId)
    json(res, 200, snapshot)
  } catch (error) {
    console.error('[Server] Error getting activity snapshot:', error)
    json(res, 500, { error: 'Activity unavailable' })
  }
}

function writeSseEvent(res: Response, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export async function handleActivityStreamRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  if (!handlers.activityStreamHandler) {
    json(res, 501, { error: 'Activity stream unavailable' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  let unsubscribe: (() => void) | null = null
  const cleanup = (reason: string) => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    writeSseEvent(res, 'closed', { reason })
    res.end()
  }

  try {
    const registration = handlers.activityStreamHandler((event: HostActivityEvent) => {
      writeSseEvent(res, 'activity', event)
    })
    unsubscribe = registration.unsubscribe
    writeSseEvent(res, 'open', { hostRef: registration.hostRef, ts: new Date().toISOString() })

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n')
    }, 15000)

    req.on('close', () => {
      clearInterval(keepalive)
      if (unsubscribe) unsubscribe()
    })
  } catch {
    writeSseEvent(res, 'error', { message: 'Activity stream unavailable' })
    cleanup('upstream_unavailable')
  }
}

/**
 * IronClaw invariant #2 (P.3 §4.4): the resume after approve is fire-and-forget
 * inside `AgentStateMachine.handleApproval` (stateMachine.ts:346). If the
 * resume fails with `approval_expired` (spillover refs gone), this endpoint
 * still returns 200 OK with `{ success: true }`. The user-visible error
 * surfaces via the SSE `task:failed` event with `error.code = 'approval_expired'`
 * → ChannelDispatcher routes it back to Telegram/Slack/Email/Desktop.
 *
 * Returning 410 here would force callers to wait minutes for the resume
 * (re-execution of the remaining batch after the approved tool) before
 * acknowledging the click — not worth the latency.
 */
export async function handleApprovalRoute(
  req: Request,
  res: Response,
  approved: boolean,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.approvalHandler) {
      json(res, 501, { success: false, error: 'Approval handler not configured' })
      return
    }

    const parsed = req.body as Record<string, unknown>
    const caller = getRuntimeCallerContext(req)

    if (caller?.caller === 'rpc-proxy' && !caller.userId) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }

    const userId =
      caller?.caller === 'rpc-proxy' ? caller.userId : (parsed.userId as string | undefined)
    const requestId = parsed.requestId as string | undefined
    if (!userId || !requestId) {
      badRequest(res, 'Missing userId or requestId')
      return
    }

    let channelType = parsed.channelType as string | undefined
    let channelId = parsed.channelId as string | undefined
    if (caller?.caller === 'rpc-proxy') {
      channelType = 'rpc'
      channelId = caller.hostRef
    } else {
      if (
        channelRuntimeSourceMismatch(caller, {
          channelType,
          channelId,
          sender: userId,
        })
      ) {
        json(res, 403, { error: 'Runtime edge source mismatch' })
        return
      }
    }

    const decision: ApprovalDecision = {
      userId,
      requestId,
      approved,
      alwaysApprove: approved ? (parsed.alwaysApprove as boolean) || false : false,
      channelType,
      channelId,
    }

    console.log(
      `[Server] ${approved ? 'Approval' : 'Denial'} from ${userId} for request ${requestId}`
    )
    const result = await handlers.approvalHandler(decision)
    json(res, 200, result)
  } catch (error) {
    console.error(`[Server] Error handling ${approved ? 'approval' : 'denial'}:`, error)
    json(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isProviderIdentity(
  value: unknown
): value is ProviderWorkflowApprovalDecision['providerIdentity'] {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const hasRequiredIdentity =
    (record.medium === 'telegram' || record.medium === 'slack' || record.medium === 'teams') &&
    typeof record.providerUserId === 'string' &&
    record.providerUserId.trim().length > 0 &&
    typeof record.providerChannelId === 'string' &&
    record.providerChannelId.trim().length > 0 &&
    typeof record.providerEventId === 'string' &&
    record.providerEventId.trim().length > 0
  if (!hasRequiredIdentity) return false
  if (
    record.providerChannelType !== undefined &&
    record.providerChannelType !== null &&
    (typeof record.providerChannelType !== 'string' ||
      record.providerChannelType.trim().length === 0)
  ) {
    return false
  }
  if (record.medium === 'slack' || record.medium === 'teams') {
    return (
      typeof record.providerWorkspaceId === 'string' && record.providerWorkspaceId.trim().length > 0
    )
  }
  return true
}

function isProviderResolveIdentity(
  value: unknown
): value is ProviderWorkflowApprovalResolve['providerIdentity'] {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const hasRequiredIdentity =
    (record.medium === 'telegram' || record.medium === 'slack' || record.medium === 'teams') &&
    typeof record.providerUserId === 'string' &&
    record.providerUserId.trim().length > 0 &&
    typeof record.providerChannelId === 'string' &&
    record.providerChannelId.trim().length > 0
  if (!hasRequiredIdentity) return false
  if (record.medium === 'slack' || record.medium === 'teams') {
    return (
      typeof record.providerWorkspaceId === 'string' && record.providerWorkspaceId.trim().length > 0
    )
  }
  return true
}

export async function handleProviderMessageAuthorizationRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.providerMessageAuthorizationHandler) {
      json(res, 501, { authorized: false, error: 'Provider authorization is not configured' })
      return
    }
    const parsed = req.body as Record<string, unknown>
    if (!isProviderResolveIdentity(parsed.providerIdentity)) {
      badRequest(res, 'providerIdentity is required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: parsed.providerIdentity.medium,
        channelId: parsed.providerIdentity.providerChannelId,
        sender: parsed.providerIdentity.providerUserId,
      })
    ) {
      json(res, 403, { authorized: false, error: 'Runtime edge source mismatch' })
      return
    }
    const result = await handlers.providerMessageAuthorizationHandler({
      providerIdentity: parsed.providerIdentity,
    })
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error authorizing provider message:', error)
    json(res, 500, { authorized: false, error: 'Provider authorization unavailable' })
  }
}

export async function handleProviderWorkflowApprovalDecisionRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.providerWorkflowApprovalDecisionHandler) {
      json(res, 501, { success: false, error: 'Provider decision handler not configured' })
      return
    }

    const parsed = req.body as Record<string, unknown>
    const approvalRequestId =
      typeof parsed.approvalRequestId === 'string' ? parsed.approvalRequestId.trim() : ''
    if (!UUID_RE.test(approvalRequestId)) {
      badRequest(res, 'Invalid approvalRequestId format')
      return
    }
    if (parsed.decision !== 'approve' && parsed.decision !== 'deny') {
      badRequest(res, "decision must be 'approve' or 'deny'")
      return
    }
    if (!isProviderIdentity(parsed.providerIdentity)) {
      badRequest(res, 'providerIdentity is required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: parsed.providerIdentity.medium,
        channelId: parsed.providerIdentity.providerChannelId,
        sender: parsed.providerIdentity.providerUserId,
      })
    ) {
      json(res, 403, { error: 'Runtime edge source mismatch' })
      return
    }
    const note = parsed.note === undefined || parsed.note === null ? null : String(parsed.note)
    if (note && note.length > 1000) {
      badRequest(res, 'note exceeds maximum length of 1000 characters')
      return
    }

    const result = await handlers.providerWorkflowApprovalDecisionHandler({
      approvalRequestId,
      decision: parsed.decision,
      providerIdentity: parsed.providerIdentity,
      note,
    })
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error handling provider workflow approval decision:', error)
    json(res, 500, {
      success: false,
      error: 'Provider workflow approval decision unavailable',
    })
  }
}

export async function handleProviderWorkflowApprovalResolveRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.providerWorkflowApprovalResolveHandler) {
      json(res, 501, { error: 'Provider approval resolve handler not configured' })
      return
    }

    const parsed = req.body as Record<string, unknown>
    const recipeName = typeof parsed.recipeName === 'string' ? parsed.recipeName.trim() : ''
    if (!recipeName) {
      badRequest(res, 'recipeName is required')
      return
    }
    if (!isProviderResolveIdentity(parsed.providerIdentity)) {
      badRequest(res, 'providerIdentity is required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: parsed.providerIdentity.medium,
        channelId: parsed.providerIdentity.providerChannelId,
        sender: parsed.providerIdentity.providerUserId,
      })
    ) {
      json(res, 403, { error: 'Runtime edge source mismatch' })
      return
    }

    const result = await handlers.providerWorkflowApprovalResolveHandler({
      recipeName,
      providerIdentity: parsed.providerIdentity,
    })
    if (result.status === 'found') {
      json(res, 200, { approvalRequestId: result.approvalRequestId })
      return
    }
    if (result.status === 'not_found') {
      json(res, 404, { error: 'pending_workflow_approval_not_found' })
      return
    }
    if (result.status === 'ambiguous') {
      json(res, 409, { error: 'pending_workflow_approval_ambiguous' })
      return
    }
    json(res, 502, { error: result.error })
  } catch (error) {
    console.error('[Server] Error resolving provider workflow approval:', error)
    json(res, 500, {
      error: 'Provider workflow approval resolve unavailable',
    })
  }
}

function isWorkflowResultSource(value: unknown): value is ProviderWorkflowResultRequest['source'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    (source.channelType === 'telegram' ||
      source.channelType === 'slack' ||
      source.channelType === 'teams') &&
    typeof source.channelId === 'string' &&
    source.channelId.trim().length > 0 &&
    typeof source.sender === 'string' &&
    source.sender.trim().length > 0 &&
    typeof source.messageId === 'string' &&
    source.messageId.trim().length > 0 &&
    typeof source.timestamp === 'string' &&
    source.timestamp.trim().length > 0 &&
    (source.threadId === undefined || typeof source.threadId === 'string')
  )
}

export async function handleProviderWorkflowResultRequestRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.providerWorkflowResultRequestHandler) {
      json(res, 501, { success: false, error: 'Provider workflow result handler not configured' })
      return
    }

    const parsed = req.body as Record<string, unknown>
    const workflowName = typeof parsed.workflowName === 'string' ? parsed.workflowName.trim() : ''
    const workflowRunId =
      typeof parsed.workflowRunId === 'string' ? parsed.workflowRunId.trim() : ''
    const artifactName = typeof parsed.artifactName === 'string' ? parsed.artifactName.trim() : ''
    if (!workflowName && !workflowRunId) {
      badRequest(res, 'workflowName or workflowRunId is required')
      return
    }
    if (workflowName && workflowRunId) {
      badRequest(res, 'workflowName and workflowRunId are mutually exclusive')
      return
    }
    if (artifactName && !workflowRunId) {
      badRequest(res, 'artifactName requires workflowRunId')
      return
    }
    if (
      workflowRunId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowRunId)
    ) {
      badRequest(res, 'workflowRunId must be a UUID')
      return
    }
    if (!isProviderResolveIdentity(parsed.providerIdentity)) {
      badRequest(res, 'providerIdentity is required')
      return
    }
    if (!isWorkflowResultSource(parsed.source)) {
      badRequest(res, 'source is required')
      return
    }
    if (
      parsed.providerIdentity.medium !== parsed.source.channelType ||
      parsed.providerIdentity.providerChannelId !== parsed.source.channelId ||
      parsed.providerIdentity.providerUserId !== parsed.source.sender
    ) {
      json(res, 403, { success: false, error: 'Provider identity/source mismatch' })
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: parsed.source.channelType,
        channelId: parsed.source.channelId,
        sender: parsed.source.sender,
      })
    ) {
      json(res, 403, { success: false, error: 'Runtime edge source mismatch' })
      return
    }

    const result = await handlers.providerWorkflowResultRequestHandler(
      {
        ...(workflowName ? { workflowName } : {}),
        ...(workflowRunId ? { workflowRunId } : {}),
        ...(artifactName ? { artifactName } : {}),
        providerIdentity: parsed.providerIdentity,
        source: parsed.source,
      },
      getRuntimeCallerContext(req)
    )
    json(res, result.success ? 200 : 403, result)
  } catch (error) {
    console.error('[Server] Error handling provider workflow result request:', error)
    json(res, 500, {
      success: false,
      error: 'Provider workflow result request unavailable',
    })
  }
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : []
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

type TelegramRouteProviderTarget = {
  hostRef: string
  communicationChannelNamespace: string
  communicationChannelName: string
  providerBotId?: string
  providerBotUsername?: string
}

function normalizeTelegramRouteProviderTarget(value: unknown): TelegramRouteProviderTarget | null {
  const providerTarget = bodyRecord(value)
  const hostRef = nullableString(providerTarget.hostRef)
  const communicationChannelNamespace = nullableString(providerTarget.communicationChannelNamespace)
  const communicationChannelName = nullableString(providerTarget.communicationChannelName)
  if (!hostRef || !communicationChannelNamespace || !communicationChannelName) return null
  const providerBotId = nullableString(providerTarget.providerBotId)
  const providerBotUsername = nullableString(providerTarget.providerBotUsername)
  return {
    hostRef,
    communicationChannelNamespace,
    communicationChannelName,
    ...(providerBotId ? { providerBotId } : {}),
    ...(providerBotUsername ? { providerBotUsername } : {}),
  }
}

export async function handleWorkflowApprovalNotificationClaimRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.workflowApprovalNotificationClaimHandler) {
      json(res, 501, {
        deliveries: [],
        error: 'Workflow approval notification handler not configured',
      })
      return
    }
    const body = bodyRecord(req.body)
    const medium = nullableString(body.medium)
    if (medium !== 'telegram' && medium !== 'slack' && medium !== 'teams') {
      badRequest(res, 'medium is required')
      return
    }
    const providerChannelIds = stringArray(body.providerChannelIds)
    if (providerChannelIds.length === 0) {
      badRequest(res, 'providerChannelIds are required')
      return
    }
    const hostRef = nullableString(body.hostRef)
    if (!hostRef) {
      badRequest(res, 'hostRef is required')
      return
    }
    const limit = Number(body.limit ?? 10)
    const result = await handlers.workflowApprovalNotificationClaimHandler({
      medium,
      providerChannelIds,
      providerWorkspaceId: nullableString(body.providerWorkspaceId),
      hostRef,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10,
    })
    if ('error' in result) {
      json(res, 502, { deliveries: [], error: result.error })
      return
    }
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error claiming workflow approval notifications:', error)
    json(res, 500, { deliveries: [], error: 'Workflow approval notifications unavailable' })
  }
}

export async function handleWorkflowApprovalNotificationTerminalRoute(
  req: Request,
  res: Response,
  id: string,
  action: 'ack' | 'fail',
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.workflowApprovalNotificationTerminalHandler) {
      json(res, 501, { error: 'Workflow approval notification terminal handler not configured' })
      return
    }
    const body = bodyRecord(req.body)
    const medium = nullableString(body.medium)
    const providerUserId = nullableString(body.providerUserId)
    const providerChannelId = nullableString(body.providerChannelId)
    const hostRef = nullableString(body.hostRef)
    if (medium !== 'telegram' && medium !== 'slack' && medium !== 'teams') {
      badRequest(res, 'medium is required')
      return
    }
    if (!providerUserId || !providerChannelId || !hostRef) {
      badRequest(res, 'provider identity and hostRef are required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: medium,
        channelId: providerChannelId,
        sender: providerUserId,
      })
    ) {
      json(res, 403, { error: 'Runtime edge source mismatch' })
      return
    }
    const result = await handlers.workflowApprovalNotificationTerminalHandler(id, action, {
      medium,
      providerUserId,
      providerChannelId,
      providerWorkspaceId: nullableString(body.providerWorkspaceId),
      hostRef,
    })
    if (!result.ok) {
      json(res, 502, { error: result.error ?? 'notification delivery update failed' })
      return
    }
    res.status(204).end()
  } catch (error) {
    console.error('[Server] Error updating workflow approval notification:', error)
    json(res, 500, { error: 'Workflow approval notification update unavailable' })
  }
}

export async function handleWorkflowApprovalMediumEnrollmentRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.workflowApprovalMediumEnrollmentHandler) {
      json(res, 501, {
        ok: false,
        error: 'Workflow approval medium enrollment handler not configured',
      })
      return
    }
    const body = bodyRecord(req.body)
    const nonce = nullableString(body.nonce)
    const medium = nullableString(body.medium)
    const providerUserId = nullableString(body.providerUserId)
    const providerChannelId = nullableString(body.providerChannelId)
    const communicationChannelRef = nullableString(body.communicationChannelRef)
    if (!nonce || (medium !== 'telegram' && medium !== 'slack' && medium !== 'teams')) {
      badRequest(res, 'nonce and medium are required')
      return
    }
    if (!providerUserId || !providerChannelId) {
      badRequest(res, 'provider identity is required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: medium,
        channelId: providerChannelId,
        sender: providerUserId,
      })
    ) {
      json(res, 403, { error: 'Runtime edge source mismatch' })
      return
    }
    const result = await handlers.workflowApprovalMediumEnrollmentHandler({
      nonce,
      medium,
      providerUserId,
      providerWorkspaceId: nullableString(body.providerWorkspaceId),
      providerChannelId,
      providerChannelType: nullableString(body.providerChannelType),
      serviceUrl: nullableString(body.serviceUrl),
      communicationChannelRef,
    })
    json(res, result.ok ? 200 : 409, result)
  } catch (error) {
    console.error('[Server] Error confirming workflow approval medium enrollment:', error)
    json(res, 500, { ok: false, error: 'Workflow approval medium enrollment unavailable' })
  }
}

export async function handleTelegramWorkflowApprovalVerificationRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.telegramWorkflowApprovalVerificationHandler) {
      json(res, 501, { ok: false, error: 'Telegram verification handler not configured' })
      return
    }
    const body = bodyRecord(req.body)
    const code = nullableString(body.code)
    const providerUserId = nullableString(body.providerUserId)
    const providerChannelId = nullableString(body.providerChannelId)
    const providerChannelType = nullableString(body.providerChannelType)
    const primaryProviderTarget = normalizeTelegramRouteProviderTarget(body.providerTarget)
    const providerTargets = [
      primaryProviderTarget,
      ...(Array.isArray(body.providerTargets)
        ? body.providerTargets.map(candidate => normalizeTelegramRouteProviderTarget(candidate))
        : []),
    ].filter((target): target is TelegramRouteProviderTarget => target !== null)
    if (!code || !providerUserId || !providerChannelId || !providerChannelType) {
      badRequest(res, 'telegram provider verification fields are required')
      return
    }
    if (!primaryProviderTarget) {
      badRequest(res, 'providerTarget is required')
      return
    }
    if (
      channelRuntimeSourceMismatch(getRuntimeCallerContext(req), {
        channelType: 'telegram',
        channelId: providerChannelId,
        sender: providerUserId,
      })
    ) {
      json(res, 403, { error: 'Runtime edge source mismatch' })
      return
    }
    const result = await handlers.telegramWorkflowApprovalVerificationHandler({
      code,
      providerUserId,
      providerChannelId,
      providerChannelType,
      providerTarget: primaryProviderTarget,
      providerTargets,
    })
    json(res, result.ok ? 200 : 409, result)
  } catch (error) {
    console.error('[Server] Error confirming Telegram workflow approval verification:', error)
    json(res, 500, { ok: false, error: 'Telegram workflow approval verification unavailable' })
  }
}

export async function handleTaskResultRoute(
  req: Request,
  res: Response,
  taskId: string,
  handlers: RouteHandlers
): Promise<void> {
  try {
    if (!handlers.taskResultHandler) {
      json(res, 501, { success: false, error: 'Task result handler not configured' })
      return
    }

    const result = await handlers.taskResultHandler(taskId, getRuntimeCallerContext(req))
    if (result === null) {
      json(res, 404, { error: 'Task not found' })
      return
    }
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error getting task result:', error)
    json(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

export function handleCronResultsRoute(req: Request, res: Response, handlers: RouteHandlers): void {
  if (!handlers.cronResultsHandler) {
    json(res, 501, { results: [] })
    return
  }

  const results = handlers.cronResultsHandler(getRuntimeCallerContext(req))
  json(res, 200, { results })
}

export function handleCronResultAckRoute(
  req: Request,
  res: Response,
  taskId: string,
  handlers: RouteHandlers
): void {
  if (!handlers.cronResultAckHandler) {
    json(res, 501, { success: false, error: 'Handler not configured' })
    return
  }

  const deleted = handlers.cronResultAckHandler(taskId, getRuntimeCallerContext(req))
  json(res, 200, { success: deleted })
}

export async function handleSessionsListRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const caller = getRuntimeCallerContext(req)
    if (caller?.caller !== 'rpc-proxy' || !caller.userId) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }
    if (!handlers.sessionsListHandler) {
      json(res, 501, { error: 'Sessions handler not configured' })
      return
    }
    const cursor = parseSessionsCursorParam(req.query.cursor)
    if (cursor === null) {
      badRequest(res, 'Invalid sessions cursor')
      return
    }
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    if (
      req.query.limit !== undefined &&
      (!Number.isFinite(rawLimit) || Math.floor(rawLimit!) < 1)
    ) {
      badRequest(res, 'limit must be a positive integer')
      return
    }
    const limit =
      rawLimit === undefined ? (cursor ? 50 : undefined) : Math.min(Math.floor(rawLimit), 100)
    const result = await handlers.sessionsListHandler(caller.userId, { limit, cursor })
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error listing sessions:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

/**
 * T3.1 — GET /v1/runtime/sessions/search. Authenticated full-text search over
 * the JWT-derived user's history. `userSub` comes from the verified token;
 * caller-supplied `?user=` is silently ignored.
 *
 * Status codes:
 *   - 200: results returned (possibly empty).
 *   - 400: missing `q`.
 *   - 401: missing/invalid auth.
 *   - 501: search handler not wired (memory mode / feature OFF).
 *   - 500: backend error (SQL failure, e.g. malformed FTS5 expression).
 */
export async function handleSessionSearchRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const auth = (req as Request & { auth?: { sub: string } }).auth
    if (!auth?.sub) {
      json(res, 401, { error: 'Missing token' })
      return
    }
    if (!handlers.sessionSearchHandler) {
      json(res, 501, { error: 'Session search handler not configured' })
      return
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!q) {
      badRequest(res, 'q is required')
      return
    }

    const scope =
      req.query.scope === 'all_channels' ? ('all_channels' as const) : ('this_channel' as const)
    const since = typeof req.query.since === 'string' ? req.query.since : undefined
    const channelType = typeof req.query.channel === 'string' ? req.query.channel : undefined

    const limitRaw = Number(req.query.limit ?? 20)
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20, 1), 50)

    const result = await handlers.sessionSearchHandler({
      userSub: auth.sub,
      query: q,
      scope,
      channelType,
      since,
      limit,
    })
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error searching sessions:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

export async function handleSessionMessagesRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const caller = getRuntimeCallerContext(req)
    if (caller?.caller !== 'rpc-proxy' || !caller.userId) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }
    const agent = String(req.params.agent || '').trim()
    const chatId = String(req.params.chatId || '').trim()
    if (!agent || !chatId) {
      badRequest(res, 'agent and chatId are required')
      return
    }
    if (!handlers.sessionMessagesHandler) {
      json(res, 501, { error: 'Sessions handler not configured' })
      return
    }
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    const rawBeforeTurn =
      typeof req.query.beforeTurn === 'string' ? Number(req.query.beforeTurn) : undefined
    const rawAfterTurn =
      typeof req.query.afterTurn === 'string' ? Number(req.query.afterTurn) : undefined
    if (
      req.query.beforeTurn !== undefined &&
      (!Number.isFinite(rawBeforeTurn) || Math.floor(rawBeforeTurn!) < 1)
    ) {
      badRequest(res, 'beforeTurn must be a positive integer')
      return
    }
    if (
      req.query.afterTurn !== undefined &&
      (!Number.isFinite(rawAfterTurn) || Math.floor(rawAfterTurn!) < 0)
    ) {
      badRequest(res, 'afterTurn must be a non-negative integer')
      return
    }
    if (rawBeforeTurn !== undefined && rawAfterTurn !== undefined) {
      badRequest(res, 'beforeTurn and afterTurn are mutually exclusive')
      return
    }
    if (
      req.query.limit !== undefined &&
      (!Number.isFinite(rawLimit) || Math.floor(rawLimit!) < 1)
    ) {
      badRequest(res, 'limit must be a positive integer')
      return
    }
    const limit =
      rawLimit === undefined
        ? rawBeforeTurn !== undefined || rawAfterTurn !== undefined
          ? 80
          : undefined
        : Math.min(Math.floor(rawLimit), 200)
    const beforeTurn = rawBeforeTurn !== undefined ? Math.floor(rawBeforeTurn) : undefined
    const afterTurn = rawAfterTurn !== undefined ? Math.floor(rawAfterTurn) : undefined
    const result = await handlers.sessionMessagesHandler(caller.userId, agent, chatId, {
      limit,
      beforeTurn,
      afterTurn,
    })
    if (result === null) {
      // Same body regardless of "never existed" vs "belongs to someone else" — enumeration-defense.
      json(res, 404, { error: 'session not found' })
      return
    }
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error fetching session messages:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

export async function handleContextBreakdownRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    // AUTH INVARIANT (load-bearing): the userSub is derived from the verified
    // rpc-proxy edge caller, NEVER from a client param/query/body. The session
    // key is built server-side as `${userSub}:rpc:${agent}:${chatId}`, so a
    // caller cannot construct another user's key. See F1.5 of the plan.
    const caller = getRuntimeCallerContext(req)
    if (caller?.caller !== 'rpc-proxy' || !caller.userId) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }
    const agent = String(req.params.agent || '').trim()
    const chatId = String(req.params.chatId || '').trim()
    if (!agent || !chatId) {
      badRequest(res, 'agent and chatId are required')
      return
    }
    if (!handlers.contextBreakdownHandler) {
      json(res, 501, { error: 'Sessions handler not configured' })
      return
    }
    const result = await handlers.contextBreakdownHandler(caller.userId, agent, chatId)
    if (result === null) {
      // Same body regardless of "never existed" vs "belongs to someone else" — enumeration-defense.
      json(res, 404, { error: 'session not found' })
      return
    }
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error fetching context breakdown:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

/**
 * R2 — GET /v1/runtime/models. Read-only projection of the in-memory allowlist
 * for the Host's provider, plus the per-session selection when `?chatId=` is
 * passed. `runtimeEdgeGuard(['rpc-proxy'])` at the server layer guarantees a
 * verified edge user + hostRef; the session lookup is scoped server-side to
 * `${userId}:rpc:${hostRef}:${chatId}` (anti-enumeration, same as /messages).
 */
export async function handleModelsListRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const caller = getRuntimeCallerContext(req)
    if (caller?.caller !== 'rpc-proxy' || !caller.userId || !caller.hostRef) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }
    if (!handlers.modelsListHandler) {
      json(res, 501, { error: 'Models handler not configured' })
      return
    }
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : ''
    const result = await handlers.modelsListHandler(
      caller.userId,
      caller.hostRef,
      chatId || undefined
    )
    json(res, 200, result)
  } catch (error) {
    console.error('[Server] Error listing models:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

/**
 * R2 — POST /v1/runtime/model `{ chatId, model }`. `chatId` is MANDATORY (no
 * global model switch in v1). Validates `model ∈ allowlist` (403
 * `model_not_allowed`, degraded → only the Host default), persists the session
 * selection and responds `{ effective:'next-task', provider, model }`.
 */
export async function handleSetModelRoute(
  req: Request,
  res: Response,
  handlers: RouteHandlers
): Promise<void> {
  try {
    const caller = getRuntimeCallerContext(req)
    if (caller?.caller !== 'rpc-proxy' || !caller.userId || !caller.hostRef) {
      json(res, 401, { error: 'Missing rpc edge caller context' })
      return
    }
    if (!handlers.setModelHandler) {
      json(res, 501, { error: 'Set model handler not configured' })
      return
    }
    const body = (req.body as Record<string, unknown>) || {}
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!chatId) {
      badRequest(res, 'chatId is required')
      return
    }
    if (!model) {
      badRequest(res, 'model is required')
      return
    }
    const result = await handlers.setModelHandler(caller.userId, caller.hostRef, chatId, model)
    if (!result.ok) {
      json(res, 403, { error: result.reason, provider: result.provider, model: result.model })
      return
    }
    json(res, 200, { effective: 'next-task', provider: result.provider, model: result.model })
  } catch (error) {
    console.error('[Server] Error setting model:', error)
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
}

export async function handleProgressStreamRoute(
  req: Request,
  res: Response,
  taskId: string,
  handlers: RouteHandlers
): Promise<void> {
  if (!handlers.progressStreamHandler) {
    json(res, 501, { error: 'Progress stream unavailable' })
    return
  }

  // SSE headers FIRST (before subscription to avoid race)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Send a waiting event so the client knows the connection is alive while we
  // wait for the reporter to become available (the agent may not have dequeued
  // the task yet).
  writeSseEvent(res, 'waiting', { taskId, ts: new Date().toISOString() })

  // The handler may return a Promise (async wait for reporter) or synchronously
  const registrationOrPromise = handlers.progressStreamHandler(
    taskId,
    event => {
      writeSseEvent(res, event.type, event.data)
    },
    getRuntimeCallerContext(req)
  )
  const registration = await Promise.resolve(registrationOrPromise)

  if (!registration) {
    writeSseEvent(res, 'error', { message: 'task_not_found_or_expired' })
    res.end()
    return
  }

  writeSseEvent(res, 'open', { taskId, ts: new Date().toISOString() })

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n')
  }, 15_000)

  req.on('close', () => {
    clearInterval(keepalive)
    registration.unsubscribe()
  })
}

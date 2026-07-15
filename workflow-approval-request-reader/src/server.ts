import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import {
  type SlackTargetHandoffContext,
  type TeamsTargetHandoffContext,
  handoffSlackEnrollmentToChannelReader,
  handoffSlackMessageToChannelReader,
  handoffTeamsEnrollmentToChannelReader,
  handoffTeamsFileConsentToChannelReader,
  handoffTeamsMessageToChannelReader,
} from './channelReaderClient.js'
import { config } from './config.js'
import {
  type SlackTargetMessageResult,
  type TeamsTargetMessageResult,
  resolveTeamsTarget,
  sendSlackTargetMessage,
  updateSlackTargetMessage,
  updateTeamsTargetMessage,
  verifySlackTargetSignature,
} from './controlApiClient.js'
import {
  normalizeProviderDecision,
  normalizeProviderEnrollment,
  normalizeProviderMessage,
  normalizeProviderUrlVerification,
  normalizeTeamsFileConsent,
} from './decisionHandler.js'
import { readerLogger } from './logger.js'
import { submitMcpHostDecision, submitMcpHostEnrollment } from './mcpHostClient.js'
import { verifyTeamsAuthorization } from './teamsAuth.js'

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
const PROVIDER_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000
const log = readerLogger.child({ module: 'server' })
type RequestStage =
  | 'route'
  | 'body'
  | 'provider_auth'
  | 'parse'
  | 'normalize'
  | 'mcp_host'
  | 'background_message'
const rateLimitBuckets = new Map<string, { windowStartedAt: number; count: number }>()
// In-memory dedupe is a best-effort retry guard only. A rolling restart can
// allow a Slack retry through again; downstream approval handling must remain
// idempotent and authorization-backed.
const processedProviderEvents = new Map<string, number>()
const TEAMS_WORKFLOW_APPROVAL_ACTION_RE =
  /^(?:approve|deny|approved|denied|reject|rejected):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::sandbox-recipes\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?(?::[0-9a-f]{16})?$/i
const TEAMS_COMPACT_WORKFLOW_APPROVAL_ACTION_RE =
  /^(?:a|d):[A-Za-z0-9_-]{22}:(?:~[0-9a-f]{16}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9a-f]{16})?$/i

type SlackTargetContext = SlackTargetHandoffContext
type TeamsTargetContext = TeamsTargetHandoffContext & {
  appId: string
  appName?: string
}
type SlackDecisionFeedbackContext = {
  targetId: string
  channelId: string
  messageTs: string
  threadTs?: string | null
}
type TeamsDecisionFeedbackContext = {
  targetId: string
  conversationId: string
  messageId: string
  serviceUrl: string
}

type ProviderAuthResult =
  | { ok: true; slackTarget?: SlackTargetContext; teamsTarget?: TeamsTargetContext }
  | { ok: false; status: number; error: string }

class RequestBodyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicError: string
  ) {
    super(publicError)
    this.name = 'RequestBodyError'
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new RequestBodyError(413, 'payload_too_large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson(body: Buffer): unknown {
  const text = body.toString('utf8')
  return text ? JSON.parse(text) : {}
}

function parseProviderPayload(medium: string, req: http.IncomingMessage, body: Buffer): unknown {
  if (
    medium === 'slack' &&
    String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')
  ) {
    const payload = new URLSearchParams(body.toString('utf8')).get('payload')
    if (!payload) throw new RequestBodyError(400, 'invalid_decision_payload')
    return JSON.parse(payload)
  }
  return parseJson(body)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function peerKey(req: http.IncomingMessage): string {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return forwardedFor || req.socket.remoteAddress || 'unknown'
}

function rateLimitAllowed(
  cfg: typeof config,
  req: http.IncomingMessage,
  medium: string,
  targetId: string | null
): boolean {
  const now = Date.now()
  const key =
    (medium === 'slack' || medium === 'teams') && targetId
      ? `${medium}:${targetId}`
      : `${medium}:${peerKey(req)}`
  const bucket = rateLimitBuckets.get(key)
  if (!bucket || now - bucket.windowStartedAt >= cfg.rateLimitWindowMs) {
    rateLimitBuckets.set(key, { windowStartedAt: now, count: 1 })
    return true
  }
  bucket.count += 1
  return bucket.count <= cfg.rateLimitMaxRequests
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

function slackWorkspaceFromPayload(payload: unknown): string | null {
  const body = asRecord(payload)
  const event = asRecord(body.event)
  const team = asRecord(body.team)
  return asString(body.team_id) || asString(event.team) || asString(team.id) || null
}

function teamsChannelData(payload: unknown): Record<string, unknown> {
  return asRecord(asRecord(payload).channelData)
}

function teamsWorkspaceFromPayload(payload: unknown): string | null {
  const body = asRecord(payload)
  const conversation = asRecord(body.conversation)
  const channelData = teamsChannelData(payload)
  const tenant = asRecord(channelData.tenant)
  return asString(tenant.id) || asString(conversation.tenantId) || null
}

function teamsConversationType(payload: unknown): string | null {
  return asString(asRecord(asRecord(payload).conversation).conversationType) || null
}

function teamsActivityId(payload: unknown): string | null {
  return asString(asRecord(payload).id) || null
}

function teamsConversationMessageId(payload: unknown): string | null {
  const conversationId = asString(asRecord(asRecord(payload).conversation).id)
  const match = conversationId.match(/[;?&]messageid=([^;?&]+)/i)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function teamsReplyToMessageId(payload: unknown): string | null {
  const body = asRecord(payload)
  const channelData = teamsChannelData(payload)
  return (
    asString(body.replyToId) ||
    asString(channelData.replyToId) ||
    asString(channelData.messageId) ||
    teamsConversationMessageId(payload) ||
    teamsActivityId(payload)
  )
}

function teamsMessageHasMention(payload: unknown): boolean {
  const body = asRecord(payload)
  if (/<at>.*?<\/at>/i.test(asString(body.text))) return true
  const entities = Array.isArray(body.entities) ? body.entities : []
  return entities.some(entity => asString(asRecord(entity).type).toLowerCase() === 'mention')
}

function teamsActionValue(payload: unknown): string {
  const body = asRecord(payload)
  const value = asRecord(body.value)
  const direct = asString(value.action) || asString(value.value)
  if (direct) return direct
  const teams = asRecord(value.msteams)
  const nestedValue = asRecord(teams.value)
  return asString(nestedValue.action) || asString(teams.text) || asString(body.text)
}

function teamsIsWorkflowResultAction(payload: unknown): boolean {
  const value = teamsActionValue(payload)
  return (
    /^workflow_result_run:[0-9a-f-]{36}$/i.test(value) ||
    /^workflow_result:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)
  )
}

function teamsIsToolApprovalAction(payload: unknown): boolean {
  return /^tool:[ald]:[A-Za-z0-9_-]{16}$/.test(teamsActionValue(payload))
}

function teamsIsWorkflowApprovalAction(payload: unknown): boolean {
  const value = teamsActionValue(payload)
  return (
    TEAMS_WORKFLOW_APPROVAL_ACTION_RE.test(value) ||
    TEAMS_COMPACT_WORKFLOW_APPROVAL_ACTION_RE.test(value)
  )
}

function teamsCanUseMessage(target: TeamsTargetContext, payload: unknown): boolean {
  const type = asString(asRecord(payload).type)
  if (type === 'invoke') return true
  if (!target.replyOnlyWhenMentioned) return true
  return teamsConversationType(payload) === 'personal' || teamsMessageHasMention(payload)
}

function isSlackEventCallback(payload: unknown): boolean {
  return asString(asRecord(payload).type) === 'event_callback'
}

function isSlackBlockActions(payload: unknown): boolean {
  return asString(asRecord(payload).type) === 'block_actions'
}

function slackEventType(payload: unknown): string {
  return asString(asRecord(asRecord(payload).event).type)
}

function slackEventText(payload: unknown): string {
  return asString(asRecord(asRecord(payload).event).text)
}

function slackEventStartsWithMention(payload: unknown): boolean {
  return /^<@[A-Z0-9]+>(?:\s|$)/i.test(slackEventText(payload))
}

function slackEventIsInlineApprovalCommand(payload: unknown): boolean {
  const text = slackEventText(payload).trim().toLowerCase()
  if (
    text === '/approve' ||
    text === '/approve always' ||
    text === '/deny' ||
    text === '\\approve' ||
    text === '\\approve always' ||
    text === '\\deny'
  ) {
    return true
  }
  return /^[\\/](?:approve|deny)\s+[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(text)
}

function slackCanUseEvent(
  target: SlackTargetContext,
  payload: unknown,
  channelId?: string | null
): boolean {
  if (!channelId) return false
  const eventType = slackEventType(payload)
  if (!target.replyOnlyWhenMentioned) return eventType === 'message'
  if (channelId.startsWith('D')) return eventType === 'message' || eventType === 'app_mention'
  if (eventType === 'message' && slackEventIsInlineApprovalCommand(payload)) return true
  if (eventType === 'app_mention') return true
  return eventType === 'message' && slackEventStartsWithMention(payload)
}

function slackCanUseMessage(
  target: SlackTargetContext,
  payload: unknown,
  channelId?: string | null
): boolean {
  if (isSlackBlockActions(payload)) return !!channelId
  return slackCanUseEvent(target, payload, channelId)
}

function slackMessageShouldStripAcceptedMention(
  target: SlackTargetContext,
  payload: unknown,
  channelId?: string | null
): boolean {
  return (
    target.replyOnlyWhenMentioned &&
    !!channelId &&
    !channelId.startsWith('D') &&
    slackEventType(payload) === 'message' &&
    !slackEventIsInlineApprovalCommand(payload) &&
    slackEventStartsWithMention(payload)
  )
}

function slackCanUseEnrollmentEvent(
  target: SlackTargetContext,
  payload: unknown,
  channelId?: string | null
): boolean {
  if (slackCanUseEvent(target, payload, channelId)) return true
  const eventType = slackEventType(payload)
  return (
    eventType === 'app_mention' || (eventType === 'message' && slackEventStartsWithMention(payload))
  )
}

function markProviderEventSeen(providerEventId: string): boolean {
  const now = Date.now()
  for (const [key, expiresAt] of processedProviderEvents) {
    if (expiresAt <= now) processedProviderEvents.delete(key)
  }
  const expiresAt = processedProviderEvents.get(providerEventId)
  if (expiresAt && expiresAt > now) return false
  processedProviderEvents.set(providerEventId, now + PROVIDER_EVENT_DEDUPE_TTL_MS)
  return true
}

function slackDecisionActionLabel(
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>
): string {
  return command.decision === 'deny' ? 'Denied' : 'Approved'
}

function slackDecisionFailureText(
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>,
  result: { status?: number; error?: string }
): string {
  if (result.error === 'approval_not_pending' || result.error === 'approval_route_not_found') {
    return 'This workflow approval is no longer pending. Trigger the workflow again to request approval.'
  }
  if (result.status === 403 || result.error === 'not_authorized') {
    return 'You are not allowed to decide this workflow approval from this Slack conversation.'
  }
  const action = command.decision === 'deny' ? 'deny' : 'approve'
  return `I could not ${action} this workflow approval. Try again in a moment.`
}

async function logSlackDecisionFeedbackFailure(
  result: SlackTargetMessageResult,
  params: { approvalRequestId?: string; providerEventId: string; action: string }
): Promise<void> {
  if (result.ok) return
  log.warn('slack decision feedback failed', {
    approvalRequestId: params.approvalRequestId,
    providerEventId: params.providerEventId,
    action: params.action,
    status: result.status,
    error: result.error,
  })
}

function submitSlackDecisionInBackground(
  cfg: typeof config,
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>,
  feedback: SlackDecisionFeedbackContext | null
): void {
  void submitMcpHostDecision(cfg, command)
    .then(async result => {
      if (result.ok) {
        if (feedback) {
          const action = slackDecisionActionLabel(command)
          const updateResult = await updateSlackTargetMessage(cfg, {
            targetId: feedback.targetId,
            channelId: feedback.channelId,
            messageTs: feedback.messageTs,
            text: `${action}. Workflow approval recorded.`,
            blocks: [],
          })
          await logSlackDecisionFeedbackFailure(updateResult, {
            approvalRequestId: command.approvalRequestId,
            providerEventId: command.providerEventId,
            action: 'update_success',
          })
        }
        return
      }

      log.warn('provider decision submission failed after acknowledgement', {
        medium: command.medium,
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        status: result.status,
        error: result.error,
      })
      if (!feedback) return

      const text = slackDecisionFailureText(command, result)
      if (result.error === 'approval_not_pending' || result.error === 'approval_route_not_found') {
        const updateResult = await updateSlackTargetMessage(cfg, {
          targetId: feedback.targetId,
          channelId: feedback.channelId,
          messageTs: feedback.messageTs,
          text,
          blocks: [],
        })
        await logSlackDecisionFeedbackFailure(updateResult, {
          approvalRequestId: command.approvalRequestId,
          providerEventId: command.providerEventId,
          action: 'update_stale',
        })
        return
      }

      const sendResult = await sendSlackTargetMessage(cfg, {
        targetId: feedback.targetId,
        channelId: feedback.channelId,
        text: `<@${command.providerUserId}> ${text}`,
        threadTs: feedback.threadTs || feedback.messageTs,
      })
      await logSlackDecisionFeedbackFailure(sendResult, {
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        action: 'send_failure',
      })
    })
    .catch(err => {
      log.error('provider decision submission crashed after acknowledgement', {
        medium: command.medium,
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        error: err instanceof Error ? err.name : 'unknown_error',
      })
    })
}

function submitTeamsDecisionInBackground(
  cfg: typeof config,
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>,
  feedback: TeamsDecisionFeedbackContext | null
): void {
  void submitMcpHostDecision(cfg, command)
    .then(async result => {
      if (result.ok) {
        if (feedback) {
          const action = teamsDecisionActionLabel(command)
          const updateResult = await updateTeamsTargetMessage(cfg, {
            targetId: feedback.targetId,
            conversationId: feedback.conversationId,
            messageId: feedback.messageId,
            serviceUrl: feedback.serviceUrl,
            text: `${action}. Workflow approval recorded.`,
          })
          await logTeamsDecisionFeedbackFailure(updateResult, {
            approvalRequestId: command.approvalRequestId,
            providerEventId: command.providerEventId,
            action: 'update_success',
          })
        }
        return
      }

      log.warn('provider decision submission failed after acknowledgement', {
        medium: command.medium,
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        status: result.status,
        error: result.error,
      })
      if (!feedback) return

      const updateResult = await updateTeamsTargetMessage(cfg, {
        targetId: feedback.targetId,
        conversationId: feedback.conversationId,
        messageId: feedback.messageId,
        serviceUrl: feedback.serviceUrl,
        text: teamsDecisionFailureText(command, result),
      })
      await logTeamsDecisionFeedbackFailure(updateResult, {
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        action:
          result.error === 'approval_not_pending' || result.error === 'approval_route_not_found'
            ? 'update_stale'
            : 'update_failure',
      })
    })
    .catch(err => {
      log.error('provider decision submission crashed after acknowledgement', {
        medium: command.medium,
        approvalRequestId: command.approvalRequestId,
        providerEventId: command.providerEventId,
        error: err instanceof Error ? err.name : 'unknown_error',
      })
    })
}

async function providerAuthorized(
  cfg: typeof config,
  medium: string,
  targetId: string | null,
  req: http.IncomingMessage,
  rawBody: Buffer
): Promise<ProviderAuthResult> {
  if (medium === 'telegram') {
    if (!cfg.telegramWebhookSecret) {
      return { ok: false, status: 401, error: 'invalid_provider_signature' }
    }
    const ok = safeEqual(
      String(req.headers['x-telegram-bot-api-secret-token'] || ''),
      cfg.telegramWebhookSecret
    )
    return ok ? { ok: true } : { ok: false, status: 401, error: 'invalid_provider_signature' }
  }
  if (medium === 'slack') {
    const timestamp = String(req.headers['x-slack-request-timestamp'] || '')
    const signature = String(req.headers['x-slack-signature'] || '')
    if (!targetId) {
      return { ok: false, status: 400, error: 'slack_target_required' }
    }
    const result = await verifySlackTargetSignature(cfg, {
      targetId,
      timestamp,
      signature,
      rawBody,
    })
    if (!result.ok) {
      return {
        ok: false,
        status: result.status ?? 401,
        error: result.error || 'invalid_provider_signature',
      }
    }
    return {
      ok: true,
      slackTarget: {
        targetId,
        hostRef: result.hostRef,
        communicationChannelRef: result.communicationChannelRef,
        providerWorkspaceId: result.providerWorkspaceId,
        replyInThreads: result.replyInThreads === true,
        replyOnlyWhenMentioned: result.replyOnlyWhenMentioned === true,
      },
    }
  }
  if (medium === 'teams') {
    if (!targetId) {
      return { ok: false, status: 400, error: 'teams_target_required' }
    }
    const target = await resolveTeamsTarget(cfg, { targetId })
    if (!target.ok) {
      return {
        ok: false,
        status: target.status ?? 401,
        error: target.error || 'teams_target_resolve_failed',
      }
    }
    if (!target.appId) {
      return { ok: false, status: 409, error: 'teams_app_id_missing' }
    }
    const authHeader = String(req.headers.authorization || '')
    let serviceUrl: string | null = null
    try {
      serviceUrl = asString(asRecord(parseProviderPayload(medium, req, rawBody)).serviceUrl) || null
    } catch {
      serviceUrl = null
    }
    const verified = await verifyTeamsAuthorization({
      authorizationHeader: authHeader,
      appId: target.appId,
      serviceUrl,
      timeoutMs: cfg.controlApiTimeoutMs,
    })
    if (!verified.ok) {
      return { ok: false, status: 401, error: verified.error }
    }
    return {
      ok: true,
      teamsTarget: {
        targetId,
        hostRef: target.hostRef,
        communicationChannelRef: target.communicationChannelRef,
        providerWorkspaceId: target.providerWorkspaceId,
        replyOnlyWhenMentioned: target.replyOnlyWhenMentioned === true,
        appId: target.appId,
        appName: target.appName,
      },
    }
  }
  return { ok: false, status: 401, error: 'invalid_provider_signature' }
}

function slackEventMessageTs(payload: unknown): string | null {
  const body = asRecord(payload)
  const event = asRecord(body.event)
  const message = asRecord(body.message)
  const container = asRecord(body.container)
  return asString(event.ts) || asString(message.ts) || asString(container.message_ts) || null
}

function slackEventThreadTs(payload: unknown): string | null {
  const event = asRecord(asRecord(payload).event)
  const message = asRecord(asRecord(payload).message)
  return asString(event.thread_ts) || asString(message.thread_ts) || null
}

function slackDecisionFeedbackContext(
  targetId: string | null,
  payload: unknown,
  command: ReturnType<typeof normalizeProviderDecision>
): SlackDecisionFeedbackContext | null {
  const messageTs = slackEventMessageTs(payload)
  if (!targetId || !command?.providerChannelId || !messageTs) return null
  return {
    targetId,
    channelId: command.providerChannelId,
    messageTs,
    threadTs: slackEventThreadTs(payload),
  }
}

function teamsDecisionActionLabel(
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>
): string {
  return command.decision === 'deny' ? 'Denied' : 'Approved'
}

function teamsDecisionFailureText(
  command: NonNullable<ReturnType<typeof normalizeProviderDecision>>,
  result: { status?: number; error?: string }
): string {
  if (result.error === 'approval_not_pending' || result.error === 'approval_route_not_found') {
    return 'This workflow approval is no longer pending. Trigger the workflow again to request approval.'
  }
  if (result.status === 403 || result.error === 'not_authorized') {
    return 'You are not allowed to decide this workflow approval from this Teams conversation.'
  }
  const action = command.decision === 'deny' ? 'deny' : 'approve'
  return `I could not ${action} this workflow approval. Try again in a moment.`
}

async function logTeamsDecisionFeedbackFailure(
  result: TeamsTargetMessageResult,
  params: { approvalRequestId?: string; providerEventId: string; action: string }
): Promise<void> {
  if (result.ok) return
  log.warn('teams decision feedback failed', {
    approvalRequestId: params.approvalRequestId,
    providerEventId: params.providerEventId,
    action: params.action,
    status: result.status,
    error: result.error,
  })
}

function teamsDecisionFeedbackContext(
  targetId: string | null,
  payload: unknown,
  command: ReturnType<typeof normalizeProviderDecision>
): TeamsDecisionFeedbackContext | null {
  const serviceUrl = asString(asRecord(payload).serviceUrl)
  const messageId = teamsReplyToMessageId(payload)
  if (!targetId || !command?.providerChannelId || !messageId || !serviceUrl) return null
  return {
    targetId,
    conversationId: command.providerChannelId,
    messageId,
    serviceUrl,
  }
}

export function createServer(cfg = config): http.Server {
  return http.createServer(async (req, res) => {
    let stage: RequestStage = 'route'
    let medium = ''
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true })
        return
      }

      const parsedUrl = new URL(req.url || '/', 'http://workflow-approval-request-reader.local')
      const segments = parsedUrl.pathname.split('/').filter(Boolean)
      if (req.method !== 'POST' || segments[0] !== 'webhooks' || !segments[1]) {
        writeJson(res, 404, { error: 'not_found' })
        return
      }

      medium = segments[1].toLowerCase()
      const targetId = segments[2] ? decodeURIComponent(segments[2]) : null
      if (!cfg.enabledMedia.has(medium)) {
        writeJson(res, 404, { error: 'medium_disabled' })
        return
      }
      if (!rateLimitAllowed(cfg, req, medium, targetId)) {
        writeJson(res, 429, { error: 'rate_limited' })
        return
      }

      stage = 'body'
      const rawBody = await readBody(req)
      stage = 'provider_auth'
      const auth = await providerAuthorized(cfg, medium, targetId, req, rawBody)
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error })
        return
      }
      stage = 'parse'
      const payload = parseProviderPayload(medium, req, rawBody)
      const challenge = normalizeProviderUrlVerification(medium, payload)
      if (challenge) {
        writeJson(res, 200, { challenge })
        return
      }
      if (medium === 'slack' && auth.slackTarget) {
        const workspaceId = slackWorkspaceFromPayload(payload)
        if (workspaceId && workspaceId !== auth.slackTarget.providerWorkspaceId) {
          writeJson(res, 403, { error: 'slack_workspace_mismatch' })
          return
        }
      }
      if (medium === 'teams' && auth.teamsTarget) {
        const workspaceId = teamsWorkspaceFromPayload(payload)
        if (workspaceId && workspaceId !== auth.teamsTarget.providerWorkspaceId) {
          writeJson(res, 403, { error: 'teams_tenant_mismatch' })
          return
        }
      }
      stage = 'normalize'
      if (medium === 'teams' && auth.teamsTarget) {
        const fileConsent = normalizeTeamsFileConsent(payload)
        if (fileConsent) {
          if (!markProviderEventSeen(fileConsent.providerEventId)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          stage = 'background_message'
          void handoffTeamsFileConsentToChannelReader(cfg, auth.teamsTarget, fileConsent)
            .then(result => {
              if (!result.ok) {
                log.warn('teams file consent handoff failed', {
                  status: result.status,
                  error: result.error,
                  providerEventId: fileConsent.providerEventId,
                })
              }
            })
            .catch(err => {
              log.error('teams file consent handoff crashed', {
                error: err instanceof Error ? err.name : 'unknown_error',
              })
            })
          writeJson(res, 200, { ok: true })
          return
        }
      }
      const enrollment = normalizeProviderEnrollment(medium, payload)
      if (enrollment) {
        if (
          medium === 'slack' &&
          auth.slackTarget &&
          isSlackEventCallback(payload) &&
          !slackCanUseEnrollmentEvent(auth.slackTarget, payload, enrollment.providerChannelId)
        ) {
          writeJson(res, 200, { ok: true, ignored: true })
          return
        }
        if (
          medium === 'slack' &&
          enrollment.providerEventId &&
          !markProviderEventSeen(enrollment.providerEventId)
        ) {
          writeJson(res, 200, { ok: true, ignored: true })
          return
        }
        if (medium === 'slack' && auth.slackTarget) {
          stage = 'background_message'
          void handoffSlackEnrollmentToChannelReader(
            cfg,
            auth.slackTarget,
            enrollment,
            slackEventMessageTs(payload),
            slackEventThreadTs(payload)
          )
            .then(result => {
              if (!result.ok) {
                log.warn('slack enrollment handoff failed', {
                  status: result.status,
                  error: result.error,
                  providerChannelId: enrollment.providerChannelId,
                })
              }
            })
            .catch(err => {
              log.error('slack enrollment handoff crashed', {
                error: err instanceof Error ? err.name : 'unknown_error',
              })
            })
          writeJson(res, 200, { ok: true })
          return
        }
        if (medium === 'teams' && auth.teamsTarget) {
          if (!teamsCanUseMessage(auth.teamsTarget, payload)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          if (enrollment.providerEventId && !markProviderEventSeen(enrollment.providerEventId)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          stage = 'background_message'
          void handoffTeamsEnrollmentToChannelReader(
            cfg,
            auth.teamsTarget,
            enrollment,
            teamsActivityId(payload)
          )
            .then(result => {
              if (!result.ok) {
                log.warn('teams enrollment handoff failed', {
                  status: result.status,
                  error: result.error,
                  providerChannelId: enrollment.providerChannelId,
                })
              }
            })
            .catch(err => {
              log.error('teams enrollment handoff crashed', {
                error: err instanceof Error ? err.name : 'unknown_error',
              })
            })
          writeJson(res, 200, { ok: true })
          return
        }
        stage = 'mcp_host'
        const result = await submitMcpHostEnrollment(cfg, {
          ...enrollment,
          ...(auth.slackTarget
            ? {
                mcpHostRef: auth.slackTarget.hostRef,
                communicationChannelRef: auth.slackTarget.communicationChannelRef,
              }
            : {}),
        })
        const { status, ...body } = result
        writeJson(res, result.ok ? 200 : (status ?? 409), body)
        return
      }
      if (medium === 'slack' && auth.slackTarget) {
        const message = normalizeProviderMessage(medium, payload)
        if (message) {
          if (!slackCanUseMessage(auth.slackTarget, payload, message.providerChannelId)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          const handoffMessage = slackMessageShouldStripAcceptedMention(
            auth.slackTarget,
            payload,
            message.providerChannelId
          )
            ? normalizeProviderMessage(medium, payload, { stripLeadingMention: true })
            : message
          if (!handoffMessage) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          if (!markProviderEventSeen(handoffMessage.providerEventId)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          stage = 'background_message'
          void handoffSlackMessageToChannelReader(cfg, auth.slackTarget, handoffMessage)
            .then(result => {
              if (!result.ok) {
                log.warn('slack message handoff failed', {
                  status: result.status,
                  error: result.error,
                  providerEventId: handoffMessage.providerEventId,
                })
              }
            })
            .catch(err => {
              log.error('slack message handoff crashed', {
                error: err instanceof Error ? err.name : 'unknown_error',
              })
            })
          writeJson(res, 200, { ok: true })
          return
        }
      }
      if (medium === 'teams' && auth.teamsTarget) {
        const isWorkflowApprovalAction = teamsIsWorkflowApprovalAction(payload)
        const message = isWorkflowApprovalAction ? null : normalizeProviderMessage(medium, payload)
        if (message) {
          if (
            !teamsCanUseMessage(auth.teamsTarget, payload) &&
            !teamsIsWorkflowResultAction(payload) &&
            !teamsIsToolApprovalAction(payload)
          ) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          if (!markProviderEventSeen(message.providerEventId)) {
            writeJson(res, 200, { ok: true, ignored: true })
            return
          }
          stage = 'background_message'
          void handoffTeamsMessageToChannelReader(cfg, auth.teamsTarget, message)
            .then(result => {
              if (!result.ok) {
                log.warn('teams message handoff failed', {
                  status: result.status,
                  error: result.error,
                  providerEventId: message.providerEventId,
                })
              }
            })
            .catch(err => {
              log.error('teams message handoff crashed', {
                error: err instanceof Error ? err.name : 'unknown_error',
              })
            })
          writeJson(res, 200, { ok: true })
          return
        }
      }
      const command = normalizeProviderDecision(medium, payload)
      if (!command) {
        writeJson(res, 400, { error: 'invalid_decision_payload' })
        return
      }
      const routedCommand =
        medium === 'slack' && auth.slackTarget
          ? { ...command, mcpHostRef: auth.slackTarget.hostRef }
          : medium === 'teams' && auth.teamsTarget
            ? { ...command, mcpHostRef: auth.teamsTarget.hostRef }
            : command

      if (medium === 'slack' && isSlackBlockActions(payload)) {
        stage = 'background_message'
        submitSlackDecisionInBackground(
          cfg,
          routedCommand,
          slackDecisionFeedbackContext(targetId, payload, routedCommand)
        )
        writeJson(res, 200, { ok: true })
        return
      }

      if (medium === 'teams' && auth.teamsTarget) {
        stage = 'background_message'
        submitTeamsDecisionInBackground(
          cfg,
          routedCommand,
          teamsDecisionFeedbackContext(targetId, payload, routedCommand)
        )
        writeJson(res, 200, { ok: true })
        return
      }

      stage = 'mcp_host'
      const result = await submitMcpHostDecision(cfg, routedCommand)
      const { status, ...body } = result
      writeJson(res, result.ok ? 200 : (status ?? 409), body)
    } catch (err) {
      if (err instanceof RequestBodyError) {
        writeJson(res, err.statusCode, { error: err.publicError })
        return
      }
      if (err instanceof SyntaxError) {
        log.warn('invalid provider payload json', {
          stage,
          medium,
          url: req.url,
        })
        writeJson(res, 400, { error: 'invalid_json' })
        return
      }
      log.error('unhandled error', {
        stage,
        medium,
        url: req.url,
        error: err instanceof Error ? err.name : 'unknown_error',
      })
      writeJson(res, 500, { error: 'internal_error' })
    }
  })
}

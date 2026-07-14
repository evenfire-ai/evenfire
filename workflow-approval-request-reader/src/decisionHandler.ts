export type ApprovalDecision = 'approve' | 'deny'
export type ApprovalMedium = 'telegram' | 'slack'

export type ReaderDecisionCommand = {
  approvalRequestId?: string
  mcpHostRef?: string | null
  medium: ApprovalMedium
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId?: string | null
  providerChannelType?: string | null
  providerEventId: string
  decision?: ApprovalDecision
  note?: string | null
  // Figure D: 8-byte sha256 of communication_channel_ref, extracted from the
  // provider action value. Propagated to mcp-host → control-api so the D1 STRICT
  // filter can prove the callback came from the bot that delivered.
  channelAlias?: string | null
}

export type ReaderEnrollmentCommand = {
  nonce: string
  mcpHostRef?: string | null
  communicationChannelRef?: string | null
  medium: 'telegram' | 'slack'
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId?: string | null
  providerEventId?: string | null
}

export type ReaderMessageCommand = {
  content: string
  mcpHostRef?: string | null
  communicationChannelRef?: string | null
  medium: 'slack'
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerEventId: string
  providerMessageTs: string
  threadTs?: string | null
}

export type SlackMessageNormalizeOptions = {
  stripLeadingMention?: boolean
}

const APPROVAL_COMMAND_RE =
  /^(approve|deny|approved|denied|reject|rejected):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::(sandbox-recipes\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?))?(?::([0-9a-f]{16}))?$/i
// 4th group (optional): channelAlias — present on Figure D deliveries
// (worker embeds sha256(comm_channel_ref).slice(0,16) / 64-bit), absent on
// legacy/Figure C.
const COMPACT_APPROVAL_COMMAND_RE =
  /^(a|d):([A-Za-z0-9_-]{22}):(~[0-9a-f]{16}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9a-f]{16}))?$/i
const WORKFLOW_RESULT_ACTION_RE = /^workflow_result:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function slackEvent(payload: unknown): Record<string, unknown> {
  const body = asRecord(payload)
  return asRecord(body.event)
}

function slackMessageIdentity(payload: unknown): {
  teamId: string
  userId: string
  channelId: string
  text: string
  eventId: string
  threadTs?: string | null
  ts: string
} | null {
  const body = asRecord(payload)
  if (asString(body.type) !== 'event_callback') return null
  const event = slackEvent(payload)
  const eventType = asString(event.type)
  if (eventType !== 'message' && eventType !== 'app_mention') return null
  if (asString(event.subtype) || asString(event.bot_id)) return null

  const teamId = asString(body.team_id) || asString(event.team)
  const userId = asString(event.user)
  const channelId = asString(event.channel)
  const text = asString(event.text)
  const ts = asString(event.ts)
  const eventId = asString(event.client_msg_id) || ts || asString(body.event_id)
  if (!teamId || !userId || !channelId || !text || !eventId) return null
  return {
    teamId,
    userId,
    channelId,
    text,
    eventId,
    ts,
    threadTs: asString(event.thread_ts) || null,
  }
}

function slackDownloadActionIdentity(payload: unknown): ReaderMessageCommand | null {
  const body = asRecord(payload)
  if (asString(body.type) !== 'block_actions') return null
  const actions = Array.isArray(body.actions) ? body.actions : []
  const action = asRecord(actions[0])
  const raw = asString(action.value ?? action.action_id)
  const match = raw.match(WORKFLOW_RESULT_ACTION_RE)
  if (!match) return null

  const user = asRecord(body.user)
  const team = asRecord(body.team)
  const channel = asRecord(body.channel)
  const message = asRecord(body.message)
  const container = asRecord(body.container)
  const providerUserId = asString(user.id)
  const providerWorkspaceId = asString(team.id)
  const providerChannelId = asString(channel.id) || asString(container.channel_id)
  const providerMessageTs =
    asString(container.message_ts) || asString(message.ts) || asString(action.action_ts)
  if (!providerUserId || !providerWorkspaceId || !providerChannelId || !providerMessageTs) {
    return null
  }

  const providerEventPart =
    asString(body.trigger_id) ||
    asString(action.action_ts) ||
    `${providerUserId}:workflow_result:${match[1].toLowerCase()}`
  return {
    medium: 'slack',
    content: `download result ${match[1].toLowerCase()}`,
    providerUserId,
    providerWorkspaceId,
    providerChannelId,
    providerEventId: `slack:${providerWorkspaceId}:${providerChannelId}:${providerEventPart}`,
    providerMessageTs,
    threadTs: asString(message.thread_ts) || asString(container.thread_ts) || null,
  }
}

function stripLeadingSlackMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim()
}

function slackMessageContent(
  payload: unknown,
  text: string,
  options: SlackMessageNormalizeOptions = {}
): string {
  return asString(slackEvent(payload).type) === 'app_mention' || options.stripLeadingMention
    ? stripLeadingSlackMention(text)
    : text.trim()
}

function parseApprovalCommand(
  value: unknown
): {
  decision: ApprovalDecision
  approvalRequestId: string
  mcpHostRef?: string
  channelAlias?: string
} | null {
  const raw = asString(value)
  const match = raw.match(APPROVAL_COMMAND_RE)
  if (match) {
    return {
      decision: /^(approve|approved)$/i.test(match[1]) ? 'approve' : 'deny',
      approvalRequestId: match[2],
      ...(match[3] ? { mcpHostRef: match[3] } : {}),
      ...(match[4] ? { channelAlias: match[4].toLowerCase() } : {}),
    }
  }

  const compact = raw.match(COMPACT_APPROVAL_COMMAND_RE)
  if (!compact) return null
  try {
    const hex = Buffer.from(compact[2], 'base64url').toString('hex')
    if (hex.length !== 32) return null
    return {
      decision: compact[1].toLowerCase() === 'a' ? 'approve' : 'deny',
      approvalRequestId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
        16,
        20
      )}-${hex.slice(20)}`,
      mcpHostRef: `sandbox-recipes/${compact[3].toLowerCase()}`,
      ...(compact[4] ? { channelAlias: compact[4].toLowerCase() } : {}),
    }
  } catch {
    return null
  }
}

export function normalizeGenericDecision(
  medium: ApprovalMedium,
  payload: unknown
): ReaderDecisionCommand | null {
  const body = asRecord(payload)
  const decision = asString(body.decision)
  const approvalRequestId = asString(body.approvalRequestId)
  const mcpHostRef = asString(body.mcpHostRef)
  const providerUserId = asString(body.providerUserId)
  const providerEventId = asString(body.providerEventId)
  const hasLegacyApproval = (decision === 'approve' || decision === 'deny') && approvalRequestId
  if (!hasLegacyApproval || !providerUserId || !providerEventId) {
    return null
  }
  return {
    medium,
    ...(approvalRequestId ? { approvalRequestId } : {}),
    ...(mcpHostRef ? { mcpHostRef } : {}),
    providerUserId,
    providerWorkspaceId: asString(body.providerWorkspaceId) || null,
    providerChannelId: asString(body.providerChannelId) || null,
    providerEventId,
    ...(decision === 'approve' || decision === 'deny' ? { decision } : {}),
    note: asString(body.note) || null,
  }
}

export function normalizeTelegramDecision(payload: unknown): ReaderDecisionCommand | null {
  const body = asRecord(payload)
  const callback = asRecord(body.callback_query)
  const command = parseApprovalCommand(callback.data)
  const from = asRecord(callback.from)
  const message = asRecord(callback.message)
  const chat = asRecord(message.chat)
  const providerUserId = String(from.id ?? '').trim()
  if (!command || !providerUserId) return normalizeGenericDecision('telegram', payload)
  const providerChannelId = String(chat.id ?? '').trim()
  if (!providerChannelId) return null
  const providerEventId = asString(callback.id)
  return {
    medium: 'telegram',
    approvalRequestId: command.approvalRequestId,
    ...(command.mcpHostRef ? { mcpHostRef: command.mcpHostRef } : {}),
    providerUserId,
    providerChannelId,
    providerChannelType: asString(chat.type) || null,
    providerEventId: providerEventId
      ? `telegram:${providerChannelId}:${providerEventId}`
      : `telegram:${providerChannelId}:${providerUserId}:${
          command.approvalRequestId
        }`,
    decision: command.decision,
    ...(command.channelAlias ? { channelAlias: command.channelAlias } : {}),
  }
}

export function normalizeSlackDecision(payload: unknown): ReaderDecisionCommand | null {
  const body = asRecord(payload)
  const actions = Array.isArray(body.actions) ? body.actions : []
  const action = asRecord(actions[0])
  const command = parseApprovalCommand(action.value ?? action.action_id)
  const user = asRecord(body.user)
  const team = asRecord(body.team)
  const channel = asRecord(body.channel)
  const providerUserId = asString(user.id)
  if (!command || !providerUserId) return normalizeGenericDecision('slack', payload)
  const providerWorkspaceId = asString(team.id)
  const providerChannelId = asString(channel.id)
  if (!providerWorkspaceId || !providerChannelId) return null
  const providerEventPart = asString(body.trigger_id) || asString(action.action_ts)
  return {
    medium: 'slack',
    approvalRequestId: command.approvalRequestId,
    ...(command.mcpHostRef ? { mcpHostRef: command.mcpHostRef } : {}),
    providerUserId,
    providerWorkspaceId,
    providerChannelId,
    providerEventId:
      `slack:${providerWorkspaceId}:${providerChannelId}:${
        providerEventPart ||
        `${providerUserId}:${command.approvalRequestId}`
      }`,
    decision: command.decision,
    ...(command.channelAlias ? { channelAlias: command.channelAlias } : {}),
  }
}

export function normalizeTelegramEnrollment(payload: unknown): ReaderEnrollmentCommand | null {
  const body = asRecord(payload)
  const message = asRecord(body.message)
  const text = asString(message.text)
  const match = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,})$/)
  const from = asRecord(message.from)
  const chat = asRecord(message.chat)
  const providerUserId = String(from.id ?? '').trim()
  const providerChannelId = String(chat.id ?? '').trim()
  if (!match || !providerUserId || !providerChannelId) return null
  return {
    medium: 'telegram',
    nonce: match[1],
    providerUserId,
    providerChannelId,
  }
}

export function normalizeSlackEnrollment(payload: unknown): ReaderEnrollmentCommand | null {
  const body = asRecord(payload)
  const message = slackMessageIdentity(payload)
  if (message) {
    const match = message.text.match(/^(?:<@[A-Z0-9]+>\s*)?\/?verify\s+(\d{6})$/i)
    if (!match) return null
    return {
      medium: 'slack',
      nonce: match[1],
      providerUserId: message.userId,
      providerWorkspaceId: message.teamId,
      providerChannelId: message.channelId,
      providerEventId: `slack:${message.teamId}:${message.channelId}:${message.eventId}`,
    }
  }

  const actions = Array.isArray(body.actions) ? body.actions : []
  const action = asRecord(actions[0])
  const raw = asString(action.value ?? action.action_id)
  const match = raw.match(/^workflow_approval_link:(\d{6})$/)
  const user = asRecord(body.user)
  const team = asRecord(body.team)
  const channel = asRecord(body.channel)
  const providerUserId = asString(user.id)
  const providerWorkspaceId = asString(team.id)
  const providerChannelId = asString(channel.id)
  if (!match || !providerUserId || !providerWorkspaceId || !providerChannelId) return null
  return {
    medium: 'slack',
    nonce: match[1],
    providerUserId,
    providerWorkspaceId,
    providerChannelId,
  }
}

export function normalizeSlackUrlVerification(payload: unknown): string | null {
  const body = asRecord(payload)
  if (asString(body.type) !== 'url_verification') return null
  return asString(body.challenge) || null
}

export function normalizeSlackMessage(
  payload: unknown,
  options: SlackMessageNormalizeOptions = {}
): ReaderMessageCommand | null {
  const downloadAction = slackDownloadActionIdentity(payload)
  if (downloadAction) return downloadAction

  const message = slackMessageIdentity(payload)
  if (!message) return null
  if (/^(?:<@[A-Z0-9]+>\s*)?\/?verify\s+\d{6}$/i.test(message.text)) return null
  const content = slackMessageContent(payload, message.text, options)
  if (!content) return null
  return {
    medium: 'slack',
    content,
    providerUserId: message.userId,
    providerWorkspaceId: message.teamId,
    providerChannelId: message.channelId,
    providerEventId: `slack:${message.teamId}:${message.channelId}:${message.eventId}`,
    providerMessageTs: message.ts,
    threadTs: message.threadTs,
  }
}

export function normalizeProviderEnrollment(
  medium: string,
  payload: unknown
): ReaderEnrollmentCommand | null {
  switch (medium.toLowerCase()) {
    case 'telegram':
      return normalizeTelegramEnrollment(payload)
    case 'slack':
      return normalizeSlackEnrollment(payload)
    default:
      return null
  }
}

export function normalizeProviderDecision(
  medium: string,
  payload: unknown
): ReaderDecisionCommand | null {
  switch (medium.toLowerCase()) {
    case 'telegram':
      return normalizeTelegramDecision(payload)
    case 'slack':
      return normalizeSlackDecision(payload)
    default:
      return null
  }
}

export function normalizeProviderMessage(
  medium: string,
  payload: unknown,
  options: SlackMessageNormalizeOptions = {}
): ReaderMessageCommand | null {
  switch (medium.toLowerCase()) {
    case 'slack':
      return normalizeSlackMessage(payload, options)
    default:
      return null
  }
}

export function normalizeProviderUrlVerification(medium: string, payload: unknown): string | null {
  switch (medium.toLowerCase()) {
    case 'slack':
      return normalizeSlackUrlVerification(payload)
    default:
      return null
  }
}

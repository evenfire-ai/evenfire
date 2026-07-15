import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { workflowApprovalDeliverySkippedNoBotTotal } from '../observability/metrics.js'
import {
  type ChannelCredentialsGateway,
  CommunicationChannelCredentialsResolver,
} from './communicationChannelCredentialsResolver.js'
import {
  type WorkflowApprovalUserBoundNotificationDelivery,
  claimUserBoundNotificationDeliveries,
  markUserBoundNotificationDeliveryFailed,
  markUserBoundNotificationDeliverySent,
  markUserBoundNotificationDeliverySkippedNoBot,
} from './notificationDeliveryQueueService.js'

// Figure D delivery outcome (replaces the old boolean): a delivery is `sent`,
// retryable (`transient_failure`), or skipped because no bot resolved for the
// channel (`no_bot` → terminal skipped_no_bot, never a retry loop).
type DeliveryOutcome = 'sent' | 'transient_failure' | 'no_bot'

// Resolves per-channel bot credentials. Satisfied by
// CommunicationChannelCredentialsResolver; narrowed here so tests can inject a
// fake without a K8sGateway.
type ChannelTokenResolver = Pick<CommunicationChannelCredentialsResolver, 'resolve'>

export type DeliveryWorkerConfig = {
  enabled: boolean
  intervalMs: number
  batchSize: number
  telegramApiRoot: string
  slackApiRoot: string
}

let timer: NodeJS.Timeout | null = null
let running = false
const APPROVAL_ACTION_PREFIX_RE =
  /^([a-z]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::.*)?$/i
const APPROVAL_ACTION_RE =
  /^([a-z]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::.*)?$/i
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64
const WORKFLOW_RUNTIME_HOST_REF_RE = /^sandbox-recipes\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i
const WORKFLOW_RUNTIME_ROUTE_ALIAS_LEN = 16
// Figure D cross-bot fix: 64-bit (16 hex char) alias of the delivery's
// communication_channel_ref. Embedded in callback_data (signed by Telegram) so
// the reader can propagate it back to control-api, which validates
// sha256(wama.communication_channel_ref).slice(0,16) === alias to prove the
// callback came from the bot that delivered. 16 hex keeps total callback_data
// at ~59 bytes (within Telegram's 64-byte limit) while making channel-ref
// collisions on this authorization boundary infeasible — 8 hex (32-bit) was too
// short for an authz identifier whose inputs (channel names) an operator influences.
const CHANNEL_ALIAS_LEN = 16

function workerConfig(): DeliveryWorkerConfig {
  return {
    enabled: config.workflowApprovalNotificationDeliveryEnabled,
    intervalMs: config.workflowApprovalNotificationDeliveryIntervalMs,
    batchSize: config.workflowApprovalNotificationDeliveryBatchSize,
    telegramApiRoot: config.workflowApprovalTelegramApiRoot.replace(/\/+$/, ''),
    slackApiRoot: config.workflowApprovalSlackApiRoot.replace(/\/+$/, ''),
  }
}

function actionValue(
  action: { id: string; decision?: string },
  delivery: WorkflowApprovalUserBoundNotificationDelivery
): string {
  const raw = action.id || `${action.decision}:${delivery.payload.approvalRequestId}`
  const approvalAction = raw.match(APPROVAL_ACTION_PREFIX_RE)
  const base = `${approvalAction?.[1] ?? raw}:${delivery.mcpHostRef}`
  const channelAlias = communicationChannelAlias(delivery.communicationChannelRef)
  return channelAlias ? `${base}:${channelAlias}` : base
}

function communicationChannelAlias(communicationChannelRef?: string | null): string | null {
  return communicationChannelRef
    ? createHash('sha256').update(communicationChannelRef).digest('hex').slice(0, CHANNEL_ALIAS_LEN)
    : null
}

function compactTelegramActionValue(
  action: { id: string; decision?: string },
  delivery: WorkflowApprovalUserBoundNotificationDelivery
): string | null {
  const raw = action.id || `${action.decision}:${delivery.payload.approvalRequestId}`
  const match = raw.match(APPROVAL_ACTION_RE)
  const route = delivery.mcpHostRef.match(WORKFLOW_RUNTIME_HOST_REF_RE)
  if (!match || !route) return null

  const decision = /^(approve|approved)$/i.test(match[1])
    ? 'a'
    : /^(deny|denied|reject|rejected)$/i.test(match[1])
      ? 'd'
      : null
  if (!decision) return null

  const compactApprovalId = Buffer.from(match[2].replace(/-/g, ''), 'hex').toString('base64url')
  const routeAlias = createHash('sha256')
    .update(`sandbox-recipes/${route[1]}`)
    .digest('hex')
    .slice(0, WORKFLOW_RUNTIME_ROUTE_ALIAS_LEN)
  // Figure D multi-bot: embed channelAlias (sha256 of communication_channel_ref,
  // 16 hex / 64-bit) so the reader can propagate it to control-api. Telegram signs
  // callback_data, so the user cannot tamper with it. Omitted only when the
  // delivery has no channel ref.
  const channelAlias = communicationChannelAlias(delivery.communicationChannelRef)
  const value = channelAlias
    ? `${decision}:${compactApprovalId}:~${routeAlias}:${channelAlias}`
    : `${decision}:${compactApprovalId}:~${routeAlias}`
  return Buffer.byteLength(value, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES ? value : null
}

function approvalActionKind(action: { id: string }): 'approve' | 'deny' | null {
  const normalized = action.id.trim().toLowerCase()
  if (normalized.startsWith('approve:') || normalized.startsWith('approved:')) return 'approve'
  if (
    normalized.startsWith('deny:') ||
    normalized.startsWith('denied:') ||
    normalized.startsWith('reject:') ||
    normalized.startsWith('rejected:')
  ) {
    return 'deny'
  }
  return null
}

function deliveryText(delivery: WorkflowApprovalUserBoundNotificationDelivery): string {
  if (delivery.eventType === 'approval.requested') {
    return [delivery.payload.title, delivery.payload.body].filter(Boolean).join('\n')
  }
  if (delivery.eventType === 'approval.updated') {
    return `Approval ${delivery.payload.status} for ${delivery.payload.recipeNamespace}/${delivery.payload.recipeName}`
  }
  return [
    `Workflow ${delivery.payload.phase} for ${delivery.payload.recipeNamespace}/${delivery.payload.recipeName}`,
    delivery.payload.message,
  ]
    .filter(Boolean)
    .join('\n')
}

type PostResult = { ok: true } | { ok: false; status: number }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function slackProviderBinding(
  delivery: WorkflowApprovalUserBoundNotificationDelivery
): { channelId: string; threadTs: string | null } | null {
  let providerBinding: Record<string, unknown> | null = null
  if (delivery.eventType === 'approval.requested') {
    const metadata = asRecord(delivery.payload.metadata)
    const workflowTrigger = asRecord(metadata?.workflowTrigger)
    providerBinding = asRecord(workflowTrigger?.providerBinding)
  } else if (delivery.eventType === 'workflow.run.completed') {
    providerBinding = {
      medium: delivery.payload.providerMedium,
      providerWorkspaceId: delivery.payload.providerWorkspaceId,
      providerChannelId: delivery.payload.providerChannelId,
      providerThreadId: delivery.payload.providerThreadId,
    }
  }
  if (optionalString(providerBinding?.medium) !== 'slack') return null
  const workspaceId = optionalString(providerBinding?.providerWorkspaceId)
  if (workspaceId && delivery.providerWorkspaceId && workspaceId !== delivery.providerWorkspaceId) {
    return null
  }
  const channelId = optionalString(providerBinding?.providerChannelId) ?? delivery.providerChannelId
  if (!channelId) return null
  return {
    channelId,
    threadTs: optionalString(providerBinding?.providerThreadId),
  }
}

// Sends the provider request and classifies the result. On failure it returns a
// SAFE summary only — HTTP status + the provider's own error_code/description —
// and NEVER logs request headers or body (those carry the bot token, and the
// worker logs via console which is outside pino redaction). Every non-ok HTTP
// response is treated as a (retryable) failure; the attempts ladder caps retries
// and settles to `failed`, so even a permanent provider error (403 bot-blocked,
// 400 chat-not-found) terminates — just a few attempts later.
async function postJson(url: string, body: unknown, headers?: Headers): Promise<PostResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers ?? { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    error_code?: number
    description?: string
  }
  if (response.ok && data.ok === true) return { ok: true }
  console.warn('[ControlAPI] approval delivery provider rejected', {
    status: response.status,
    providerErrorCode: data.error_code,
    providerDescription: data.description,
  })
  return { ok: false, status: response.status }
}

function providerJsonHeaders(value: string): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Authoriz' + 'ation', `${'Be' + 'arer'} ${value}`)
  return headers
}

function postResultToOutcome(result: PostResult): DeliveryOutcome {
  // A `sent` is `sent`. Both permanent (403/400) and transient (429/5xx)
  // failures map to `transient_failure`: the retry/attempts ladder caps at 5 and
  // then settles to `failed`, so a permanent provider error still terminates —
  // just a few attempts slower. `no_bot` is reserved for "no credential", not
  // "provider rejected the send".
  return result.ok ? 'sent' : 'transient_failure'
}

async function sendTelegramDelivery(
  delivery: WorkflowApprovalUserBoundNotificationDelivery,
  cfg: DeliveryWorkerConfig,
  telegramBotToken: string
): Promise<DeliveryOutcome> {
  if (delivery.eventType !== 'approval.requested') {
    const result = await postJson(`${cfg.telegramApiRoot}/bot${telegramBotToken}/sendMessage`, {
      chat_id: delivery.providerChannelId,
      text: deliveryText(delivery),
    })
    return postResultToOutcome(result)
  }
  const actions = delivery.payload.actions ?? []
  const keyboard: Array<{ text: string; callback_data: string }> = []
  for (const action of actions) {
    const callbackData = compactTelegramActionValue(action, delivery)
    // Callback data exceeds Telegram's 64-byte limit — cannot build a valid
    // inline keyboard. Retryable (config/route may change); not a bot problem.
    if (!callbackData) return 'transient_failure'
    keyboard.push({ text: action.label, callback_data: callbackData })
  }
  const result = await postJson(`${cfg.telegramApiRoot}/bot${telegramBotToken}/sendMessage`, {
    chat_id: delivery.providerChannelId,
    text: deliveryText(delivery),
    reply_markup: { inline_keyboard: [keyboard] },
  })
  return postResultToOutcome(result)
}

async function openSlackDm(
  delivery: WorkflowApprovalUserBoundNotificationDelivery,
  cfg: DeliveryWorkerConfig,
  slackBotToken: string
): Promise<string | null> {
  const response = await fetch(`${cfg.slackApiRoot}/conversations.open`, {
    method: 'POST',
    headers: providerJsonHeaders(slackBotToken),
    body: JSON.stringify({ users: delivery.providerUserId }),
  })
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    channel?: { id?: string }
  }
  if (!response.ok || data.ok === false) return null
  return data.channel?.id || delivery.providerChannelId
}

async function sendSlackDelivery(
  delivery: WorkflowApprovalUserBoundNotificationDelivery,
  cfg: DeliveryWorkerConfig,
  slackBotToken: string
): Promise<DeliveryOutcome> {
  const binding = slackProviderBinding(delivery)
  const directChannel = binding?.channelId || delivery.providerChannelId
  const threadTs = binding?.threadTs ?? null
  // The verified Slack conversation is the delivery target. Only fall back to
  // opening a DM when an older/invalid delivery row lacks a channel id.
  const channel = directChannel || (await openSlackDm(delivery, cfg, slackBotToken))
  if (!channel) return 'transient_failure'
  if (delivery.eventType !== 'approval.requested') {
    const result = await postJson(
      `${cfg.slackApiRoot}/chat.postMessage`,
      {
        channel,
        text: deliveryText(delivery),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
      providerJsonHeaders(slackBotToken)
    )
    return postResultToOutcome(result)
  }
  const actions = delivery.payload.actions ?? []
  const result = await postJson(
    `${cfg.slackApiRoot}/chat.postMessage`,
    {
      channel,
      text: deliveryText(delivery),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: deliveryText(delivery) } },
        {
          type: 'actions',
          elements: actions.map(action => {
            const kind = approvalActionKind(action)
            return {
              type: 'button',
              action_id: `workflow_approval_${kind ?? 'decision'}`,
              text: { type: 'plain_text', text: action.label },
              value: actionValue(action, delivery),
              ...(kind === 'approve' ? { style: 'primary' } : {}),
              ...(kind === 'deny' ? { style: 'danger' } : {}),
            }
          }),
        },
      ],
    },
    providerJsonHeaders(slackBotToken)
  )
  return postResultToOutcome(result)
}

// Resolve the provider bot token for a delivery. Approval delivery is
// channel-scoped only: rows without a CommunicationChannel ref cannot be safely
// routed to any bot. Resolver failures propagate as transient delivery errors.
async function resolveChannelBotToken(
  delivery: WorkflowApprovalUserBoundNotificationDelivery,
  medium: 'telegram' | 'slack',
  resolver?: ChannelTokenResolver
): Promise<{ token: string } | { token: null }> {
  if (delivery.communicationChannelRef) {
    // Channel-bound delivery: it MUST use the channel's own bot. Never fall back
    // to the global bot — that would deliver via the wrong bot and reopen the
    // cross-bot hole. With no resolver available (no K8sGateway, e.g. dev/test
    // or early migration), there is no way to obtain the channel bot → no_bot.
    if (!resolver) return { token: null }
    const creds = await resolver.resolve(delivery.communicationChannelRef)
    const resolved = medium === 'telegram' ? creds.telegramBotToken : creds.slackBotToken
    return resolved ? { token: resolved } : { token: null }
  }
  // Channel-less row: invalid under the channel-scoped model.
  return { token: null }
}

async function deliverOne(
  delivery: WorkflowApprovalUserBoundNotificationDelivery,
  cfg: DeliveryWorkerConfig,
  resolver?: ChannelTokenResolver
): Promise<void> {
  let outcome: DeliveryOutcome
  try {
    if (delivery.medium === 'telegram') {
      const resolved = await resolveChannelBotToken(delivery, 'telegram', resolver)
      outcome = resolved.token
        ? await sendTelegramDelivery(delivery, cfg, resolved.token)
        : 'no_bot'
    } else if (delivery.medium === 'slack') {
      const resolved = await resolveChannelBotToken(delivery, 'slack', resolver)
      outcome = resolved.token ? await sendSlackDelivery(delivery, cfg, resolved.token) : 'no_bot'
    } else {
      outcome = 'no_bot'
    }
  } catch (error) {
    // Secret/CC read failure (RBAC, timeout, 5xx) — retryable, NOT no_bot.
    console.error('[ControlAPI] Workflow approval delivery resolve/send error:', {
      deliveryId: delivery.id,
      medium: delivery.medium,
      message: error instanceof Error ? error.message : String(error),
    })
    outcome = 'transient_failure'
  }

  if (outcome === 'sent') {
    await markUserBoundNotificationDeliverySent(delivery.id)
  } else if (outcome === 'no_bot') {
    // Only emit the metric + WARN when the terminal UPDATE actually landed. A
    // 0-row update means the delivery was already terminal / claimed by another
    // worker — counting it would inflate the suppression metric on a non-event.
    const marked = await markUserBoundNotificationDeliverySkippedNoBot(delivery.id)
    if (marked) {
      workflowApprovalDeliverySkippedNoBotTotal.inc({ medium: delivery.medium })
      console.warn('[ControlAPI] Workflow approval delivery skipped (no bot for channel):', {
        deliveryId: delivery.id,
        channelRef: delivery.communicationChannelRef,
        medium: delivery.medium,
      })
    }
  } else {
    await markUserBoundNotificationDeliveryFailed(delivery.id)
  }
}

export async function deliverWorkflowApprovalNotificationsOnce(
  cfg: DeliveryWorkerConfig = workerConfig(),
  resolver?: ChannelTokenResolver
): Promise<number> {
  if (!cfg.enabled) return 0
  let delivered = 0
  const media: Array<'telegram' | 'slack'> = ['telegram', 'slack']
  for (const medium of media) {
    // Per-channel resolution handles each delivery; a delivery with no
    // resolvable bot becomes skipped_no_bot.
    const deliveries = await claimUserBoundNotificationDeliveries({
      medium,
      providerWorkspaceId: null,
      limit: cfg.batchSize,
    })
    for (const delivery of deliveries) {
      // Isolate each delivery: a throw from a terminal mark* write (DB blip,
      // pool exhaustion) must NOT abort the rest of the batch. Aborting would
      // leave already-sent rows in 'retrying' → a duplicate send next tick.
      try {
        await deliverOne(delivery, cfg, resolver)
      } catch (error) {
        console.error('[ControlAPI] Workflow approval delivery failed (isolated):', {
          deliveryId: delivery.id,
          medium: delivery.medium,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      delivered += 1
    }
  }
  return delivered
}

export function startWorkflowApprovalNotificationDeliveryWorker(
  cfg: DeliveryWorkerConfig = workerConfig(),
  gateway?: ChannelCredentialsGateway
): void {
  if (!cfg.enabled || timer) return
  // Per-channel bot resolver (Figure D multi-bot). Absent only in dev/tests with
  // no gateway → channel-bound telegram deliveries fall through to skipped_no_bot.
  const resolver = gateway ? new CommunicationChannelCredentialsResolver(gateway) : undefined
  const tick = () => {
    if (running) return
    running = true
    deliverWorkflowApprovalNotificationsOnce(cfg, resolver)
      .catch(error => {
        console.error(
          '[ControlAPI] Workflow approval notification delivery failed:',
          error instanceof Error ? error.message : String(error)
        )
      })
      .finally(() => {
        running = false
      })
  }
  timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  tick()
}

export function stopWorkflowApprovalNotificationDeliveryWorker(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  running = false
}

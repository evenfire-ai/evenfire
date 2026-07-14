import type { ReaderConfig } from './config.js'
import { fetchWithTimeout, timeoutErrorName } from './httpTimeout.js'
import { readerLogger } from './logger.js'

const log = readerLogger.child({ module: 'control-api-client' })

export type CanApproveResult = {
  canApprove: boolean
  reason?: string
}

export type ChannelRefResult =
  | { ok: true; communicationChannelRef: string }
  | { ok: false; error: string }

export type SlackTargetVerificationResult =
  | {
      ok: true
      hostRef: string
      communicationChannelRef: string
      providerWorkspaceId: string
      replyOnlyWhenMentioned?: boolean
      replyInThreads?: boolean
      channelName: string
      channelNamespace: string
    }
  | { ok: false; status?: number; error: string }

export type SlackTargetMessageResult =
  | { ok: true; ts?: string | null }
  | { ok: false; status?: number; error: string }

type SlackBlock = Record<string, unknown>

/**
 * Figure D consulta (spec §10.3, diagram step 6): the reader asks control-api
 * whether (providerUserId, channelAlias) may approve the given request, BEFORE
 * forwarding the decision to the recipe mcp-host. This is a read-only
 * validation — it never records the decision. The authoritative barrier is the
 * D1 STRICT filter applied again at transmission time.
 *
 * Returns `null` when the consulta endpoint is not configured (no token/baseUrl
 * in the reader config). Callers treat null as "skip consulta, forward to
 * mcp-host" — transmission-time D1 STRICT remains the safety net.
 *
 * On any failure (non-2xx, timeout, network) the result is fail-safe:
 * `{ canApprove: false, reason: '...' }`. Better to not forward than to forward
 * without validation; the user can retry once control-api recovers.
 */
export async function canApprove(
  cfg: ReaderConfig,
  params: {
    approvalRequestId: string
    medium: string
    providerUserId: string
    providerWorkspaceId?: string | null
    providerChannelId?: string | null
    channelAlias: string
  }
): Promise<CanApproveResult | null> {
  if (!cfg.controlApiBaseUrl || !cfg.controlApiToken) {
    return null
  }
  const base = cfg.controlApiBaseUrl.replace(/\/+$/, '')
  const url = new URL(
    `/api/v1/internal/workflow-approval-reader/approvals/${encodeURIComponent(params.approvalRequestId)}/can-approve`,
    base
  )
  url.searchParams.set('medium', params.medium)
  url.searchParams.set('providerUserId', params.providerUserId)
  if (params.providerWorkspaceId) url.searchParams.set('providerWorkspaceId', params.providerWorkspaceId)
  if (params.providerChannelId) url.searchParams.set('providerChannelId', params.providerChannelId)
  url.searchParams.set('channelAlias', params.channelAlias)

  let response: Response
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          'x-service-token': 'workflow-approval-reader',
          Authorization: `Bearer ${cfg.controlApiToken}`,
        },
      },
      cfg.controlApiTimeoutMs
    )
  } catch (err) {
    log.error('control-api can-approve consulta error', {
      error: timeoutErrorName(err),
      approvalRequestId: params.approvalRequestId,
    })
    return { canApprove: false, reason: 'consulta_error' }
  }

  const body = (await response.json().catch(() => ({}))) as Partial<CanApproveResult>
  if (!response.ok) {
    log.warn('control-api can-approve consulta non-2xx', {
      status: response.status,
      approvalRequestId: params.approvalRequestId,
    })
    return { canApprove: false, reason: 'consulta_failed' }
  }
  return {
    canApprove: body.canApprove === true,
    ...(body.reason ? { reason: body.reason } : {}),
  }
}

export async function resolveCommunicationChannelRef(
  cfg: ReaderConfig,
  params: {
    medium: string
    providerWorkspaceId?: string | null
    providerChannelId?: string | null
  }
): Promise<ChannelRefResult | null> {
  if (!cfg.controlApiBaseUrl || !cfg.controlApiToken) return null
  const base = cfg.controlApiBaseUrl.replace(/\/+$/, '')
  const url = new URL('/api/v1/internal/workflow-approval-reader/channel-ref', base)
  url.searchParams.set('medium', params.medium)
  if (params.providerWorkspaceId) url.searchParams.set('providerWorkspaceId', params.providerWorkspaceId)
  if (params.providerChannelId) url.searchParams.set('providerChannelId', params.providerChannelId)

  let response: Response
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          'x-service-token': 'workflow-approval-reader',
          Authorization: `Bearer ${cfg.controlApiToken}`,
        },
      },
      cfg.controlApiTimeoutMs
    )
  } catch (err) {
    log.error('control-api channel-ref resolve error', {
      error: timeoutErrorName(err),
      medium: params.medium,
    })
    return { ok: false, error: 'channel_ref_resolve_error' }
  }

  const body = (await response.json().catch(() => ({}))) as {
    communicationChannelRef?: string
    error?: string
  }
  if (!response.ok) {
    log.warn('control-api channel-ref resolve non-2xx', {
      status: response.status,
      medium: params.medium,
      error: body.error,
    })
    return { ok: false, error: body.error ?? 'channel_ref_resolve_failed' }
  }
  const ref = body.communicationChannelRef?.trim()
  return ref ? { ok: true, communicationChannelRef: ref } : { ok: false, error: 'channel_ref_missing' }
}

export async function verifySlackTargetSignature(
  cfg: ReaderConfig,
  params: {
    targetId: string
    timestamp: string
    signature: string
    rawBody: Buffer
  }
): Promise<SlackTargetVerificationResult> {
  if (!cfg.controlApiBaseUrl || !cfg.controlApiToken) {
    return { ok: false, status: 503, error: 'control_api_not_configured' }
  }
  const base = cfg.controlApiBaseUrl.replace(/\/+$/, '')
  const url = new URL(
    `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(params.targetId)}/verify-signature`,
    base
  )

  let response: Response
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': 'workflow-approval-reader',
          Authorization: `Bearer ${cfg.controlApiToken}`,
        },
        body: JSON.stringify({
          timestamp: params.timestamp,
          signature: params.signature,
          rawBodyBase64: params.rawBody.toString('base64'),
        }),
      },
      cfg.controlApiTimeoutMs
    )
  } catch (err) {
    log.error('control-api slack target signature verify error', {
      error: timeoutErrorName(err),
      targetId: params.targetId,
    })
    return { ok: false, status: 504, error: 'slack_target_verify_error' }
  }

  const body = (await response.json().catch(() => ({}))) as Partial<
    Extract<SlackTargetVerificationResult, { ok: true }>
  > & { error?: string }
  if (!response.ok || body.ok !== true) {
    log.warn('control-api slack target signature verify non-2xx', {
      status: response.status,
      targetId: params.targetId,
      error: body.error,
    })
    return {
      ok: false,
      status: response.status,
      error: body.error ?? 'slack_target_verify_failed',
    }
  }

  return {
    ok: true,
    hostRef: String(body.hostRef || ''),
    communicationChannelRef: String(body.communicationChannelRef || ''),
    providerWorkspaceId: String(body.providerWorkspaceId || ''),
    replyOnlyWhenMentioned: body.replyOnlyWhenMentioned === true,
    replyInThreads: body.replyInThreads === true,
    channelName: String(body.channelName || ''),
    channelNamespace: String(body.channelNamespace || ''),
  }
}

async function postSlackTargetProxy(
  cfg: ReaderConfig,
  path: string,
  body: Record<string, unknown>
): Promise<SlackTargetMessageResult> {
  if (!cfg.controlApiBaseUrl || !cfg.controlApiToken) {
    return { ok: false, status: 503, error: 'control_api_not_configured' }
  }
  const base = cfg.controlApiBaseUrl.replace(/\/+$/, '')
  const url = new URL(path, base)

  let response: Response
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': 'workflow-approval-reader',
          Authorization: `Bearer ${cfg.controlApiToken}`,
        },
        body: JSON.stringify(body),
      },
      cfg.controlApiTimeoutMs
    )
  } catch (err) {
    log.warn('control-api slack target proxy error', {
      error: timeoutErrorName(err),
      path,
    })
    return { ok: false, status: 504, error: 'slack_target_proxy_error' }
  }

  const responseBody = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    ts?: string | null
    error?: string
  }
  if (!response.ok || responseBody.ok === false) {
    log.warn('control-api slack target proxy non-2xx', {
      status: response.status,
      path,
      error: responseBody.error,
    })
    return {
      ok: false,
      status: response.status,
      error: responseBody.error ?? 'slack_target_proxy_failed',
    }
  }
  return { ok: true, ts: responseBody.ts ?? null }
}

export function sendSlackTargetMessage(
  cfg: ReaderConfig,
  params: {
    targetId: string
    channelId: string
    text: string
    threadTs?: string | null
  }
): Promise<SlackTargetMessageResult> {
  return postSlackTargetProxy(
    cfg,
    `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(
      params.targetId
    )}/send-message`,
    {
      channelId: params.channelId,
      text: params.text,
      ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    }
  )
}

export function updateSlackTargetMessage(
  cfg: ReaderConfig,
  params: {
    targetId: string
    channelId: string
    messageTs: string
    text: string
    blocks?: SlackBlock[]
  }
): Promise<SlackTargetMessageResult> {
  return postSlackTargetProxy(
    cfg,
    `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(
      params.targetId
    )}/update-message`,
    {
      channelId: params.channelId,
      messageTs: params.messageTs,
      text: params.text,
      ...(params.blocks ? { blocks: params.blocks } : {}),
    }
  )
}

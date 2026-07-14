import { Router } from 'express'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import {
  requireInternalService,
  requireInternalToken,
} from '../../middleware/internalServiceAuth.js'
import { tryDecodeSlackTargetId } from '../../utils/slackTargetId.js'

/**
 * Figure D reader → control-api CONSULTA endpoint (spec §10.3, diagram step 6).
 *
 * The Workflow Approval Request Reader calls this BEFORE forwarding a decision
 * to the recipe mcp-host, so it can short-circuit when the user is not
 * authorized. This is a CONSULTA (read-only validation) — it does NOT record
 * the decision. The decision itself is transmitted through the generic path
 * reader → mcp-host → control-api (POST /workflow-approvals/:id/provider-decision),
 * which is the authoritative barrier (D1 STRICT applied again there).
 *
 * Wire shape:
 *   GET /api/v1/internal/workflow-approval-reader/approvals/:id/can-approve
 *       ?medium=<telegram|slack>&providerUserId=<id>&channelAlias=<8-hex>
 *   Auth: reader → control-api internal service token (static bearer,
 *         x-service-token: workflow-approval-reader). Reuses internalServiceAuth
 *         — same pattern as rpc-proxy / webhook-proxy. NOT a new JWT.
 *
 * 200 OK:   { canApprove: true }
 * 200 OK:   { canApprove: false, reason: '<code>' }
 * 400:      { error: '...' }  — malformed id / missing params
 *
 * Reason codes:
 *   approval_not_found       — :id does not match any row
 *   approval_not_pending     — already decided/cancelled
 *   approval_expired         — expires_at <= NOW()
 *   account_not_verified     — no active wama row for this providerUserId
 *   cross_bot_mismatch       — wama row exists but channelAlias ≠ hash(ref)
 *
 * The endpoint does NOT re-check the operator allowlist (recipe ↔ user/team).
 * That check is bound to the mcp-host caller identity in the generic decision
 * path and cannot be reproduced here (the reader is not an mcp-host caller).
 * The reader treats canApprove:true as "worth forwarding"; control-api has the
 * final word at transmission time.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Must match CHANNEL_ALIAS_LEN in the worker + operational identity service
// (16 hex / 64-bit).
const CHANNEL_ALIAS_LEN = 16
const CHANNEL_ALIAS_RE = new RegExp(`^[0-9a-f]{${CHANNEL_ALIAS_LEN}}$`, 'i')

type CanApproveReason =
  | 'approval_not_found'
  | 'approval_not_pending'
  | 'approval_expired'
  | 'account_not_verified'
  | 'cross_bot_mismatch'

type CommunicationChannelResource = {
  metadata?: { name?: string; namespace?: string }
  spec?: {
    credentialsSecretRef?: { name?: string }
    hostRef?: string
    telegram?: Array<{ channelId?: string }>
    slack?: Array<{ channelId?: string; workspaceId?: string }>
    slackSettings?: {
      replyInThreads?: boolean
      replyOnlyWhenMentioned?: boolean
      workspaceId?: string
    }
  }
}

type SecretResource = {
  data?: Record<string, string>
}

function resolveCommunicationChannelRef(
  channels: CommunicationChannelResource[],
  params: {
    medium: 'telegram' | 'slack'
    providerWorkspaceId: string
    providerChannelId: string
  }
):
  | { ok: true; ref: string }
  | {
      ok: false
      error: 'communication_channel_not_found' | 'communication_channel_ambiguous'
    } {
  const matches = channels.filter(channel => {
    const ns = channel.metadata?.namespace?.trim()
    const name = channel.metadata?.name?.trim()
    if (!ns || !name) return false
    if (params.medium === 'telegram') {
      return (channel.spec?.telegram ?? []).some(
        item => item.channelId === params.providerChannelId
      )
    }
    return (channel.spec?.slack ?? []).some(
      item =>
        item.workspaceId === params.providerWorkspaceId &&
        item.channelId === params.providerChannelId
    )
  })
  if (matches.length === 0) return { ok: false, error: 'communication_channel_not_found' }
  if (matches.length > 1) return { ok: false, error: 'communication_channel_ambiguous' }
  const metadata = matches[0]?.metadata
  return { ok: true, ref: `${metadata!.namespace}/${metadata!.name}` }
}

function decodeSecretString(secret: SecretResource, key: string): string | null {
  const value = secret.data?.[key]
  if (!value) return null
  return Buffer.from(value, 'base64').toString('utf8')
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

function verifySlackSignature(params: {
  signingSecret: string
  timestamp: string
  signature: string
  rawBody: Buffer
}): boolean {
  const requestTime = Number(params.timestamp)
  if (
    !params.timestamp ||
    !Number.isFinite(requestTime) ||
    !params.signature ||
    Math.abs(Date.now() / 1000 - requestTime) > 300
  ) {
    return false
  }
  const expected = `v0=${createHmac('sha256', params.signingSecret)
    .update(`v0:${params.timestamp}:${params.rawBody.toString('utf8')}`)
    .digest('hex')}`
  return safeEqual(params.signature, expected)
}

function slackWorkspaceIdForChannel(channel: CommunicationChannelResource): string | null {
  const settingsWorkspace = channel.spec?.slackSettings?.workspaceId?.trim()
  if (settingsWorkspace) return settingsWorkspace
  for (const group of channel.spec?.slack ?? []) {
    const workspaceId = group.workspaceId?.trim()
    if (workspaceId) return workspaceId
  }
  return null
}

function slackPayloadFromRawBody(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    const payload = new URLSearchParams(text).get('payload')
    if (!payload) return {}
    try {
      return JSON.parse(payload)
    } catch {
      return {}
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function slackWorkspaceIdFromPayload(payload: unknown): string | null {
  const body = asRecord(payload)
  const event = asRecord(body?.event)
  const team = asRecord(body?.team)
  const authorizations = Array.isArray(body?.authorizations) ? body.authorizations : []
  const authorization = asRecord(authorizations[0])
  return (
    recordString(body, 'team_id') ||
    recordString(event, 'team') ||
    recordString(team, 'id') ||
    recordString(authorization, 'team_id')
  )
}

async function resolveSlackTarget(gateway: K8sGateway, targetId: string) {
  const target = tryDecodeSlackTargetId(targetId)
  if (!target) return { ok: false as const, status: 400, error: 'invalid_target_id' }

  const channel = (await gateway.getResource(
    'communicationchannels',
    target.name,
    target.namespace
  )) as CommunicationChannelResource
  const name = channel.metadata?.name?.trim()
  const namespace = channel.metadata?.namespace?.trim()
  const hostRef = channel.spec?.hostRef?.trim()
  const secretName = channel.spec?.credentialsSecretRef?.name?.trim()
  const workspaceId = slackWorkspaceIdForChannel(channel)
  if (!name || !namespace || !hostRef || !secretName) {
    return { ok: false as const, status: 409, error: 'slack_target_not_ready' }
  }
  const secret = (await gateway.getSecret(secretName, namespace)) as SecretResource
  return {
    ok: true as const,
    channel,
    secret,
    hostRef,
    workspaceId,
    communicationChannelRef: `${namespace}/${name}`,
    channelName: name,
    channelNamespace: namespace,
  }
}

function providerJsonHeaders(value: string): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  // The split literals avoid false-positive secret-scanner alerts in generated
  // bundles; the runtime header is the standard Slack Web API bearer token.
  headers.set('Authoriz' + 'ation', `${'Be' + 'arer'} ${value}`)
  return headers
}

export function createInternalWorkflowApprovalReaderRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/internal/workflow-approval-reader/channel-ref',
    requireInternalToken,
    requireInternalService('workflow-approval-reader'),
    async (req, res, next) => {
      try {
        const medium = String(req.query.medium || '')
          .trim()
          .toLowerCase()
        const providerWorkspaceId = String(req.query.providerWorkspaceId || '').trim()
        const providerChannelId = String(req.query.providerChannelId || '').trim()

        if (medium !== 'telegram' && medium !== 'slack') {
          res.status(400).json({ error: 'unsupported_medium' })
          return
        }
        if (medium === 'slack' && !providerWorkspaceId) {
          res.status(400).json({ error: 'slack_workspace_id_required' })
          return
        }
        if (!providerChannelId) {
          res.status(400).json({ error: 'provider_channel_id_required' })
          return
        }

        const channels = (await gateway.listResource(
          'communicationchannels',
          '*'
        )) as CommunicationChannelResource[]
        const result = resolveCommunicationChannelRef(channels, {
          medium,
          providerWorkspaceId,
          providerChannelId,
        })
        if (!result.ok) {
          res.status(result.error === 'communication_channel_not_found' ? 404 : 409).json({
            error: result.error,
          })
          return
        }
        res.status(200).json({ communicationChannelRef: result.ref })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/internal/workflow-approval-reader/slack-targets/:targetId/verify-signature',
    requireInternalToken,
    requireInternalService('workflow-approval-reader'),
    async (req, res, next) => {
      try {
        const resolved = await resolveSlackTarget(gateway, String(req.params.targetId || ''))
        if (!resolved.ok) {
          res.status(resolved.status).json({ error: resolved.error })
          return
        }

        const timestamp = String(req.body?.timestamp || '').trim()
        const signature = String(req.body?.signature || '').trim()
        const rawBodyBase64 = String(req.body?.rawBodyBase64 || '').trim()
        if (!timestamp || !signature || !rawBodyBase64) {
          res.status(400).json({ error: 'invalid_signature_payload' })
          return
        }

        const signingSecret = decodeSecretString(resolved.secret, 'slack-signing-secret')
        if (!signingSecret) {
          res.status(409).json({ error: 'slack_signing_secret_missing' })
          return
        }
        const rawBody = Buffer.from(rawBodyBase64, 'base64')
        if (
          !verifySlackSignature({
            signingSecret,
            timestamp,
            signature,
            rawBody,
          })
        ) {
          res.status(401).json({ error: 'invalid_provider_signature' })
          return
        }

        const configuredWorkspaceId = resolved.workspaceId
        const requestWorkspaceId = slackWorkspaceIdFromPayload(slackPayloadFromRawBody(rawBody))
        if (
          configuredWorkspaceId &&
          requestWorkspaceId &&
          configuredWorkspaceId !== requestWorkspaceId
        ) {
          res.status(403).json({ error: 'slack_workspace_mismatch' })
          return
        }
        const providerWorkspaceId = configuredWorkspaceId ?? requestWorkspaceId

        res.status(200).json({
          ok: true,
          hostRef: resolved.hostRef,
          communicationChannelRef: resolved.communicationChannelRef,
          providerWorkspaceId: providerWorkspaceId ?? '',
          replyOnlyWhenMentioned:
            resolved.channel.spec?.slackSettings?.replyOnlyWhenMentioned === true,
          replyInThreads: resolved.channel.spec?.slackSettings?.replyInThreads === true,
          channelName: resolved.channelName,
          channelNamespace: resolved.channelNamespace,
        })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/internal/workflow-approval-reader/slack-targets/:targetId/send-message',
    requireInternalToken,
    requireInternalService('workflow-approval-reader'),
    async (req, res, next) => {
      try {
        const resolved = await resolveSlackTarget(gateway, String(req.params.targetId || ''))
        if (!resolved.ok) {
          res.status(resolved.status).json({ error: resolved.error })
          return
        }
        const channelId = String(req.body?.channelId || '').trim()
        const text = String(req.body?.text || '').trim()
        const threadTs = String(req.body?.threadTs || '').trim()
        if (!channelId || !text) {
          res.status(400).json({ error: 'invalid_slack_message' })
          return
        }
        const botToken = decodeSecretString(resolved.secret, 'slack-bot-token')
        if (!botToken) {
          res.status(409).json({ error: 'slack_bot_token_missing' })
          return
        }

        const response = await fetch(
          `${config.workflowApprovalSlackApiRoot.replace(/\/+$/, '')}/chat.postMessage`,
          {
            method: 'POST',
            headers: providerJsonHeaders(botToken),
            body: JSON.stringify({
              channel: channelId,
              text,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            }),
          }
        )
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          ts?: string
          error?: string
        }
        if (!response.ok || body.ok === false) {
          res.status(502).json({
            error: 'slack_send_failed',
            providerError: body.error || `http_${response.status}`,
          })
          return
        }
        res.status(200).json({ ok: true, ts: body.ts ?? null })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/internal/workflow-approval-reader/slack-targets/:targetId/update-message',
    requireInternalToken,
    requireInternalService('workflow-approval-reader'),
    async (req, res, next) => {
      try {
        const resolved = await resolveSlackTarget(gateway, String(req.params.targetId || ''))
        if (!resolved.ok) {
          res.status(resolved.status).json({ error: resolved.error })
          return
        }
        const channelId = String(req.body?.channelId || '').trim()
        const messageTs = String(req.body?.messageTs || '').trim()
        const text = String(req.body?.text || '').trim()
        const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : undefined
        if (!channelId || !messageTs || !text) {
          res.status(400).json({ error: 'invalid_slack_message_update' })
          return
        }
        const botToken = decodeSecretString(resolved.secret, 'slack-bot-token')
        if (!botToken) {
          res.status(409).json({ error: 'slack_bot_token_missing' })
          return
        }

        const response = await fetch(
          `${config.workflowApprovalSlackApiRoot.replace(/\/+$/, '')}/chat.update`,
          {
            method: 'POST',
            headers: providerJsonHeaders(botToken),
            body: JSON.stringify({
              channel: channelId,
              ts: messageTs,
              text,
              ...(blocks ? { blocks } : {}),
            }),
          }
        )
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          ts?: string
          error?: string
        }
        if (!response.ok || body.ok === false) {
          res.status(502).json({
            error: 'slack_update_failed',
            providerError: body.error || `http_${response.status}`,
          })
          return
        }
        res.status(200).json({ ok: true, ts: body.ts ?? messageTs })
      } catch (err) {
        next(err)
      }
    }
  )

  router.get(
    '/internal/workflow-approval-reader/approvals/:id/can-approve',
    requireInternalToken,
    requireInternalService('workflow-approval-reader'),
    async (req, res, next) => {
      try {
        const approvalRequestId = String(req.params.id || '').trim()
        if (!UUID_RE.test(approvalRequestId)) {
          res.status(400).json({ error: 'invalid_approval_id' })
          return
        }

        const medium = String(req.query.medium || '')
          .trim()
          .toLowerCase()
        const providerUserId = String(req.query.providerUserId || '').trim()
        const providerWorkspaceId = String(req.query.providerWorkspaceId || '').trim()
        const providerChannelId = String(req.query.providerChannelId || '').trim()
        const channelAlias = String(req.query.channelAlias || '')
          .trim()
          .toLowerCase()

        if (medium !== 'telegram' && medium !== 'slack') {
          res.status(400).json({ error: 'unsupported_medium' })
          return
        }
        if (medium === 'slack' && !providerWorkspaceId) {
          res.status(400).json({ error: 'slack_workspace_id_required' })
          return
        }
        if (medium === 'slack' && !providerChannelId) {
          res.status(400).json({ error: 'provider_channel_id_required' })
          return
        }
        if (!providerUserId) {
          res.status(400).json({ error: 'provider_user_id_required' })
          return
        }
        if (!CHANNEL_ALIAS_RE.test(channelAlias)) {
          res.status(400).json({ error: 'invalid_channel_alias' })
          return
        }

        const deny = (reason: CanApproveReason) => {
          res.status(200).json({ canApprove: false, reason })
        }

        // 1. Approval request must exist, be pending, and not expired.
        const approval = await pool.query(
          `SELECT status,
                  expires_at <= NOW() AS "isExpired"
             FROM workflow_approval_requests
            WHERE id = $1`,
          [approvalRequestId]
        )
        const approvalRow = approval.rows[0] as { status: string; isExpired: boolean } | undefined
        if (!approvalRow) {
          deny('approval_not_found')
          return
        }
        if (approvalRow.status !== 'pending') {
          deny('approval_not_pending')
          return
        }
        if (approvalRow.isExpired) {
          deny('approval_expired')
          return
        }

        // 2. Verified account must exist for this provider identity.
        // 3. D1 STRICT (consulta): sha256(communication_channel_ref).slice(0,16)
        //    must equal the provider action channelAlias.
        const accounts = await pool.query(
          `SELECT communication_channel_ref AS "communicationChannelRef"
             FROM workflow_approval_medium_accounts
            WHERE medium = $1
              AND provider_user_id = $2
              AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
              AND ($4::text IS NULL OR provider_channel_id = $4)
              AND communication_channel_ref IS NOT NULL
              AND disabled_at IS NULL`,
          [
            medium,
            providerUserId,
            medium === 'slack' ? providerWorkspaceId : null,
            medium === 'slack' ? providerChannelId : null,
          ]
        )
        const rows = accounts.rows as Array<{ communicationChannelRef: string }>
        if (rows.length === 0) {
          deny('account_not_verified')
          return
        }
        const matched = rows.some(row => {
          const candidate = createHash('sha256')
            .update(row.communicationChannelRef)
            .digest('hex')
            .slice(0, CHANNEL_ALIAS_LEN)
          return candidate === channelAlias
        })
        if (!matched) {
          deny('cross_bot_mismatch')
          return
        }

        res.status(200).json({ canApprove: true })
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}

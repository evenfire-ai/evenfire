import type { ReaderConfig } from './config.js'
import { canApprove, resolveCommunicationChannelRef } from './controlApiClient.js'
import type { ReaderDecisionCommand, ReaderEnrollmentCommand } from './decisionHandler.js'
import { fetchWithTimeout, timeoutErrorName } from './httpTimeout.js'
import { readerLogger } from './logger.js'
import { targetForProviderHostRef, targetsForDecision } from './mcpHostTargets.js'

const log = readerLogger.child({ module: 'mcp-host-client' })

export type McpHostDecisionResult = {
  ok: boolean
  status?: number
  duplicate?: boolean
  error?: string
}

export type McpHostEnrollmentResult = {
  ok: boolean
  status?: number
  error?: string
  account?: unknown
}

function providerIdentity(command: ReaderDecisionCommand): Record<string, unknown> {
  return {
    medium: command.medium,
    providerUserId: command.providerUserId,
    providerWorkspaceId: command.providerWorkspaceId ?? null,
    providerChannelId: command.providerChannelId ?? null,
    providerEventId: command.providerEventId,
    ...(command.providerChannelType ? { providerChannelType: command.providerChannelType } : {}),
    // Figure D: propagate the provider action channelAlias so control-api's D1
    // STRICT filter can bind the decision to the bot that delivered.
    ...(command.channelAlias
      ? { providerTarget: { communicationChannelAlias: command.channelAlias } }
      : {}),
  }
}

function runtimeHeaders(
  command: ReaderDecisionCommand,
  target: { hostRef: string }
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'workflow-approval-request-reader',
    'x-clerum-edge-host-ref': target.hostRef,
    'x-clerum-edge-channel-type': command.medium,
    'x-clerum-edge-channel-id': command.providerChannelId ?? '',
    'x-clerum-edge-sender': command.providerUserId,
  }
}

function enrollmentRuntimeHeaders(
  command: ReaderEnrollmentCommand,
  target: { hostRef: string }
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'workflow-approval-request-reader',
    'x-clerum-edge-host-ref': target.hostRef,
    'x-clerum-edge-channel-type': command.medium,
    'x-clerum-edge-channel-id': command.providerChannelId ?? '',
    'x-clerum-edge-sender': command.providerUserId,
  }
}

function targetForEnrollment(
  cfg: ReaderConfig,
  command: ReaderEnrollmentCommand
): { hostRef: string; baseUrl: string } | null {
  const explicitHostRef = command.mcpHostRef?.trim()
  if (explicitHostRef) return targetForProviderHostRef(cfg, explicitHostRef)
  if (!cfg.mcpHostRef || !cfg.mcpHostBaseUrl) return null
  return { hostRef: cfg.mcpHostRef, baseUrl: cfg.mcpHostBaseUrl }
}

export async function submitMcpHostDecision(
  cfg: ReaderConfig,
  command: ReaderDecisionCommand
): Promise<McpHostDecisionResult> {
  const approvalRequestId = command.approvalRequestId?.trim()
  if (!approvalRequestId || !command.decision) {
    return { ok: false, status: 400, error: 'invalid_reader_decision_command' }
  }
  if (!command.providerChannelId) {
    return { ok: false, status: 400, error: 'provider_channel_id_required' }
  }
  const routed = targetsForDecision(cfg, approvalRequestId, command)
  if (routed.targets.length === 0) {
    return { ok: false, status: 409, error: 'approval_route_not_found' }
  }

  // Figure D: consulta previa a control-api (spec §10.3, step 6). Only when
  // the decision carries a channelAlias (Figure D deliveries with a signed
  // callback_data). Skipped on legacy/Figure C commands. Fail-safe: if the
  // consulta returns canApprove=false, do NOT forward to the mcp-host.
  if (command.channelAlias) {
    const consulta = await canApprove(cfg, {
      approvalRequestId,
      medium: command.medium,
      providerUserId: command.providerUserId,
      providerWorkspaceId: command.providerWorkspaceId ?? null,
      providerChannelId: command.providerChannelId ?? null,
      channelAlias: command.channelAlias,
    })
    if (consulta && !consulta.canApprove) {
      log.warn('control-api can-approve rejected decision', {
        approvalRequestId,
        reason: consulta.reason,
        medium: command.medium,
      })
      return { ok: false, status: 403, error: consulta.reason ?? 'not_authorized' }
    }
  }

  let lastFailure: McpHostDecisionResult | null = null
  for (const target of routed.targets) {
    let response: Response
    try {
      response = await fetchWithTimeout(
        `${target.baseUrl.replace(/\/$/, '')}/v1/runtime/workflow-approvals/decide`,
        {
          method: 'POST',
          headers: runtimeHeaders(command, target),
          body: JSON.stringify({
            approvalRequestId,
            decision: command.decision,
            providerIdentity: providerIdentity(command),
            note: command.note ?? null,
          }),
        },
        cfg.mcpHostTimeoutMs
      )
    } catch (err) {
      log.error('mcp-host decision request failed', {
        error: timeoutErrorName(err),
        medium: command.medium,
        approvalRequestId,
        providerEventId: command.providerEventId,
        mcpHostRef: target.hostRef,
      })
      lastFailure = { ok: false, status: 504, error: 'mcp_host_unavailable' }
      if (routed.explicit) return lastFailure
      continue
    }

    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean
      duplicate?: boolean
      error?: string
    }
    if (!response.ok || body.success === false) {
      lastFailure = {
        ok: false,
        status: response.ok ? 409 : response.status,
        error: body.error ?? `mcp_host_decision_failed_${response.status}`,
      }
      if (routed.explicit) return lastFailure
      continue
    }
    return { ok: true, duplicate: body.duplicate === true }
  }
  return lastFailure ?? { ok: false, status: 409, error: 'approval_route_not_found' }
}

export async function submitMcpHostEnrollment(
  cfg: ReaderConfig,
  command: ReaderEnrollmentCommand
): Promise<McpHostEnrollmentResult> {
  if (!command.nonce || !command.providerUserId || !command.providerChannelId) {
    return { ok: false, status: 400, error: 'invalid_reader_enrollment_command' }
  }
  const target = targetForEnrollment(cfg, command)
  if (!target) {
    return { ok: false, status: 409, error: 'mcp_host_target_required' }
  }
  let communicationChannelRef = command.communicationChannelRef?.trim() || null
  if (!communicationChannelRef) {
    const resolvedChannelRef = await resolveCommunicationChannelRef(cfg, {
      medium: command.medium,
      providerWorkspaceId: command.providerWorkspaceId ?? null,
      providerChannelId: command.providerChannelId ?? null,
    })
    communicationChannelRef =
      resolvedChannelRef?.ok === true ? resolvedChannelRef.communicationChannelRef : null
  }

  let response: Response
  try {
    response = await fetchWithTimeout(
      `${target.baseUrl.replace(/\/$/, '')}/v1/runtime/workflow-approval-mediums/link-sessions/confirm`,
      {
        method: 'POST',
        headers: enrollmentRuntimeHeaders(command, target),
        body: JSON.stringify({
          nonce: command.nonce,
          medium: command.medium,
          providerUserId: command.providerUserId,
          providerWorkspaceId: command.providerWorkspaceId ?? null,
          providerChannelId: command.providerChannelId ?? null,
          communicationChannelRef,
        }),
      },
      cfg.mcpHostTimeoutMs
    )
  } catch (err) {
    log.error('mcp-host enrollment request failed', {
      error: timeoutErrorName(err),
      medium: command.medium,
    })
    return { ok: false, status: 504, error: 'mcp_host_unavailable' }
  }

  const body = (await response.json().catch(() => ({}))) as McpHostEnrollmentResult
  if (!response.ok || body.ok === false) {
    return {
      ok: false,
      status: response.status,
      error: body.error ?? `mcp_host_enrollment_failed_${response.status}`,
    }
  }
  return body.ok === true ? body : { ok: true, account: body.account }
}

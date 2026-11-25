/**
 * The one projection of a pending approval for every read view: the cached and
 * durable session summaries, message pages, the REST pending-approval list, the
 * tool:approval_needed event and the SSE `suspended` event.
 *
 * `alwaysApproveAllowed` is decided by the card's durable `authorization_scope`
 * alone (persisted on `pending_approvals`, migration 016): only an ordinary
 * `turn_tools` card offers it, so every view reports
 * `alwaysApproveAllowed: false` for exact-invocation and legacy unknown scopes.
 * What approve() stores also depends on the effective mode at answer time: a
 * name grant needs manual (cron_manage aside; an Always answer in another mode
 * is logged as `always_approve_ignored`). An auto shell card is
 * exact_invocation, yet while the mode is still auto it may store a whole-tool
 * shell grant, or a command grant where its `shellCard` descriptor offers the
 * command on the answering surface.
 */
import type { PendingApprovalRow } from '../../db/worker/protocol'
import type { ShellCardDescriptor } from '../approval/shellCard'
import type { PendingApproval } from '../types'
import { normalizeAuthorizationScope, normalizeConnectReason } from './persistence/reconstruct'

export type PendingApprovalSummary = Pick<
  PendingApproval,
  'request_id' | 'tool_name' | 'reason' | 'mcpServerName' | 'authorization_scope'
>

export function summarizePendingApproval(approval: PendingApproval): PendingApprovalSummary {
  return {
    request_id: approval.request_id,
    tool_name: approval.tool_name,
    reason: approval.reason,
    mcpServerName: approval.mcpServerName,
    authorization_scope: approval.authorization_scope,
  }
}

/** The cold (DB-direct) variant: snake→camel and narrowed values. */
export function summarizePendingApprovalRow(
  row: Pick<
    PendingApprovalRow,
    'request_id' | 'tool_name' | 'reason' | 'mcp_server_name' | 'authorization_scope'
  >
): PendingApprovalSummary {
  return {
    request_id: row.request_id,
    tool_name: row.tool_name,
    reason: normalizeConnectReason(row.reason),
    mcpServerName: row.mcp_server_name ?? undefined,
    authorization_scope: normalizeAuthorizationScope(row.authorization_scope),
  }
}

/** True only for a card that may store a grant ("Always approve"). */
export function mayStoreGrant(approval: Pick<PendingApproval, 'authorization_scope'>): boolean {
  return approval.authorization_scope === 'turn_tools'
}

/**
 * The client-facing fields of a pending approval. `mcpServerName` rides only a
 * connect_required card; `alwaysApproveAllowed` is present (false) only when the
 * card cannot store a grant. `shellCard` is in-memory only: a restarted card
 * has no descriptor and is answered as once.
 */
export function pendingApprovalWireFields(
  approval: Pick<PendingApproval, 'reason' | 'mcpServerName' | 'authorization_scope' | 'shellCard'>
): {
  reason?: 'approval_required' | 'connect_required'
  mcpServerName?: string
  alwaysApproveAllowed?: false
  shellCard?: ShellCardDescriptor
} {
  return {
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(approval.reason === 'connect_required' && approval.mcpServerName
      ? { mcpServerName: approval.mcpServerName }
      : {}),
    ...(mayStoreGrant(approval) ? {} : { alwaysApproveAllowed: false as const }),
    ...(approval.shellCard ? { shellCard: approval.shellCard } : {}),
  }
}

import type { ModelStepCheckpointSnapshot } from '../../db/worker/modelStepCheckpointOps'
import {
  MODEL_STEP_BLOCKED_REASONS,
  MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES,
  type ModelStepBlockedReason,
  type ModelStepCheckpointView,
  type ModelStepCheckpointVisibleStatus,
} from './modelStepCheckpointContract'

function isVisibleStatus(status: string): status is ModelStepCheckpointVisibleStatus {
  return (MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES as readonly string[]).includes(status)
}

function isBlockedReason(reason: string): reason is ModelStepBlockedReason {
  return (MODEL_STEP_BLOCKED_REASONS as readonly string[]).includes(reason)
}

/**
 * #1043 — wire view of a live checkpoint (§4.1). `undefined` for an `open`
 * header or an expired/invalid row, which must not offer an action. The
 * transcript remains readable when an older checkpoint row is incomplete.
 */
export function toModelStepCheckpointView(
  snapshot: ModelStepCheckpointSnapshot,
  now = Date.now()
): ModelStepCheckpointView | undefined {
  const { header, tools } = snapshot
  if (!isVisibleStatus(header.status)) return undefined
  if (header.failed_at === null || header.expires_at === null) return undefined
  const leaseAlive =
    header.status === 'claimed' && header.claim_expires_at !== null && header.claim_expires_at > now
  if (header.expires_at <= now && !leaseAlive) return undefined
  let blockedReason: ModelStepBlockedReason | undefined
  if (header.status === 'blocked') {
    const reason = header.blocked_reason ?? ''
    if (!isBlockedReason(reason)) return undefined
    blockedReason = reason
  }
  return {
    checkpointId: header.checkpoint_id,
    version: header.version,
    status: header.status,
    retryAvailable: header.status === 'resumable',
    originTaskId: header.origin_task_id,
    ...(header.status === 'claimed' && header.continuation_task_id
      ? { continuationTaskId: header.continuation_task_id }
      : {}),
    provider: header.provider,
    model: header.model,
    ...(blockedReason ? { blockedReason } : {}),
    tools: {
      confirmed: tools.confirmed,
      unknown: tools.unknown,
      notDispatched: tools.notDispatched,
    },
    failedAt: new Date(header.failed_at).toISOString(),
    expiresAt: new Date(header.expires_at).toISOString(),
  }
}

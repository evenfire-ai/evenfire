import type {
  ModelStepBlockedReason,
  ModelStepCheckpointView,
  ModelStepCheckpointVisibleStatus,
  ModelStepContinueResult,
} from './types.js'

/**
 * Strict readers for the model-step checkpoint wire contract (issues #1043 /
 * #1044, `docs/contracts/model-step-checkpoint.md`). The Host is the authority
 * on the checkpoint, so a value that does not match the contract is rejected
 * with an `Error` naming the field instead of being coerced into a view the
 * renderer would act on.
 */

const VISIBLE_STATUSES: readonly ModelStepCheckpointVisibleStatus[] = [
  'resumable',
  'claimed',
  'blocked',
]

const BLOCKED_REASONS: readonly ModelStepBlockedReason[] = [
  'principal_mismatch',
  'host_mismatch',
  'grant_revoked',
  'model_unavailable',
  'budget_exhausted',
  'reference_unavailable',
  'attachment_expired',
]

export const MODEL_STEP_CONTINUE_ERROR_CODES = {
  notFound: 'model_step_checkpoint_not_found',
  versionMismatch: 'model_step_checkpoint_version_mismatch',
  blocked: 'model_step_checkpoint_blocked',
} as const

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
  return value
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function isoTimestamp(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  if (Number.isNaN(Date.parse(text))) throw new Error(`Invalid ${label}`)
  return text
}

function blockedReason(value: unknown, label: string): ModelStepBlockedReason {
  if (typeof value !== 'string' || !BLOCKED_REASONS.includes(value as ModelStepBlockedReason)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as ModelStepBlockedReason
}

export function parseModelStepCheckpointView(
  value: unknown,
  label = 'model step checkpoint'
): ModelStepCheckpointView {
  const view = record(value, label)
  const status = view.status
  if (
    typeof status !== 'string' ||
    !VISIBLE_STATUSES.includes(status as ModelStepCheckpointVisibleStatus)
  ) {
    throw new Error(`Invalid ${label}.status`)
  }
  const visibleStatus = status as ModelStepCheckpointVisibleStatus
  if (typeof view.retryAvailable !== 'boolean') throw new Error(`Invalid ${label}.retryAvailable`)
  // The contract ties the two fields: a checkpoint is retryable exactly when it
  // is resumable. A disagreement is a Host defect, not something to guess around.
  if (view.retryAvailable !== (visibleStatus === 'resumable')) {
    throw new Error(`Invalid ${label}.retryAvailable`)
  }
  const version = view.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid ${label}.version`)
  }
  const tools = record(view.tools, `${label}.tools`)
  const continuationTaskId =
    view.continuationTaskId === undefined || view.continuationTaskId === null
      ? undefined
      : nonEmptyString(view.continuationTaskId, `${label}.continuationTaskId`)
  if (visibleStatus === 'claimed' && continuationTaskId === undefined) {
    throw new Error(`Invalid ${label}.continuationTaskId`)
  }
  const reason =
    view.blockedReason === undefined || view.blockedReason === null
      ? undefined
      : blockedReason(view.blockedReason, `${label}.blockedReason`)
  if (visibleStatus === 'blocked' && reason === undefined) {
    throw new Error(`Invalid ${label}.blockedReason`)
  }
  return {
    checkpointId: nonEmptyString(view.checkpointId, `${label}.checkpointId`),
    version,
    status: visibleStatus,
    retryAvailable: view.retryAvailable,
    originTaskId: nonEmptyString(view.originTaskId, `${label}.originTaskId`),
    ...(continuationTaskId !== undefined ? { continuationTaskId } : {}),
    provider: nonEmptyString(view.provider, `${label}.provider`),
    model: nonEmptyString(view.model, `${label}.model`),
    ...(reason !== undefined ? { blockedReason: reason } : {}),
    tools: {
      confirmed: count(tools.confirmed, `${label}.tools.confirmed`),
      unknown: count(tools.unknown, `${label}.tools.unknown`),
      notDispatched: count(tools.notDispatched, `${label}.tools.notDispatched`),
    },
    failedAt: isoTimestamp(view.failedAt, `${label}.failedAt`),
    expiresAt: isoTimestamp(view.expiresAt, `${label}.expiresAt`),
  }
}

/**
 * Maps one answer of the continuation POST onto its contract row. Returns
 * `null` when the status/body pair is not a contract row, so the caller can
 * throw with the HTTP status it already holds (503 `host_draining`, an older
 * rpc-proxy without the route, a 5xx).
 */
export function parseModelStepContinueResponse(
  httpStatus: number,
  body: unknown,
  expectedCheckpointId: string
): ModelStepContinueResult | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const payload = body as Record<string, unknown>
  const label = 'model step continue response'
  if (httpStatus === 202 || httpStatus === 200) {
    const taskId = nonEmptyString(payload.taskId, `${label}.taskId`)
    const checkpointId = nonEmptyString(payload.checkpointId, `${label}.checkpointId`)
    if (checkpointId !== expectedCheckpointId) throw new Error(`Invalid ${label}.checkpointId`)
    if (typeof payload.replayed !== 'boolean') throw new Error(`Invalid ${label}.replayed`)
    if (httpStatus === 202) {
      if (payload.status !== 'claimed') throw new Error(`Invalid ${label}.status`)
      return {
        outcome: 'claimed',
        httpStatus,
        body: { taskId, checkpointId, status: 'claimed', replayed: payload.replayed },
      }
    }
    if (payload.status !== 'completed' || payload.replayed !== true) {
      throw new Error(`Invalid ${label}.status`)
    }
    return {
      outcome: 'completed',
      httpStatus,
      body: { taskId, checkpointId, status: 'completed', replayed: true },
    }
  }
  if (httpStatus === 404 && payload.code === MODEL_STEP_CONTINUE_ERROR_CODES.notFound) {
    return { outcome: 'not_found', httpStatus, body: { code: payload.code } }
  }
  if (httpStatus === 409 && payload.code === MODEL_STEP_CONTINUE_ERROR_CODES.versionMismatch) {
    const current = parseModelStepCheckpointView(payload.current, `${label}.current`)
    if (current.checkpointId !== expectedCheckpointId) {
      throw new Error(`Invalid ${label}.current.checkpointId`)
    }
    return { outcome: 'version_mismatch', httpStatus, body: { code: payload.code, current } }
  }
  if (httpStatus === 409 && payload.code === MODEL_STEP_CONTINUE_ERROR_CODES.blocked) {
    return {
      outcome: 'blocked',
      httpStatus,
      body: {
        code: payload.code,
        blockedReason: blockedReason(payload.blockedReason, `${label}.blockedReason`),
      },
    }
  }
  return null
}

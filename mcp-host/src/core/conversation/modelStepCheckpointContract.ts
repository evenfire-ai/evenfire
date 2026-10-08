/**
 * Wire contract for the model-step checkpoint (issues #1043 / #1044).
 *
 * When a tool-use turn fails on an eligible provider outage after at least one
 * tool result was confirmed, the Host keeps the turn's tool protocol in a
 * durable checkpoint and offers a "Retry model step" continuation instead of a
 * Resend of the original message. This module is the only coupling between the
 * Host (PR 1) and Desktop (PR 2): the session read exposes
 * `ModelStepCheckpointView`, and the continuation POST answers with one of the
 * `ModelStepContinue*` bodies. Desktop keeps its own copy of these types and
 * checks it against the same vectors in
 * `tests/fixtures/model-step-checkpoint/`.
 *
 * The view never carries the transcript, tool arguments or tool results.
 */

export const MODEL_STEP_CHECKPOINT_STATUSES = [
  'resumable',
  'claimed',
  'blocked',
  'completed',
  'abandoned',
] as const
export type ModelStepCheckpointStatus = (typeof MODEL_STEP_CHECKPOINT_STATUSES)[number]

/** Statuses the session read exposes; `completed` and `abandoned` are never served. */
export const MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES = ['resumable', 'claimed', 'blocked'] as const
export type ModelStepCheckpointVisibleStatus =
  (typeof MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES)[number]

export const MODEL_STEP_BLOCKED_REASONS = [
  'principal_mismatch',
  'host_mismatch',
  'grant_revoked',
  'model_unavailable',
  'budget_exhausted',
  'reference_unavailable',
  /** The bytes of an inline uploaded file expired or are missing (Resend still works). */
  'attachment_expired',
] as const
export type ModelStepBlockedReason = (typeof MODEL_STEP_BLOCKED_REASONS)[number]

export interface ModelStepCheckpointToolCounts {
  confirmed: number
  unknown: number
  notDispatched: number
}

export interface ModelStepCheckpointView {
  checkpointId: string
  /** Increases on every transition; the continuation POST must echo it. */
  version: number
  status: ModelStepCheckpointVisibleStatus
  /** True only when `status === 'resumable'`. */
  retryAvailable: boolean
  originTaskId: string
  /** Present when `status === 'claimed'`. */
  continuationTaskId?: string
  provider: string
  model: string
  /** Present when `status === 'blocked'`. */
  blockedReason?: ModelStepBlockedReason
  tools: ModelStepCheckpointToolCounts
  /** ISO-8601. */
  failedAt: string
  /** ISO-8601. */
  expiresAt: string
}

export interface ModelStepContinueRequest {
  version: number
}

export const MODEL_STEP_CONTINUE_ERROR_CODES = {
  notFound: 'model_step_checkpoint_not_found',
  versionMismatch: 'model_step_checkpoint_version_mismatch',
  blocked: 'model_step_checkpoint_blocked',
} as const
export type ModelStepContinueErrorCode =
  (typeof MODEL_STEP_CONTINUE_ERROR_CODES)[keyof typeof MODEL_STEP_CONTINUE_ERROR_CODES]

/** 202: a continuation is running (new claim, re-claim, or replay of a live claim). */
export interface ModelStepContinueClaimed {
  taskId: string
  checkpointId: string
  status: 'claimed'
  replayed: boolean
}

/** 200: the continuation already completed; replays its task id. */
export interface ModelStepContinueCompleted {
  taskId: string
  checkpointId: string
  status: 'completed'
  replayed: true
}

/** 404 */
export interface ModelStepContinueNotFound {
  code: typeof MODEL_STEP_CONTINUE_ERROR_CODES.notFound
}

/** 409 */
export interface ModelStepContinueVersionMismatch {
  code: typeof MODEL_STEP_CONTINUE_ERROR_CODES.versionMismatch
  current: ModelStepCheckpointView
}

/** 409 */
export interface ModelStepContinueBlocked {
  code: typeof MODEL_STEP_CONTINUE_ERROR_CODES.blocked
  blockedReason: ModelStepBlockedReason
}

export type ModelStepContinueResponse =
  | ModelStepContinueClaimed
  | ModelStepContinueCompleted
  | ModelStepContinueNotFound
  | ModelStepContinueVersionMismatch
  | ModelStepContinueBlocked

/** Runtime route on the Host, behind the same `rpc-proxy` edge guard as `/v1/runtime/messages`. */
export const MODEL_STEP_CONTINUE_RUNTIME_ROUTE =
  '/v1/runtime/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue'

/** Public route on rpc-proxy, forwarded to the Host route above. */
export const MODEL_STEP_CONTINUE_RPC_ROUTE =
  '/api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue'

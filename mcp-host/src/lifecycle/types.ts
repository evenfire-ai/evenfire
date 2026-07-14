/**
 * TaskLifecycle types.
 */
/**
 * MIGRATION NOTE: `TaskStatus` and `QueueStats` are also exported from
 * `../queue/types.ts`. These duplicates are intentional during Phase A (dual-write
 * parity). The queue/types copies will be removed in Phase C when MessageQueue
 * shrinks to a factory-only shim (spec §4.2, §9.3). DO NOT import from
 * `../queue/types` for new code — always import from `./types`.
 */
import type { Attachment } from '../core/types'
import type { TaskError } from '../queue/types'

export type TaskStatus =
  | 'pending'
  | 'processing'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CanonicalReason =
  | 'created'
  | 'dispatched'
  | 'user_requested'
  | 'system_shutdown'
  | 'approval_timeout' // reserved — see spec §3.4
  | 'natural'
  | 'denied_by_user'
  | `error:${string}` // e.g. 'error:LLM_INSUFFICIENT_QUOTA'

export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATES.has(status)
}

/**
 * Legal state transitions. Key = from, value = set of allowed `to`.
 * Anything not in this map → IllegalTransition.
 */
export const LEGAL_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ['pending', new Set<TaskStatus>(['processing', 'cancelled'])],
  ['processing', new Set<TaskStatus>(['waiting_approval', 'completed', 'failed', 'cancelled'])],
  ['waiting_approval', new Set<TaskStatus>(['processing', 'completed', 'cancelled'])],
  ['completed', new Set<TaskStatus>()],
  ['failed', new Set<TaskStatus>()],
  ['cancelled', new Set<TaskStatus>()],
])

export interface Transition {
  from: TaskStatus | null // null on initial register
  to: TaskStatus
  reason: CanonicalReason
  at: Date
}

export interface TaskRecord {
  id: string
  status: TaskStatus
  reason: CanonicalReason | null
  history: readonly Transition[] // capped at MAX_HISTORY_PER_TASK — cast to mutable only inside TaskLifecycle
  /**
   * The sender identity that submitted this task (task.sourceMessage.sender).
   * Null for internal/cron tasks that have no sourceMessage.
   * Used for ownership checks on runtime reads/cancel.
   */
  submittedBy: string | null
  submittedChannelType: string | null
  submittedChannelId: string | null
  createdAt: Date
  dispatchedAt?: Date
  terminalAt?: Date
  error?: TaskError
  response?: string
  attachments?: Attachment[]
}

export const MAX_HISTORY_PER_TASK = 20

export type TransitionOutcome =
  | { kind: 'applied'; from: TaskStatus | null; to: TaskStatus; reason: CanonicalReason }
  | { kind: 'already_terminal'; state: TaskStatus }
  | { kind: 'illegal'; from: TaskStatus; to: TaskStatus }
  | { kind: 'not_found' }

export interface TransitionEvent {
  taskId: string
  from: TaskStatus | null
  to: TaskStatus
  reason: CanonicalReason
  at: Date
  error?: TaskError
  response?: string
  attachments?: Attachment[]
}

export interface TransitionPayload {
  error?: TaskError
  response?: string
  attachments?: Attachment[]
}

export interface QueueStats {
  pending: number
  processing: number
  completed: number
  failed: number
  cancelled: number
  total: number
}

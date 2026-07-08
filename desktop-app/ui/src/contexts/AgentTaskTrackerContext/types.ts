import type { ComposerImageAttachment, ComposerReferenceAttachment, ProgressStep } from '@/uiTypes'
import type { ChatMessageAttachment } from '../../../../src/types'

/**
 * Tracker key — identifies a running task by (agentRef, chatId). A single agent
 * can have one in-flight task per chat; switching chats inside the same agent
 * does not cancel the other chat's task (fire & forget + come back).
 */
export type TaskKey = string

export function makeTaskKey(agentRef: string, chatId: string): TaskKey {
  return `${agentRef}::${chatId}`
}

/**
 * Splits a TaskKey back into its parts. chatId is always a UUID (never contains
 * `::`), so we split on the LAST separator to tolerate an agentRef that itself
 * contains `::`.
 */
export function parseTaskKey(key: string): { agentRef: string; chatId: string } {
  const idx = key.lastIndexOf('::')
  if (idx === -1) return { agentRef: key, chatId: '' }
  return { agentRef: key.slice(0, idx), chatId: key.slice(idx + 2) }
}

export type TaskStatus =
  | 'connecting'
  | 'streaming'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TaskPendingApproval {
  requestId: string
  // P1-1: server-derived displayName only; the raw tool_name never crosses the wire.
  displayName: string
}

/**
 * `source` lets the terminal handler reproduce the pre-D.3 side-effects:
 * - 'reply'         → completed turn with an assistant message.
 * - 'failed'        → server returned a structured error for the turn.
 * - 'result_fetch'  → turn completed but `getTaskResult` threw.
 * - 'stream'        → the progress stream failed (connection timeout, idle
 *                     watchdog, or subscription error) — the task may still be
 *                     running server-side, so we surface an error toast but do
 *                     NOT append an assistant message or offer a retry.
 */
export type TaskTerminalResult =
  | { kind: 'reply'; content: string; attachments?: ChatMessageAttachment[] }
  | {
      kind: 'error'
      source: 'failed' | 'result_fetch' | 'stream'
      message: string
      code?: string
      provider?: string
    }
  | { kind: 'cancelled'; reason?: string }

export interface TaskState {
  taskId: string
  /** The user message that originated this task. */
  userMessageId: string
  status: TaskStatus
  /** epoch ms; used by D.5b to compute the elapsed-time tier. */
  startedAt: number
  /** epoch ms, updated on every SSE event; feeds the idle watchdog. */
  lastEventAt: number
  /** epoch ms when the task suspended on an approval (D.5b nudge freeze). */
  pausedAt?: number
  steps: ProgressStep[]
  currentIteration: number
  llmElapsedMs?: number
  pendingApproval?: TaskPendingApproval
  terminalResult?: TaskTerminalResult
}

export interface TrackerCallbacks {
  /**
   * Fired when a task reaches a terminal state (completed/failed/cancelled).
   * The app uses this to persist the assistant message, push notifications and
   * toasts, then `ack` the key. Not fired automatically by `ack`.
   */
  onTerminal: (key: TaskKey, state: TaskState) => void | Promise<void>
  /** Fired when a task suspends on an approval — dispatches the approval notif. */
  onSuspended?: (key: TaskKey, state: TaskState) => void
  /**
   * Fired when a suspended task receives its first post-approval event (the
   * decision may have been made on any surface — in-chat, notification,
   * another device). The app uses this to settle the per-chat
   * `awaiting_approval` session state back to `processing`.
   */
  onResumed?: (key: TaskKey, state: TaskState) => void
}

/**
 * The original user input behind an in-flight task, kept so a "ghost" terminal
 * (progress stream lost, the task may have died unreported) can offer a
 * one-click Resend that reuses the content (D.5 / AC11). Owned by the coordinator
 * with an explicit lifecycle (B15): set at `attach`/send time, dropped in
 * `release` — a stream-loss on a NON-visible chat no longer destroys the payload
 * of a still-live task (B11).
 */
export interface ResendPayload {
  content: string
  attachments: ComposerImageAttachment[]
  references: ComposerReferenceAttachment[]
}

export interface AttachOptions {
  /** Diagnostic reason for telemetry/logging (`send` | `rejoin` | `reconcile`). */
  reason?: string
  /**
   * Arm the 5s connect-timeout. Defaults to `true` for a fresh send and `false`
   * for a rejoin (a re-open under the same network stress that dropped the stream
   * legitimately needs longer — the 30s watchdog is the real liveness guard).
   */
  armConnTimeout?: boolean
}

export interface AgentTaskTracker {
  start(key: TaskKey, taskId: string, userMessageId: string): void
  /**
   * Coordinator entry point (spec-v2 §4.2): the single path to open a stream for
   * both a fresh send and a rejoin. Idempotent by `(key, taskId)` — a second
   * `attach` for the same pair is a no-op; an `attach` of a NEW taskId over an
   * entry of a different taskId releases the old one first (explicit release, no
   * clobber). Returns `false` only when a rejoin is blocked by the bounded
   * re-rejoin cap (parity with `rejoinIfRunning`); a fresh send always returns
   * `true`.
   */
  attach(key: TaskKey, taskId: string, anchorMessageId: string, opts?: AttachOptions): boolean
  /** Total teardown for a key (SSE unsub, timers, entry, resend payload). Alias-safe with `ack`. */
  release(key: TaskKey): void
  /** Release every tracked key — logout / team-switch / unmount (R-F13, GAP-N4). */
  releaseAll(): void
  /** Stash the Resend payload for a task id (coordinator-owned lifecycle, B15). */
  setResend(taskId: string, payload: ResendPayload): void
  /** Read (without removing) the Resend payload for a task id. */
  getResend(taskId: string): ResendPayload | undefined
  /**
   * Rejoin a still-running task. Returns `true` when a rejoin actually started,
   * `false` when the bounded re-rejoin cap (`MAX_REJOIN_ATTEMPTS`) was hit and the
   * call no-op'd. A `false` on the active chat must surface a recovery affordance
   * (offline banner) rather than leave a frozen `processing` stepper (P1-stall).
   */
  rejoinIfRunning(key: TaskKey, taskId: string, userMessageId?: string): boolean
  /** Clear the bounded re-rejoin counter (deliberate user-initiated reconcile). */
  resetRejoinAttempts(key: TaskKey): void
  get(key: TaskKey): TaskState | undefined
  subscribe(key: TaskKey, fn: (state: TaskState) => void): () => void
  ack(key: TaskKey): void
  cancel(key: TaskKey): Promise<void>
  setCallbacks(callbacks: TrackerCallbacks): void
}

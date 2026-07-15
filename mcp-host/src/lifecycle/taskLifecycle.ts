/**
 * TaskLifecycle — single-writer service for task state transitions.
 */
import { EventEmitter } from 'events'
import type { Task } from '../queue/types'
import {
  CanonicalReason,
  LEGAL_TRANSITIONS,
  MAX_HISTORY_PER_TASK,
  QueueStats,
  TaskRecord,
  TaskStatus,
  Transition,
  TransitionEvent,
  TransitionOutcome,
  TransitionPayload,
  isTerminal,
} from './types'

/**
 * TTL for terminal task records. Matches REPORTER_TTL_MS in
 * sseProgressReporter.ts. Records are evicted lazily on the next
 * state-touching call (get/getStatus/isTerminal/getStats) after
 * the TTL has elapsed.
 */
const TERMINAL_RECORD_TTL_MS = 5 * 60 * 1000

export class TaskLifecycle extends EventEmitter {
  private records = new Map<string, TaskRecord>()

  /**
   * Timestamp of the last completed stale-record scan (epoch ms).
   * Used by cleanupStaleRecords() to debounce O(N) scans.
   */
  private _lastCleanupAt = 0

  /** Minimum interval between stale-record scans. */
  private static readonly CLEANUP_DEBOUNCE_MS = 30_000

  constructor() {
    super()
    // M10: One subscriber per active task is expected under the dispatcher
    // pattern (spec §4.4). Disable Node's default 10-listener warning so it
    // doesn't false-positive during bursts of concurrent tasks.
    this.setMaxListeners(0)
  }

  /**
   * Create a TaskRecord with status='pending' and emit transition(null → pending, 'created').
   * Idempotent: registering an existing id is a no-op (no record overwrite, no emission).
   * Under the single-admission contract (MessageQueue.admit is the only
   * production registration point), a call that lands here is a genuine
   * duplicate delivery — log it truthfully and loudly with the prior state.
   */
  register(task: Task): void {
    const existing = this.records.get(task.id)
    if (existing) {
      console.warn(
        `[TaskLifecycle] duplicate registration suppressed — id already registered: ${task.id} (status=${existing.status})`
      )
      return
    }
    const now = new Date()
    const record: TaskRecord = {
      id: task.id,
      status: 'pending',
      reason: null,
      history: [{ from: null, to: 'pending', reason: 'created', at: now }],
      submittedBy: task.sourceMessage?.sender ?? null,
      submittedChannelType: task.sourceMessage?.channelType ?? null,
      submittedChannelId: task.sourceMessage?.channelId ?? null,
      createdAt: now,
    }
    this.records.set(task.id, record)
    this.emitTransition({
      taskId: task.id,
      from: null,
      to: 'pending',
      reason: 'created',
      at: now,
    })
  }

  /**
   * Atomic transition. Eligibility check + mutation + emit in one sync block.
   * Node single-threaded → no locks needed.
   */
  transition(
    taskId: string,
    to: TaskStatus,
    reason: CanonicalReason,
    payload?: TransitionPayload
  ): TransitionOutcome {
    const record = this.records.get(taskId)
    if (!record) {
      return { kind: 'not_found' }
    }

    const from = record.status

    if (isTerminal(from)) {
      return { kind: 'already_terminal', state: from }
    }

    const allowed = LEGAL_TRANSITIONS.get(from)
    if (!allowed || !allowed.has(to)) {
      return { kind: 'illegal', from, to }
    }

    // Apply mutation
    const now = new Date()
    record.status = to
    record.reason = reason
    if (to === 'processing' && !record.dispatchedAt) {
      record.dispatchedAt = now
    }
    if (isTerminal(to)) {
      record.terminalAt = now
    }
    if (payload?.error !== undefined) record.error = payload.error
    if (payload?.response !== undefined) record.response = payload.response
    if (payload?.attachments !== undefined) record.attachments = payload.attachments

    // Append history (capped). `history` is readonly in the public type; cast to mutable here.
    const historyMut = record.history as Transition[]
    historyMut.push({ from, to, reason, at: now })
    if (historyMut.length > MAX_HISTORY_PER_TASK) {
      historyMut.shift()
    }

    // Emit
    this.emitTransition({
      taskId: taskId,
      from,
      to,
      reason,
      at: now,
      error: payload?.error,
      response: payload?.response,
      attachments: payload?.attachments,
    })

    return { kind: 'applied', from, to, reason }
  }

  /**
   * Shutdown drain — cancel every non-terminal task with reason='system_shutdown'.
   * See spec §5.7. If a future feature needs bulk-cancel with a different reason,
   * add a separate method rather than widening this one.
   */
  drainNonTerminal(): number {
    let drained = 0
    for (const record of this.records.values()) {
      if (!isTerminal(record.status)) {
        const outcome = this.transition(record.id, 'cancelled', 'system_shutdown')
        if (outcome.kind === 'applied') drained++
      }
    }
    return drained
  }

  get(taskId: string): TaskRecord | null {
    this.cleanupStaleRecords()
    return this.records.get(taskId) ?? null
  }

  isTerminal(taskId: string): boolean {
    this.cleanupStaleRecords()
    const r = this.records.get(taskId)
    return r ? isTerminal(r.status) : false
  }

  getStatus(taskId: string): TaskStatus | null {
    this.cleanupStaleRecords()
    return this.records.get(taskId)?.status ?? null
  }

  getStats(): QueueStats {
    this.cleanupStaleRecords()
    const stats: QueueStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    }
    for (const r of this.records.values()) {
      stats.total++
      if (r.status === 'pending') stats.pending++
      if (r.status === 'processing') stats.processing++
      if (r.status === 'waiting_approval') stats.processing++ // waiting_approval counts as in-flight
      if (r.status === 'completed') stats.completed++
      if (r.status === 'failed') stats.failed++
      if (r.status === 'cancelled') stats.cancelled++
    }
    return stats
  }

  /**
   * Evict terminal records whose terminalAt exceeds TERMINAL_RECORD_TTL_MS.
   * Runs lazily in read paths (get/getStatus/isTerminal/getStats) — NEVER
   * in transition(), preserving Invariant I2 atomicity.
   * Emits 'record:evicted' for each evicted record so subscribers
   * (e.g. MessageQueue) can mirror the cleanup.
   *
   * Debounced: at 500+ concurrent tasks with dashboard polling plus
   * dispatch-path getStatus calls, running an O(N) scan on every read
   * adds ~250ms/sec of CPU overhead. The 30s debounce batches all scan
   * work into at most 2 passes per minute. Eviction precision drops from
   * "exact 5min" to "5min–5.5min" — still strictly bounded by the TTL.
   */
  private cleanupStaleRecords(): void {
    const now = Date.now()
    if (now - this._lastCleanupAt < TaskLifecycle.CLEANUP_DEBOUNCE_MS) return
    this._lastCleanupAt = now

    for (const [id, record] of this.records) {
      if (record.terminalAt && now - record.terminalAt.getTime() > TERMINAL_RECORD_TTL_MS) {
        this.records.delete(id)
        // Notify subscribers (MessageQueue shim uses this to evict its taskInstanceIndex)
        this.emit('record:evicted', { taskId: id })
      }
    }
  }

  private emitTransition(event: TransitionEvent): void {
    console.log(
      JSON.stringify({
        event: 'transition_emitted',
        taskId: event.taskId,
        from: event.from,
        to: event.to,
        reason: event.reason,
        at: event.at.toISOString(),
      })
    )
    this.emit('transition', event)
  }
}

import { EventEmitter } from 'events'
import type { BudgetVerdict } from '../budget/types'
import type { TaskLifecycle } from '../lifecycle/taskLifecycle'
import type { Task } from '../queue/types'

export interface SessionProcessorConfig {
  maxConcurrent: number
  /**
   * Execute a task. Returns true if the session should stay locked
   * (e.g., task is awaiting approval), false if the session is free.
   */
  executor: (task: Task) => Promise<boolean>
  /** Required for check-before-dispatch tombstone pattern (spec §4.3, §5.1). */
  lifecycle: TaskLifecycle
  /**
   * P1 token budgets (§5.1) — optional pre-task budget check, injected ONLY
   * when `CLERUM_BUDGETS_ENABLED` is on. Runs after the lifecycle transition to
   * 'processing' and before `executor`. The callback is itself fail-open and
   * never throws under normal operation; when undefined the dispatch path is
   * bit-identical to pre-budget behavior (no extra microtask).
   */
  checkTaskBudget?: (task: Task) => Promise<BudgetVerdict>
  /**
   * P1 token budgets (§5.3) — deliver a budget denial to the user. Wired to
   * `AgentStateMachine.handleBudgetDenied`, which routes through the canonical
   * task-failure path (responseCallback + queue.failTask → lifecycle 'failed' +
   * SSE terminal + queue 'task:failed' listener cleanup). Injected together with
   * `checkTaskBudget`.
   */
  onBudgetDenied?: (task: Task, reason?: string) => void
}

/**
 * Per-session task queues with concurrency-limited processing.
 *
 * - Tasks within the same session are serialized (FIFO)
 * - Tasks across different sessions run concurrently (up to maxConcurrent)
 * - FIFO scheduling across ready sessions by insertion order
 */
export class SessionProcessor extends EventEmitter {
  private sessionQueues = new Map<string, Task[]>()
  private activeSessions = new Set<string>()
  private suspendedSessions = new Set<string>()
  private config: SessionProcessorConfig

  constructor(config: SessionProcessorConfig) {
    super()
    this.config = config
  }

  get activeCount(): number {
    return this.activeSessions.size
  }

  get pendingSessionCount(): number {
    let count = 0
    for (const [key, queue] of this.sessionQueues) {
      if (queue.length > 0 && !this.activeSessions.has(key) && !this.suspendedSessions.has(key)) {
        count++
      }
    }
    return count
  }

  /**
   * Enqueue a task for a session. Processing starts automatically
   * if capacity is available.
   */
  enqueue(sessionKey: string, task: Task): void {
    let queue = this.sessionQueues.get(sessionKey)
    if (!queue) {
      queue = []
      this.sessionQueues.set(sessionKey, queue)
    }
    queue.push(task)
    this.emit('task:enqueued', { sessionKey, task })
    this.tryProcessNext()
  }

  /**
   * Try to start processing the next available session.
   * Called after enqueue and after a task completes.
   */
  private tryProcessNext(): void {
    if (this.activeSessions.size >= this.config.maxConcurrent) {
      return
    }

    const readySession = this.pickNextReadySession()
    if (!readySession) {
      return
    }

    const queue = this.sessionQueues.get(readySession)!
    const task = queue.shift()!

    if (queue.length === 0) {
      this.sessionQueues.delete(readySession)
    }

    // Check-before-dispatch (spec §4.3, §5.1 tombstone pattern).
    // Lifecycle may already say 'cancelled' if user cancelled between enqueue
    // and dispatch. `transition(pending → processing)` returns already_terminal
    // in that case; we skip dispatch and try the next ready session.
    const transitionOutcome = this.config.lifecycle.transition(task.id, 'processing', 'dispatched')
    if (transitionOutcome.kind !== 'applied') {
      this.emit('task:skipped', { sessionKey: readySession, task, outcome: transitionOutcome })
      // Try next ready session (another session may have work waiting)
      this.tryProcessNext()
      return
    }

    this.activeSessions.add(readySession)
    this.emit('task:started', { sessionKey: readySession, task })

    // When no budget check is wired (flag off), this runs the executor
    // synchronously — no await happens before dispatch, so behavior matches the
    // pre-budget path exactly.
    void this.dispatchWithBudgetCheck(readySession, task)
  }

  /**
   * P1 token budgets (§5.1) — gate the executor behind a one-shot budget check.
   * The check is fail-open (`checkTaskBudget` resolves `{allowed:true}` on any
   * failure), so a denial here means a real budget verdict, never a transport
   * error.
   */
  private async dispatchWithBudgetCheck(sessionKey: string, task: Task): Promise<void> {
    if (this.config.checkTaskBudget) {
      let verdict: BudgetVerdict
      try {
        verdict = await this.config.checkTaskBudget(task)
      } catch (err) {
        // Defense in depth — the callback is already fail-open, but a budget
        // check must never block a task on an unexpected throw (§0.2).
        console.warn('[SessionProcessor] budget check threw; failing open', {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        })
        verdict = { allowed: true }
      }
      // Informational ops signal (does NOT affect allow/deny). control-api
      // reports any `(provider, model)` used this period without an active price
      // — cost budgets sub-count those as $0, so a missing price row silently
      // understates spend. Log it regardless of the verdict so ops can add the
      // price before the drift grows.
      this.logUnpricedUsage(task, verdict)
      if (!verdict.allowed) {
        this.denyForBudget(sessionKey, task, verdict.reason)
        return
      }
      // Persist the verdict for the P2 per-task brake (max_task_amount). The
      // brake itself lands in P2; P1 only makes the fields reachable.
      task.budgetVerdict = verdict
    }
    this.runExecutor(sessionKey, task)
  }

  /**
   * P1 token budgets — surface `(provider, model)` pairs that had usage this
   * period but no active price (control-api sub-counts them as $0). Purely
   * informational: it never gates the task, only warns for ops visibility.
   */
  private logUnpricedUsage(task: Task, verdict: BudgetVerdict): void {
    if (!verdict.unpriced?.length) return
    console.warn('[SessionProcessor] budget_unpriced_usage', {
      taskId: task.id,
      source: task.source,
      pairs: verdict.unpriced,
    })
  }

  /**
   * Fail a task that a budget denied. The user-facing delivery is delegated to
   * `onBudgetDenied` (→ `AgentStateMachine.handleBudgetDenied`) so it flows
   * through the exact same path as any other task failure. If that callback is
   * not wired (defense in depth — it is injected together with
   * `checkTaskBudget`), drive the lifecycle terminal directly so the task is
   * never stranded in 'processing'.
   */
  private denyForBudget(sessionKey: string, task: Task, reason?: string): void {
    this.activeSessions.delete(sessionKey)
    this.emit('task:budget_denied', { taskId: task.id, reason })
    if (this.config.onBudgetDenied) {
      this.config.onBudgetDenied(task, reason)
    } else {
      this.config.lifecycle.transition(task.id, 'failed', 'error:BUDGET_EXCEEDED')
    }
    this.tryProcessNext()
  }

  /** Dispatch the executor and wire its completion/suspension/failure handling. */
  private runExecutor(sessionKey: string, task: Task): void {
    this.config
      .executor(task)
      .then(suspended => {
        // TaskLifecycle is now authoritative — removed task.status === 'cancelled' band-aid (spec §4.3)
        if (suspended) {
          // Task is awaiting approval — keep session locked so no new tasks
          // can corrupt the conversation. Move from active to suspended.
          this.activeSessions.delete(sessionKey)
          this.suspendedSessions.add(sessionKey)
          this.emit('task:suspended', { sessionKey, task })
        } else {
          this.activeSessions.delete(sessionKey)
          this.emit('task:completed', { sessionKey, task })
        }
        this.tryProcessNext()
      })
      .catch(error => {
        this.activeSessions.delete(sessionKey)
        // TaskLifecycle is now authoritative — removed task.status === 'cancelled' band-aid (spec §4.3)
        console.error(`[SessionProcessor] Task ${task.id} failed in session ${sessionKey}:`, error)
        this.emit('task:failed', { sessionKey, task, error })
        this.tryProcessNext()
      })
  }

  /**
   * Release a suspended session (called when approval resolves).
   * Allows queued tasks for that session to proceed.
   */
  releaseSuspendedSession(sessionKey: string): void {
    this.suspendedSessions.delete(sessionKey)
    this.tryProcessNext()
  }

  /**
   * Pick the next session that has pending work and isn't active or suspended.
   */
  private pickNextReadySession(): string | undefined {
    for (const [key, queue] of this.sessionQueues) {
      if (queue.length > 0 && !this.activeSessions.has(key) && !this.suspendedSessions.has(key)) {
        return key
      }
    }
    return undefined
  }
}

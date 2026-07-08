/**
 * MessageQueue — factory-only shim (Phase C).
 *
 * State has moved entirely to TaskLifecycle. This class now:
 *   1. Creates Task objects via three factory methods (unchanged API).
 *   2. Maintains taskInstanceIndex for Task-object lookup (getTask).
 *   3. Keeps a pendingQueue[] for ordering and lifecycle registration of
 *      tasks enqueued outside messageHandler (e.g. cronScheduler.executeJob).
 *   4. Delegates getStats() to TaskLifecycle.
 *   5. Subscribes to TaskLifecycle.on('transition') and re-emits legacy
 *      Node events so ActivityHub (eventWiring.ts) and cron cleanup
 *      (main.ts) continue to receive events unchanged.
 *
 * Deleted: queue[], processing, completed[], failed[], taskIndex,
 *   peek, isEmpty, isProcessing, getCurrentTask, getPendingTasks,
 *   getCompletedTasks, getFailedTasks, clearHistory, sortQueue,
 *   trimCompletedHistory, trimFailedHistory.
 *
 * See docs/superpowers/specs/2026-04-20-task-cancel-v2-design.md §4.2, §9.3.
 */
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { CronJob } from '../agent/types'
import type { TaskLifecycle } from '../lifecycle/taskLifecycle'
import type { TransitionEvent } from '../lifecycle/types'
import { IncomingMessage } from '../server'
import {
  QueueEvent,
  QueueEventType,
  QueueStats,
  Task,
  TaskError,
  TaskPriority,
  TaskResponsePayload,
} from './types'

/**
 * Priority weights for sorting (higher = more urgent).
 * Used by the pendingQueue for the legacy dispatch path.
 */
const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

/**
 * MessageQueue — factory + event-forwarding shim.
 */
export class MessageQueue extends EventEmitter {
  /** Ordering queue for the legacy non-SessionProcessor dispatch path. */
  private pendingQueue: Task[] = []
  private maxQueueSize: number

  /** Task-object index: provides getTask() without requiring TaskRecord to hold the full Task. */
  private taskInstanceIndex = new Map<string, Task>()

  private lifecycle: TaskLifecycle | null = null

  constructor(_maxCompletedHistory: number = 100, maxQueueSize: number = 1000) {
    super()
    this.maxQueueSize = maxQueueSize
  }

  /**
   * Wire TaskLifecycle for stats delegation and event forwarding.
   * Re-entrant: safe to call multiple times or with a different lifecycle instance.
   * Prior listeners are detached before new ones are attached so they don't accumulate
   * (PR-193 review #4).
   */
  setLifecycle(lifecycle: TaskLifecycle): void {
    // Detach prior listeners before re-attaching (idempotent on repeated calls;
    // also correctly re-points between two different lifecycle instances).
    if (this.lifecycle) {
      this.lifecycle.off('transition', this.handleLifecycleTransition)
      this.lifecycle.off('record:evicted', this.handleRecordEvicted)
    }

    this.lifecycle = lifecycle
    lifecycle.on('transition', this.handleLifecycleTransition)

    // Mirror TaskLifecycle's TTL eviction so Task references don't leak.
    // Promoted to a named bound method so .off() can remove it (PR-193 review #4).
    lifecycle.on('record:evicted', this.handleRecordEvicted)
  }

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  createTaskFromMessage(
    message: IncomingMessage,
    responseCallback?: (payload: TaskResponsePayload) => Promise<void>,
    priority: TaskPriority = 'normal'
  ): Task {
    const task: Task = {
      id: uuidv4(),
      source: 'channel',
      sourceMessage: message,
      priority,
      status: 'pending',
      conversationHistory: [
        {
          role: 'user',
          content: message.content,
          timestamp: new Date(message.timestamp),
        },
      ],
      createdAt: new Date(),
      responseCallback,
    }
    this.taskInstanceIndex.set(task.id, task)
    return task
  }

  createTaskFromCron(
    cronJobId: string,
    content: string,
    origin?: CronJob['origin'],
    priority: TaskPriority = 'normal'
  ): Task {
    const task: Task = {
      id: uuidv4(),
      source: 'cron',
      cronJobId,
      sourceMessage: origin
        ? {
            channelType: origin.channelType,
            channelId: origin.channelId,
            sender: origin.sender,
            content: '',
            timestamp: new Date().toISOString(),
            messageId: `cron-${cronJobId}-${Date.now()}`,
            hostRef: '',
          }
        : undefined,
      priority,
      status: 'pending',
      conversationHistory: [
        {
          role: 'system',
          content: `Scheduled task triggered: ${cronJobId}`,
          timestamp: new Date(),
        },
        {
          role: 'user',
          content,
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
    }
    this.taskInstanceIndex.set(task.id, task)
    return task
  }

  createInternalTask(content: string, priority: TaskPriority = 'low'): Task {
    const task: Task = {
      id: uuidv4(),
      source: 'internal',
      priority,
      status: 'pending',
      conversationHistory: [
        {
          role: 'system',
          content: 'Internal system task',
          timestamp: new Date(),
        },
        {
          role: 'user',
          content,
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
    }
    this.taskInstanceIndex.set(task.id, task)
    return task
  }

  // ---------------------------------------------------------------------------
  // Enqueue shim — registers lifecycle and maintains pendingQueue ordering.
  // Production callers: messageHandler (channel), cronScheduler.executeJob.
  // SessionProcessor is the sole execution engine; dequeue() is test-only.
  // ---------------------------------------------------------------------------

  /**
   * Register a task as pending. Adds to the ordering queue for legacy dispatch.
   * Lifecycle registration (lifecycle.register) MUST have been called before
   * this — Invariant I12 in messageHandler.ts ensures that for channel tasks.
   * For cron tasks, this method calls lifecycle.register internally.
   */
  enqueue(task: Task): boolean {
    if (this.pendingQueue.length >= this.maxQueueSize) {
      console.warn(`[Queue] Task ${task.id} rejected: queue full (${this.maxQueueSize})`)
      this.emitEvent('queue:full', task)
      return false
    }

    // eslint-disable-next-line no-restricted-syntax -- Phase C shim: TaskLifecycle is the authoritative writer; this mirrors task.status for legacy consumers (spec §4.2)
    task.status = 'pending'
    this.pendingQueue.push(task)
    this.pendingQueue.sort((a, b) => {
      const diff = PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority]
      return diff !== 0 ? diff : a.createdAt.getTime() - b.createdAt.getTime()
    })

    // For cron tasks, lifecycle.register hasn't been called yet (no messageHandler).
    // Idempotent: TaskLifecycle.register() is a no-op if already registered.
    this.lifecycle?.register(task)

    console.log(
      `[Queue] Task ${task.id} added (source: ${task.source}, priority: ${task.priority})`
    )
    // task:added is forwarded from lifecycle transition (null→pending) via handleLifecycleTransition.
    // Emit it directly here too for callers that set up lifecycle AFTER enqueue (e.g. tests).
    if (!this.lifecycle) {
      this.emitEvent('task:added', task)
    }
    return true
  }

  /**
   * Dequeue the next pending task for the legacy (non-SessionProcessor) dispatch path.
   * Transitions lifecycle to 'processing' and updates task.status.
   */
  dequeue(): Task | null {
    if (this.pendingQueue.length === 0) return null

    const task = this.pendingQueue.shift()!
    // eslint-disable-next-line no-restricted-syntax -- Phase C shim: TaskLifecycle is the authoritative writer; this mirrors task.status for legacy consumers (spec §4.2)
    task.status = 'processing'
    task.startedAt = new Date()
    this.lifecycle?.transition(task.id, 'processing', 'dispatched')

    console.log(`[Queue] Task ${task.id} dequeued for processing`)
    // task:started is forwarded from lifecycle transition via handleLifecycleTransition.
    if (!this.lifecycle) {
      this.emitEvent('task:started', task)
    }

    if (this.pendingQueue.length === 0) {
      this.emitEvent('queue:empty')
    }

    return task
  }

  /**
   * Mark a task completed. Transitions lifecycle; updates task.status.
   * Called by stateMachine.executeTask onComplete callback.
   */
  completeTask(task: Task): void {
    // eslint-disable-next-line no-restricted-syntax -- Phase C shim: TaskLifecycle is the authoritative writer; this mirrors task.status for legacy consumers (spec §4.2)
    task.status = 'completed'
    task.completedAt = new Date()
    this.lifecycle?.transition(task.id, 'completed', 'natural', {
      response: task.result?.response,
    })

    console.log(`[Queue] Task ${task.id} completed`)
    // task:completed forwarded via handleLifecycleTransition.
    if (!this.lifecycle) {
      this.emitEvent('task:completed', task)
    }

    if (this.pendingQueue.length === 0) {
      this.emitEvent('queue:drained')
    }
  }

  /**
   * Mark a task failed. No retries — LLM SDK handles retries internally.
   * Called by stateMachine.handleTaskFailure.
   */
  failTask(task: Task, error: TaskError): void {
    // eslint-disable-next-line no-restricted-syntax -- Phase C shim: TaskLifecycle is the authoritative writer; this mirrors task.status for legacy consumers (spec §4.2)
    task.status = 'failed'
    task.error = error
    task.completedAt = new Date()
    this.lifecycle?.transition(task.id, 'failed', `error:${error.code}`, { error })

    console.log(`[Queue] Task ${task.id} failed: ${error.code}`)
    // task:failed forwarded via handleLifecycleTransition.
    if (!this.lifecycle) {
      this.emitEvent('task:failed', task)
    }
  }

  /**
   * Check if there are any pending tasks in the ordering queue.
   * Used by stateMachine.start/resume (legacy dispatch path).
   */
  isEmpty(): boolean {
    if (this.lifecycle) {
      return this.lifecycle.getStats().pending === 0
    }
    return this.pendingQueue.length === 0
  }

  // ---------------------------------------------------------------------------
  // Task lookup
  // ---------------------------------------------------------------------------

  /**
   * Look up a Task object by ID. Returns null if not found.
   * TaskLifecycle stores TaskRecord (status/history); this returns the full Task.
   */
  getTask(taskId: string): Task | null {
    return this.taskInstanceIndex.get(taskId) ?? null
  }

  // ---------------------------------------------------------------------------
  // Stats (delegated to lifecycle)
  // ---------------------------------------------------------------------------

  /**
   * Queue statistics. Delegates to lifecycle when wired, falls back to local state.
   * Legacy shape: 5 fields (no 'cancelled'). Consumers like /v1/runtime/status
   * expect this shape.
   */
  getStats(): QueueStats {
    if (this.lifecycle) {
      const s = this.lifecycle.getStats()
      return {
        pending: s.pending,
        processing: s.processing,
        completed: s.completed,
        failed: s.failed,
        total: s.total,
      }
    }
    return {
      pending: this.pendingQueue.length,
      processing: 0,
      completed: 0,
      failed: 0,
      total: this.pendingQueue.length,
    }
  }

  // ---------------------------------------------------------------------------
  // Event forwarding (C.1)
  // ---------------------------------------------------------------------------

  /** Bound handler for TaskLifecycle 'record:evicted' — named so .off() can remove it (PR-193 review #4). */
  private handleRecordEvicted = (ev: { taskId: string }): void => {
    this.taskInstanceIndex.delete(ev.taskId)
  }

  private handleLifecycleTransition = (ev: TransitionEvent): void => {
    const task = this.taskInstanceIndex.get(ev.taskId)
    if (!task) return

    if (ev.from === null && ev.to === 'pending') {
      this.emitEvent('task:added', task)
    } else if (ev.to === 'processing' && ev.reason === 'dispatched') {
      this.emitEvent('task:started', task)
    } else if (ev.to === 'completed') {
      this.emitEvent('task:completed', task)
    } else if (ev.to === 'failed') {
      this.emitEvent('task:failed', task)
    } else if (ev.to === 'cancelled') {
      this.emitEvent('task:cancelled', task)
    }
    // Intermediate transitions (processing ↔ waiting_approval) not forwarded.
  }

  private emitEvent(type: QueueEventType, task?: Task): void {
    const event: QueueEvent = { type, task, timestamp: new Date() }
    this.emit(type, event)
    this.emit('event', event)
  }
}

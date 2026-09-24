import type { TaskExecutionBudgetSnapshot } from '../core/types'
import { VISUAL_INPUT_LIMITS, VisualInputBudget } from '../visualInput/policy'

export class TaskLimitError extends Error {
  constructor(
    readonly code: 'TASK_DURATION_LIMIT' | 'TASK_ITERATION_LIMIT',
    message: string
  ) {
    super(message)
    this.name = 'TaskLimitError'
  }
}

export function parseTaskExecutionBudget(value: unknown): TaskExecutionBudgetSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid task execution budget')
  const snapshot = value as TaskExecutionBudgetSnapshot
  if (
    !Number.isFinite(snapshot.elapsedActiveMs) ||
    snapshot.elapsedActiveMs < 0 ||
    !Number.isSafeInteger(snapshot.iterationsUsed) ||
    snapshot.iterationsUsed < 0 ||
    !Number.isSafeInteger(snapshot.durationMs) ||
    snapshot.durationMs <= 0 ||
    snapshot.durationMs > 2_147_483_647 ||
    !Number.isSafeInteger(snapshot.maxIterations) ||
    snapshot.maxIterations <= 0 ||
    (snapshot.visualReadBytes !== undefined &&
      (!Number.isSafeInteger(snapshot.visualReadBytes) ||
        snapshot.visualReadBytes < 0 ||
        snapshot.visualReadBytes > VISUAL_INPUT_LIMITS.readBytesPerTurn))
  ) {
    throw new Error('Invalid task execution budget')
  }
  return {
    elapsedActiveMs: snapshot.elapsedActiveMs,
    iterationsUsed: snapshot.iterationsUsed,
    durationMs: snapshot.durationMs,
    maxIterations: snapshot.maxIterations,
    ...(snapshot.visualReadBytes !== undefined
      ? { visualReadBytes: snapshot.visualReadBytes }
      : {}),
  }
}

/** One active-time and iteration budget, retained across approval suspensions. */
export class TaskExecutionBudget {
  visualInputs = new VisualInputBudget()
  private elapsedActiveMs = 0
  private iterationsUsed = 0
  private segmentStart: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    public durationMs: number,
    public maxIterations: number,
    private readonly clock: () => number = () => performance.now()
  ) {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      durationMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxIterations) ||
      maxIterations <= 0
    ) {
      throw new Error('Invalid task execution limits')
    }
  }
  restore(value: unknown): void {
    if (this.segmentStart !== undefined) throw new Error('Cannot restore an active budget')
    const snapshot = parseTaskExecutionBudget(value)
    this.durationMs = Math.min(this.durationMs, snapshot.durationMs)
    this.maxIterations = Math.min(this.maxIterations, snapshot.maxIterations)
    this.elapsedActiveMs = snapshot.elapsedActiveMs
    this.iterationsUsed = snapshot.iterationsUsed
    this.visualInputs.close()
    this.visualInputs = this.visualInputs.resume(snapshot.visualReadBytes ?? 0)
  }
  get remainingIterations(): number {
    return Math.max(0, this.maxIterations - this.iterationsUsed)
  }
  private elapsed(): number {
    return (
      this.elapsedActiveMs +
      (this.segmentStart === undefined ? 0 : Math.max(0, this.clock() - this.segmentStart))
    )
  }
  assertTime(): void {
    if (this.elapsed() >= this.durationMs) throw this.timeoutError()
  }
  timeoutError(): TaskLimitError {
    return new TaskLimitError(
      'TASK_DURATION_LIMIT',
      `Task stopped before completion: active execution reached ${this.durationMs}ms. Continuation requires a new budget.`
    )
  }
  start(controller: AbortController): void {
    controller.signal.throwIfAborted()
    this.assertTime()
    if (this.segmentStart !== undefined) throw new Error('Task budget already active')
    if (this.visualInputs.isClosed) {
      this.visualInputs = this.visualInputs.resume()
    }
    this.segmentStart = this.clock()
    this.timer = setTimeout(
      () => controller.abort(this.timeoutError()),
      this.durationMs - this.elapsed()
    )
    this.timer.unref?.()
  }
  consumeIteration(): void {
    this.assertTime()
    if (this.remainingIterations === 0)
      throw new TaskLimitError(
        'TASK_ITERATION_LIMIT',
        'Task stopped before completion: its iteration budget is exhausted.'
      )
    this.iterationsUsed++
  }
  pause(): TaskExecutionBudgetSnapshot {
    this.elapsedActiveMs = this.elapsed()
    this.segmentStart = undefined
    clearTimeout(this.timer)
    this.timer = undefined
    this.visualInputs.close()
    return {
      elapsedActiveMs: this.elapsedActiveMs,
      iterationsUsed: this.iterationsUsed,
      durationMs: this.durationMs,
      maxIterations: this.maxIterations,
      ...(this.visualInputs.readBytes > 0 ? { visualReadBytes: this.visualInputs.readBytes } : {}),
    }
  }
}

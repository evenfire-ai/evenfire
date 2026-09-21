import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TaskExecutionBudget,
  TaskLimitError,
  parseTaskExecutionBudget,
} from '../taskExecutionBudget'

afterEach(() => vi.useRealTimers())
describe('TaskExecutionBudget', () => {
  it('retains consumption across approvals and restart, excluding approval wait', async () => {
    vi.useFakeTimers()
    let now = 0
    const first = new TaskExecutionBudget(100, 2, () => now)
    first.start(new AbortController())
    first.consumeIteration()
    now = 40
    const saved = first.pause()
    now = 10000
    const restored = new TaskExecutionBudget(200, 20, () => now)
    restored.restore(saved)
    expect(restored.durationMs).toBe(100)
    expect(restored.maxIterations).toBe(2)
    const controller = new AbortController()
    restored.start(controller)
    restored.consumeIteration()
    expect(restored.remainingIterations).toBe(0)
    expect(() => restored.consumeIteration()).toThrow(TaskLimitError)
    await vi.advanceTimersByTimeAsync(59)
    expect(controller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.signal.reason.code).toBe('TASK_DURATION_LIMIT')
    restored.pause()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears its timer on successful completion', async () => {
    vi.useFakeTimers()
    const budget = new TaskExecutionBudget(100, 2)
    const controller = new AbortController()
    budget.start(controller)
    budget.pause()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.signal.aborted).toBe(false)
  })
  it('refuses exhausted restored time before work starts', () => {
    const budget = new TaskExecutionBudget(100, 2)
    budget.restore({ elapsedActiveMs: 100, iterationsUsed: 1, durationMs: 100, maxIterations: 2 })
    expect(() => budget.start(new AbortController())).toThrow(TaskLimitError)
  })
  it.each([
    null,
    {},
    { elapsedActiveMs: -1, iterationsUsed: 0 },
    { elapsedActiveMs: 0, iterationsUsed: NaN },
  ])('rejects invalid durable accounting %s', value => {
    expect(() => parseTaskExecutionBudget(value)).toThrow('Invalid task execution budget')
  })
})

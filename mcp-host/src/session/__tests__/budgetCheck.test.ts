import { describe, expect, it, vi } from 'vitest'
import type { BudgetVerdict } from '../../budget/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task } from '../../queue/types'
import { SessionProcessor } from '../sessionProcessor'

function mkTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    source: 'internal',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
    ...overrides,
  } as Task
}

function registered(lc: TaskLifecycle, task: Task): Task {
  lc.register(task)
  return task
}

describe('SessionProcessor — P1 token budget check', () => {
  it('flag off (no checkTaskBudget): dispatches normally, no verdict persisted', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc })

    const task = registered(lc, mkTask('t1'))
    const started = new Promise<void>(r => sp.once('task:started', () => r()))
    sp.enqueue('s1', task)
    await started

    expect(executor).toHaveBeenCalledWith(task)
    expect(task.budgetVerdict).toBeUndefined()
  })

  it('allowed verdict: dispatches the executor and persists the verdict for P2', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const verdict: BudgetVerdict = {
      allowed: true,
      maxTaskTokens: 4000,
      maxTaskCost: 2,
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: 'USD' },
    }
    const checkTaskBudget = vi.fn().mockResolvedValue(verdict)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const completed = new Promise<void>(r => sp.once('task:completed', () => r()))
    sp.enqueue('s1', task)
    await completed

    expect(checkTaskBudget).toHaveBeenCalledWith(task)
    expect(executor).toHaveBeenCalledWith(task)
    expect(task.budgetVerdict).toEqual(verdict)
  })

  it('denied verdict: delegates delivery to onBudgetDenied, emits event, does NOT dispatch', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const checkTaskBudget = vi
      .fn()
      .mockResolvedValue({ allowed: false, reason: 'monthly_cost_exceeded' })
    const onBudgetDenied = vi.fn()
    const sp = new SessionProcessor({
      maxConcurrent: 1,
      executor,
      lifecycle: lc,
      checkTaskBudget,
      onBudgetDenied,
    })

    const task = registered(lc, mkTask('t1'))

    const denied = new Promise<{ taskId: string; reason?: string }>(r =>
      sp.once('task:budget_denied', e => r(e))
    )
    sp.enqueue('s1', task)
    const event = await denied
    await Promise.resolve()

    expect(event).toEqual({ taskId: 't1', reason: 'monthly_cost_exceeded' })
    expect(executor).not.toHaveBeenCalled()
    expect(onBudgetDenied).toHaveBeenCalledWith(task, 'monthly_cost_exceeded')
    expect(task.budgetVerdict).toBeUndefined()
  })

  it('denied verdict without onBudgetDenied: drives the lifecycle terminal (fallback)', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const checkTaskBudget = vi.fn().mockResolvedValue({ allowed: false, reason: 'limit' })
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const denied = new Promise<void>(r => sp.once('task:budget_denied', () => r()))
    sp.enqueue('s1', task)
    await denied
    await Promise.resolve()

    expect(executor).not.toHaveBeenCalled()
    expect(lc.getStatus('t1')).toBe('failed')
  })

  it('denial frees the session so the next queued task dispatches', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    // First task denied, second allowed.
    const checkTaskBudget = vi
      .fn()
      .mockResolvedValueOnce({ allowed: false, reason: 'limit' })
      .mockResolvedValueOnce({ allowed: true })
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const denied = registered(lc, mkTask('tdenied'))
    const good = registered(lc, mkTask('tgood'))

    const goodDone = new Promise<void>(r =>
      sp.on('task:completed', e => {
        if (e.task.id === 'tgood') r()
      })
    )
    sp.enqueue('s-denied', denied)
    sp.enqueue('s-good', good)
    await goodDone

    expect(executor).toHaveBeenCalledWith(good)
    expect(executor).not.toHaveBeenCalledWith(denied)
  })

  it('unpriced usage: warns budget_unpriced_usage with the pairs (does not block dispatch)', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const verdict: BudgetVerdict = {
      allowed: true,
      unpriced: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      ],
    }
    const checkTaskBudget = vi.fn().mockResolvedValue(verdict)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const completed = new Promise<void>(r => sp.once('task:completed', () => r()))
    sp.enqueue('s1', task)
    await completed

    expect(executor).toHaveBeenCalledWith(task)
    expect(warn).toHaveBeenCalledWith(
      '[SessionProcessor] budget_unpriced_usage',
      expect.objectContaining({ taskId: 't1', source: 'internal', pairs: verdict.unpriced })
    )
    warn.mockRestore()
  })

  it('no unpriced field: does not warn budget_unpriced_usage', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const checkTaskBudget = vi.fn().mockResolvedValue({ allowed: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const completed = new Promise<void>(r => sp.once('task:completed', () => r()))
    sp.enqueue('s1', task)
    await completed

    expect(warn).not.toHaveBeenCalledWith(
      '[SessionProcessor] budget_unpriced_usage',
      expect.anything()
    )
    warn.mockRestore()
  })

  it('empty unpriced array: does not warn budget_unpriced_usage', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const checkTaskBudget = vi.fn().mockResolvedValue({ allowed: true, unpriced: [] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const completed = new Promise<void>(r => sp.once('task:completed', () => r()))
    sp.enqueue('s1', task)
    await completed

    expect(warn).not.toHaveBeenCalledWith(
      '[SessionProcessor] budget_unpriced_usage',
      expect.anything()
    )
    warn.mockRestore()
  })

  it('check throwing fails open: dispatches the executor anyway', async () => {
    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const checkTaskBudget = vi.fn().mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc, checkTaskBudget })

    const task = registered(lc, mkTask('t1'))
    const completed = new Promise<void>(r => sp.once('task:completed', () => r()))
    sp.enqueue('s1', task)
    await completed

    expect(executor).toHaveBeenCalledWith(task)
    warn.mockRestore()
  })
})

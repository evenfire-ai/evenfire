import { describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task } from '../../queue/types'
import { SessionProcessor } from '../sessionProcessor'

function mkTask(id: string): Task {
  return {
    id,
    source: 'internal',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
  } as Task
}

describe('SessionProcessor check-before-dispatch', () => {
  it('skips task if TaskLifecycle is terminal before dispatch (tombstone)', async () => {
    const lc = new TaskLifecycle()
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({
      maxConcurrent: 1,
      executor: executorFn,
      lifecycle: lc,
    })

    const task = mkTask('t1')
    lc.register(task)
    lc.transition('t1', 'cancelled', 'user_requested') // terminal BEFORE enqueue

    const skipped = new Promise<void>(r => sp.once('task:skipped', () => r()))
    sp.enqueue('s1', task)
    await skipped

    expect(executorFn).not.toHaveBeenCalled()
  })

  it('dispatches normally when lifecycle is still pending', async () => {
    const lc = new TaskLifecycle()
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({
      maxConcurrent: 1,
      executor: executorFn,
      lifecycle: lc,
    })

    const task = mkTask('t1')
    lc.register(task)

    const started = new Promise<void>(r => sp.once('task:started', () => r()))
    sp.enqueue('s1', task)
    await started

    expect(executorFn).toHaveBeenCalledWith(task)
  })

  it('writes lifecycle status=processing on successful dispatch', async () => {
    const lc = new TaskLifecycle()
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({
      maxConcurrent: 1,
      executor: executorFn,
      lifecycle: lc,
    })

    const task = mkTask('t2')
    lc.register(task)
    const started = new Promise<void>(r => sp.once('task:started', () => r()))
    sp.enqueue('s2', task)
    await started

    expect(lc.getStatus('t2')).toBe('processing')
  })

  it('skipped task still allows the next session queue entry to dispatch', async () => {
    const lc = new TaskLifecycle()
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({
      maxConcurrent: 1,
      executor: executorFn,
      lifecycle: lc,
    })

    const cancelledTask = mkTask('tcanceled')
    const goodTask = mkTask('tgood')
    lc.register(cancelledTask)
    lc.register(goodTask)
    lc.transition('tcanceled', 'cancelled', 'user_requested')

    const started = new Promise<void>(r => sp.once('task:started', () => r()))
    sp.enqueue('s3', cancelledTask)
    sp.enqueue('s4', goodTask)
    await started

    expect(executorFn).toHaveBeenCalledWith(goodTask)
    expect(executorFn).not.toHaveBeenCalledWith(cancelledTask)
  })
})

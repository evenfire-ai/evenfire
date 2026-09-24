import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task } from '../../queue/types'
import { SessionProcessor } from '../sessionProcessor'

function createTask(id: string, sender: string = 'user-1'): Task {
  return {
    id,
    source: 'channel',
    sourceMessage: {
      sender,
      content: `msg-${id}`,
      channelType: 'telegram',
      channelId: 'chat-1',
      messageId: `mid-${id}`,
      timestamp: new Date().toISOString(),
      hostRef: 'test',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: `msg-${id}`, timestamp: new Date() }],
    createdAt: new Date(),
  }
}

describe('SessionProcessor', () => {
  let processor: SessionProcessor
  let executedTasks: string[]
  let executor: (task: Task) => Promise<boolean>
  let lifecycle: TaskLifecycle

  beforeEach(() => {
    executedTasks = []
    lifecycle = new TaskLifecycle()
    executor = async (task: Task): Promise<boolean> => {
      executedTasks.push(task.id)
      return false
    }
    processor = new SessionProcessor({ maxConcurrent: 3, executor, lifecycle })
  })

  it('should process a single task', async () => {
    const lc = new TaskLifecycle()
    const done = new Promise<void>(resolve => {
      executor = async (task): Promise<boolean> => {
        executedTasks.push(task.id)
        resolve()
        return false
      }
      processor = new SessionProcessor({ maxConcurrent: 3, executor, lifecycle: lc })
    })

    const task = createTask('t1')
    lc.register(task)
    processor.enqueue('session-1', task)
    await done

    expect(executedTasks).toEqual(['t1'])
  })

  it('should serialize tasks within the same session', async () => {
    const lc = new TaskLifecycle()
    const order: string[] = []
    let resolveT2!: () => void
    const t2Done = new Promise<void>(r => {
      resolveT2 = r
    })

    executor = async (task): Promise<boolean> => {
      order.push(`start:${task.id}`)
      if (task.id === 't1') {
        await new Promise(r => setTimeout(r, 50))
      }
      order.push(`end:${task.id}`)
      if (task.id === 't2') resolveT2()
      return false
    }
    processor = new SessionProcessor({ maxConcurrent: 3, executor, lifecycle: lc })

    const t1 = createTask('t1')
    const t2 = createTask('t2')
    lc.register(t1)
    lc.register(t2)
    processor.enqueue('session-1', t1)
    processor.enqueue('session-1', t2)

    await t2Done

    expect(order).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2'])
  })

  it('should run different sessions concurrently', async () => {
    const lc = new TaskLifecycle()
    const running: string[] = []
    let maxConcurrent = 0
    let completed = 0
    let resolveAll!: () => void
    const allDone = new Promise<void>(r => {
      resolveAll = r
    })

    executor = async (task): Promise<boolean> => {
      running.push(task.id)
      maxConcurrent = Math.max(maxConcurrent, running.length)
      await new Promise(r => setTimeout(r, 50))
      running.splice(running.indexOf(task.id), 1)
      completed++
      if (completed === 2) resolveAll()
      return false
    }
    processor = new SessionProcessor({ maxConcurrent: 3, executor, lifecycle: lc })

    const t1 = createTask('t1', 'alice')
    const t2 = createTask('t2', 'bob')
    lc.register(t1)
    lc.register(t2)
    processor.enqueue('session-1', t1)
    processor.enqueue('session-2', t2)

    await allDone

    expect(maxConcurrent).toBe(2)
  })

  it('should respect maxConcurrent limit', async () => {
    const lc = new TaskLifecycle()
    const running: string[] = []
    let maxConcurrent = 0
    let completed = 0
    let resolveAll!: () => void
    const allDone = new Promise<void>(r => {
      resolveAll = r
    })

    executor = async (task): Promise<boolean> => {
      running.push(task.id)
      maxConcurrent = Math.max(maxConcurrent, running.length)
      await new Promise(r => setTimeout(r, 30))
      running.splice(running.indexOf(task.id), 1)
      completed++
      if (completed === 4) resolveAll()
      return false
    }
    processor = new SessionProcessor({ maxConcurrent: 2, executor, lifecycle: lc })

    const tasks = ['t1', 't2', 't3', 't4'].map(id => createTask(id))
    tasks.forEach(t => lc.register(t))
    processor.enqueue('s1', tasks[0])
    processor.enqueue('s2', tasks[1])
    processor.enqueue('s3', tasks[2])
    processor.enqueue('s4', tasks[3])

    await allDone

    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(completed).toBe(4)
  })

  it('should continue processing after task failure', async () => {
    const lc = new TaskLifecycle()
    let completed = 0
    let resolveAll!: () => void
    const allDone = new Promise<void>(r => {
      resolveAll = r
    })

    executor = async (task): Promise<boolean> => {
      if (task.id === 't1') throw new Error('boom')
      completed++
      if (completed === 1) resolveAll()
      return false
    }
    processor = new SessionProcessor({ maxConcurrent: 3, executor, lifecycle: lc })

    const t1 = createTask('t1')
    const t2 = createTask('t2')
    lc.register(t1)
    lc.register(t2)
    processor.enqueue('s1', t1)
    processor.enqueue('s1', t2)

    await allDone

    expect(completed).toBe(1)
  })

  it('should report active session count', () => {
    expect(processor.activeCount).toBe(0)
    expect(processor.pendingSessionCount).toBe(0)
  })
})

describe('SessionProcessor dispatch spacing', () => {
  afterEach(() => vi.useRealTimers())
  it('spaces dispatches without blocking concurrency or resetting the pending timer', async () => {
    vi.useFakeTimers()
    const lifecycle = new TaskLifecycle()
    const started: string[] = []
    const processor = new SessionProcessor({
      maxConcurrent: 3,
      taskDelayMs: 100,
      lifecycle,
      executor: async task => {
        started.push(task.id)
        return false
      },
    })
    for (const id of ['a', 'b']) {
      const task = createTask(id)
      lifecycle.register(task)
      processor.enqueue(id, task)
    }
    expect(started).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(50)
    const task = createTask('c')
    lifecycle.register(task)
    processor.enqueue('c', task)
    await vi.advanceTimersByTimeAsync(50)
    expect(started).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(100)
    expect(started).toEqual(['a', 'b', 'c'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not dispatch a task cancelled during the delay', async () => {
    vi.useFakeTimers()
    const lifecycle = new TaskLifecycle()
    const execute = vi.fn(async () => false)
    const processor = new SessionProcessor({
      maxConcurrent: 2,
      taskDelayMs: 100,
      lifecycle,
      executor: execute,
    })
    const a = createTask('a'),
      b = createTask('b')
    lifecycle.register(a)
    lifecycle.register(b)
    processor.enqueue('a', a)
    processor.enqueue('b', b)
    lifecycle.transition(b.id, 'cancelled', 'user_requested')
    await vi.advanceTimersByTimeAsync(100)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

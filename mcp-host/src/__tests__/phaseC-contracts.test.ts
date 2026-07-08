import { describe, expect, it } from 'vitest'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { MessageQueue } from '../queue/messageQueue'

describe('Phase C contract: activity event sequence preserved', () => {
  it('pending → processing → completed emits task:added → task:started → task:completed in order', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const seq: string[] = []
    mq.on('task:added', () => seq.push('added'))
    mq.on('task:started', () => seq.push('started'))
    mq.on('task:completed', () => seq.push('completed'))
    mq.on('task:failed', () => seq.push('failed'))
    mq.on('task:cancelled', () => seq.push('cancelled'))

    const task = mq.createInternalTask('test')
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')
    lc.transition(task.id, 'completed', 'natural')

    expect(seq).toEqual(['added', 'started', 'completed'])
  })

  it('cancelled sequence is task:added → task:started → task:cancelled', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const seq: string[] = []
    mq.on('task:added', () => seq.push('added'))
    mq.on('task:started', () => seq.push('started'))
    mq.on('task:cancelled', () => seq.push('cancelled'))

    const task = mq.createInternalTask('test')
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')
    lc.transition(task.id, 'cancelled', 'user_requested')

    expect(seq).toEqual(['added', 'started', 'cancelled'])
  })

  it('failed sequence is task:added → task:started → task:failed', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const seq: string[] = []
    mq.on('task:added', () => seq.push('added'))
    mq.on('task:started', () => seq.push('started'))
    mq.on('task:failed', () => seq.push('failed'))

    const task = mq.createInternalTask('test')
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')
    lc.transition(task.id, 'failed', 'error:TEST' as any, {
      error: { code: 'TEST', message: 'test', retryable: false, provider: 'unknown' },
    })

    expect(seq).toEqual(['added', 'started', 'failed'])
  })

  it('intermediate processing ↔ waiting_approval transitions do NOT re-fire legacy events', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const task = mq.createInternalTask('test')
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')

    const events: string[] = []
    mq.on('task:added', () => events.push('added'))
    mq.on('task:started', () => events.push('started'))
    mq.on('task:completed', () => events.push('completed'))

    lc.transition(task.id, 'waiting_approval', 'natural')
    lc.transition(task.id, 'processing', 'natural')

    expect(events).toHaveLength(0) // no re-fire of legacy events for intermediate transitions
  })

  it('cancel-from-pending emits task:added → task:cancelled (no task:started)', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const seq: string[] = []
    mq.on('task:added', () => seq.push('added'))
    mq.on('task:started', () => seq.push('started'))
    mq.on('task:cancelled', () => seq.push('cancelled'))

    const task = mq.createInternalTask('test')
    lc.register(task)
    // cancel BEFORE dispatch (pending → cancelled, tombstone pattern)
    lc.transition(task.id, 'cancelled', 'user_requested')

    expect(seq).toEqual(['added', 'cancelled'])
  })
})

describe('Phase C contract: /v1/runtime/status shape preserved', () => {
  it('getStats returns the legacy 5-field shape {pending, processing, completed, failed, total}', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const task = mq.createInternalTask('test')
    lc.register(task)

    const stats = mq.getStats()

    expect(stats).toHaveProperty('pending')
    expect(stats).toHaveProperty('processing')
    expect(stats).toHaveProperty('completed')
    expect(stats).toHaveProperty('failed')
    expect(stats).toHaveProperty('total')
    expect(Object.keys(stats).sort()).toEqual([
      'completed',
      'failed',
      'pending',
      'processing',
      'total',
    ])
    expect(stats.pending).toBe(1)
  })

  it('transitioning a task updates getStats counts correctly', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    // Create 3 tasks at different states
    const t1 = mq.createInternalTask('pending one')
    lc.register(t1)

    const t2 = mq.createInternalTask('processing one')
    lc.register(t2)
    lc.transition(t2.id, 'processing', 'dispatched')

    const t3 = mq.createInternalTask('completed one')
    lc.register(t3)
    lc.transition(t3.id, 'processing', 'dispatched')
    lc.transition(t3.id, 'completed', 'natural')

    const stats = mq.getStats()
    expect(stats.pending).toBe(1)
    expect(stats.processing).toBe(1)
    expect(stats.completed).toBe(1)
    expect(stats.failed).toBe(0)
    expect(stats.total).toBe(3)
  })

  it('getStats returns zero-shape when no lifecycle is wired (defensive)', () => {
    const mq = new MessageQueue()
    const stats = mq.getStats()
    expect(stats).toEqual({ pending: 0, processing: 0, completed: 0, failed: 0, total: 0 })
  })
})

describe('Phase C contract: getTask preserves Task-object lookup', () => {
  it('createTaskFromMessage + lookup returns the same Task instance', () => {
    const mq = new MessageQueue()
    const msg: any = {
      channelType: 'telegram',
      channelId: 'c1',
      sender: 'u1',
      content: 'hi',
      timestamp: new Date().toISOString(),
      messageId: 'm1',
      hostRef: 'h1',
    }
    const task = mq.createTaskFromMessage(msg)
    expect(mq.getTask(task.id)).toBe(task)
  })

  it('getTask on unknown id returns null', () => {
    const mq = new MessageQueue()
    expect(mq.getTask('nonexistent')).toBeNull()
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../queue/types'
import { TaskLifecycle } from '../taskLifecycle'
import { TaskStatus } from '../types'

function mkTask(id = 't-1'): Task {
  return {
    id,
    source: 'internal',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
  } as Task
}

describe('TaskLifecycle.register', () => {
  let lc: TaskLifecycle

  beforeEach(() => {
    lc = new TaskLifecycle()
  })

  it('creates a record with status=pending', () => {
    lc.register(mkTask('t1'))
    expect(lc.getStatus('t1')).toBe('pending')
  })

  it('emits transition(null → pending, reason=created)', () => {
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.register(mkTask('t1'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      taskId: 't1',
      from: null,
      to: 'pending',
      reason: 'created',
    })
  })

  it('is idempotent on duplicate register (no emission, no overwrite)', () => {
    lc.register(mkTask('t1'))
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.register(mkTask('t1'))
    expect(events).toHaveLength(0)
    expect(lc.getStatus('t1')).toBe('pending')
  })

  it('history contains the initial transition after register', () => {
    lc.register(mkTask('t1'))
    const record = lc.get('t1')!
    expect(record.history).toHaveLength(1)
    expect(record.history[0]).toMatchObject({ from: null, to: 'pending', reason: 'created' })
  })
})

describe('TaskLifecycle.transition — legal transitions', () => {
  let lc: TaskLifecycle
  beforeEach(() => {
    lc = new TaskLifecycle()
    lc.register(mkTask('t1'))
  })

  it.each<[TaskStatus, TaskStatus, string]>([
    ['pending', 'processing', 'dispatched'],
    ['pending', 'cancelled', 'user_requested'],
    ['processing', 'waiting_approval', 'natural'],
    ['processing', 'completed', 'natural'],
    ['processing', 'failed', 'error:LLM_API_CALL_FAILED'],
    ['processing', 'cancelled', 'user_requested'],
    ['waiting_approval', 'processing', 'natural'],
    ['waiting_approval', 'completed', 'denied_by_user'],
    ['waiting_approval', 'cancelled', 'user_requested'],
  ])('legal: %s → %s', (from, to, reason) => {
    if (from !== 'pending') {
      setupState(lc, 't1', from)
    }
    const outcome = lc.transition('t1', to, reason as any)
    expect(outcome.kind).toBe('applied')
    expect(lc.getStatus('t1')).toBe(to)
  })
})

describe('TaskLifecycle.transition — illegal transitions', () => {
  let lc: TaskLifecycle
  beforeEach(() => {
    lc = new TaskLifecycle()
    lc.register(mkTask('t1'))
  })

  it('returns illegal for pending → completed', () => {
    const outcome = lc.transition('t1', 'completed', 'natural')
    expect(outcome.kind).toBe('illegal')
    expect(lc.getStatus('t1')).toBe('pending')
  })

  it('returns illegal for pending → waiting_approval', () => {
    const outcome = lc.transition('t1', 'waiting_approval', 'natural')
    expect(outcome.kind).toBe('illegal')
  })

  it('returns illegal for processing → pending', () => {
    lc.transition('t1', 'processing', 'dispatched')
    const outcome = lc.transition('t1', 'pending', 'natural')
    expect(outcome.kind).toBe('illegal')
  })
})

describe('TaskLifecycle.transition — terminal finality', () => {
  let lc: TaskLifecycle
  beforeEach(() => {
    lc = new TaskLifecycle()
    lc.register(mkTask('t1'))
  })

  it('returns already_terminal after completed', () => {
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'completed', 'natural')
    const outcome = lc.transition('t1', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('already_terminal')
  })

  it('returns already_terminal after cancelled', () => {
    lc.transition('t1', 'cancelled', 'user_requested')
    const outcome = lc.transition('t1', 'completed', 'natural')
    expect(outcome.kind).toBe('already_terminal')
  })

  it('returns already_terminal for double cancel (idempotent)', () => {
    lc.transition('t1', 'cancelled', 'user_requested')
    const outcome = lc.transition('t1', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('already_terminal')
  })
})

describe('TaskLifecycle.transition — not found', () => {
  it('returns not_found for unregistered id', () => {
    const lc = new TaskLifecycle()
    const outcome = lc.transition('unknown', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('not_found')
  })

  it('does not emit on NotFound', () => {
    const lc = new TaskLifecycle()
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.transition('unknown', 'cancelled', 'user_requested')
    expect(events).toHaveLength(0)
  })
})

describe('TaskLifecycle.transition — emission', () => {
  let lc: TaskLifecycle
  beforeEach(() => {
    lc = new TaskLifecycle()
    lc.register(mkTask('t1'))
  })

  it('emits on Applied', () => {
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.transition('t1', 'processing', 'dispatched')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from: 'pending', to: 'processing', reason: 'dispatched' })
  })

  it('does not emit on AlreadyTerminal', () => {
    lc.transition('t1', 'cancelled', 'user_requested')
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.transition('t1', 'cancelled', 'user_requested')
    expect(events).toHaveLength(0)
  })

  it('does not emit on Illegal', () => {
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.transition('t1', 'completed', 'natural')
    expect(events).toHaveLength(0)
  })
})

describe('TaskLifecycle.drainNonTerminal', () => {
  it('cancels all non-terminal tasks with system_shutdown', () => {
    const lc = new TaskLifecycle()
    lc.register(mkTask('a'))
    lc.register(mkTask('b'))
    lc.register(mkTask('c'))
    lc.transition('a', 'processing', 'dispatched')
    lc.transition('b', 'cancelled', 'user_requested')
    const drained = lc.drainNonTerminal()
    expect(drained).toBe(2)
    expect(lc.getStatus('a')).toBe('cancelled')
    expect(lc.getStatus('b')).toBe('cancelled')
    expect(lc.getStatus('c')).toBe('cancelled')
  })
})

function setupState(lc: TaskLifecycle, id: string, target: TaskStatus): void {
  if (target === 'pending') return
  lc.transition(id, 'processing', 'dispatched')
  if (target === 'processing') return
  if (target === 'waiting_approval') {
    lc.transition(id, 'waiting_approval', 'natural')
    return
  }
  if (target === 'completed') {
    lc.transition(id, 'completed', 'natural')
    return
  }
  if (target === 'failed') {
    lc.transition(id, 'failed', 'error:TEST' as any)
    return
  }
  if (target === 'cancelled') {
    lc.transition(id, 'cancelled', 'user_requested')
    return
  }
}

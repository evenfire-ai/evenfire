import { describe, expect, it } from 'vitest'
import { TaskLifecycle } from '../taskLifecycle'
import { LEGAL_TRANSITIONS, MAX_HISTORY_PER_TASK, TERMINAL_STATES, TaskStatus } from '../types'
import { buildTask, collectEvents } from './helpers'

describe('Invariant I2 — Atomicity', () => {
  it('100 concurrent transitions produce exactly 1 Applied, 99 AlreadyTerminal', async () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    const results = await Promise.all(
      Array.from({ length: 100 }, () => lc.transition('t1', 'cancelled', 'user_requested'))
    )
    const applied = results.filter(r => r.kind === 'applied').length
    const alreadyTerminal = results.filter(r => r.kind === 'already_terminal').length
    expect(applied).toBe(1)
    expect(alreadyTerminal).toBe(99)
  })
})

describe('Invariant I3 — Terminal finality', () => {
  it.each<TaskStatus>(['completed', 'failed', 'cancelled'])(
    'no transitions leave %s',
    terminalState => {
      const lc = new TaskLifecycle()
      lc.register(buildTask({ id: 't1' }))
      // Drive to terminal state
      lc.transition('t1', 'processing', 'dispatched')
      if (terminalState === 'completed') lc.transition('t1', 'completed', 'natural')
      if (terminalState === 'failed') lc.transition('t1', 'failed', 'error:TEST' as any)
      if (terminalState === 'cancelled') lc.transition('t1', 'cancelled', 'user_requested')

      const targets: TaskStatus[] = [
        'pending',
        'processing',
        'waiting_approval',
        'completed',
        'failed',
        'cancelled',
      ]
      for (const to of targets) {
        const outcome = lc.transition('t1', to, 'natural')
        expect(outcome.kind).toBe('already_terminal')
      }
    }
  )
})

describe('Invariant — Silent AlreadyTerminal', () => {
  it('10 redundant cancels produce 0 subscriber notifications', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    lc.transition('t1', 'cancelled', 'user_requested')
    const events = collectEvents(lc)
    for (let i = 0; i < 10; i++) {
      lc.transition('t1', 'cancelled', 'user_requested')
    }
    expect(events).toHaveLength(0)
  })
})

describe('Invariant — Legal transitions only', () => {
  it('every pair not in LEGAL_TRANSITIONS returns illegal (or already_terminal if from is terminal)', () => {
    const states: TaskStatus[] = [
      'pending',
      'processing',
      'waiting_approval',
      'completed',
      'failed',
      'cancelled',
    ]
    for (const from of states) {
      for (const to of states) {
        const lc = new TaskLifecycle()
        lc.register(buildTask({ id: 't1' }))
        // Drive to `from` via legal transitions
        if (from === 'processing') lc.transition('t1', 'processing', 'dispatched')
        if (from === 'waiting_approval') {
          lc.transition('t1', 'processing', 'dispatched')
          lc.transition('t1', 'waiting_approval', 'natural')
        }
        if (from === 'completed') {
          lc.transition('t1', 'processing', 'dispatched')
          lc.transition('t1', 'completed', 'natural')
        }
        if (from === 'failed') {
          lc.transition('t1', 'processing', 'dispatched')
          lc.transition('t1', 'failed', 'error:TEST' as any)
        }
        if (from === 'cancelled') lc.transition('t1', 'cancelled', 'user_requested')

        const outcome = lc.transition('t1', to, 'natural')
        const isLegal = LEGAL_TRANSITIONS.get(from)?.has(to) ?? false
        const fromIsTerminal = TERMINAL_STATES.has(from)
        if (fromIsTerminal) {
          expect(outcome.kind).toBe('already_terminal')
        } else if (isLegal) {
          expect(outcome.kind).toBe('applied')
        } else {
          expect(outcome.kind).toBe('illegal')
        }
      }
    }
  })
})

describe('Invariant I7 — History-state agreement', () => {
  it('last history entry.to equals current status', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'waiting_approval', 'natural')
    lc.transition('t1', 'cancelled', 'user_requested')
    const record = lc.get('t1')!
    const lastHistory = record.history[record.history.length - 1]
    expect(lastHistory.to).toBe(record.status)
    expect(record.status).toBe('cancelled')
  })

  it('history is capped at MAX_HISTORY_PER_TASK', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    lc.transition('t1', 'processing', 'dispatched')
    for (let i = 0; i < MAX_HISTORY_PER_TASK + 5; i++) {
      if (i % 2 === 0) lc.transition('t1', 'waiting_approval', 'natural')
      else lc.transition('t1', 'processing', 'natural')
    }
    const record = lc.get('t1')!
    expect(record.history.length).toBeLessThanOrEqual(MAX_HISTORY_PER_TASK)
  })
})

describe('Invariant I11 — Subscribers exception-safe (contract documentation)', () => {
  it('a throwing subscriber halts subsequent subscribers in the same emit — subscribers MUST wrap', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    const fired: string[] = []
    lc.on('transition', () => {
      throw new Error('subscriber boom')
    })
    lc.on('transition', () => {
      fired.push('second-fired')
    })
    // Node's default EventEmitter halts on thrown. This test documents the contract:
    // subscribers MUST NOT throw. Compliant subscribers wrap their work.
    expect(() => lc.transition('t1', 'cancelled', 'user_requested')).toThrow('subscriber boom')
    expect(fired).toHaveLength(0)
  })

  it('wrapped subscribers are exception-safe — demonstrates the compliant pattern', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't2' }))
    const fired: string[] = []
    lc.on('transition', () => {
      try {
        throw new Error('wrapped boom')
      } catch {
        /* swallow */
      }
    })
    lc.on('transition', () => {
      fired.push('second-fired')
    })
    lc.transition('t2', 'cancelled', 'user_requested')
    expect(fired).toEqual(['second-fired'])
  })
})

describe('Invariant I12 — Register before enqueue', () => {
  it('transition on unregistered taskId returns not_found', () => {
    const lc = new TaskLifecycle()
    const outcome = lc.transition('never-registered', 'processing', 'dispatched')
    expect(outcome.kind).toBe('not_found')
  })
})

describe('Invariant I13 — Register idempotent', () => {
  it('second register on same id is a silent no-op', () => {
    const lc = new TaskLifecycle()
    const events = collectEvents(lc)
    lc.register(buildTask({ id: 't1' }))
    lc.register(buildTask({ id: 't1' }))
    expect(events).toHaveLength(1)
    expect(lc.getStatus('t1')).toBe('pending')
  })
})

describe('Invariant — Empty-string response preserved (from A.3 review IMP-1)', () => {
  it('transition with empty-string response persists it to the record', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't1' }))
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'completed', 'natural', { response: '' })
    const record = lc.get('t1')!
    expect(record.response).toBe('')
  })
})

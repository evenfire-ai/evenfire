import { describe, expect, it, vi } from 'vitest'
import { SessionProcessor } from '../../session/sessionProcessor'
import { TaskLifecycle } from '../taskLifecycle'
import { buildTask } from './helpers'

/**
 * Each test is named after the bug from the 2026-04-16 e2e investigation.
 * These stay in the suite forever — see spec §7.5.
 */
describe('2026-04-16 e2e regressions — must never recur', () => {
  it('BUG-1: cancel on task in SessionProcessor queue does not leave executor running', async () => {
    const lc = new TaskLifecycle()
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor: executorFn, lifecycle: lc })

    const task = buildTask({ id: 't-bug1' })
    lc.register(task)

    // Cancel BEFORE enqueue — tombstone pattern: lifecycle already 'cancelled'
    // when SessionProcessor's tryProcessNext runs the check-before-dispatch.
    lc.transition('t-bug1', 'cancelled', 'user_requested')

    const skipped = new Promise<void>(r => sp.once('task:skipped', () => r()))
    sp.enqueue('s1', task)
    await skipped

    expect(executorFn).not.toHaveBeenCalled()
    expect(lc.getStatus('t-bug1')).toBe('cancelled')
  })

  it('BUG-2: cancel produces exactly one terminal event (no phantom polling required)', () => {
    const lc = new TaskLifecycle()
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))

    lc.register(buildTask({ id: 't-bug2' }))
    lc.transition('t-bug2', 'processing', 'dispatched')
    lc.transition('t-bug2', 'cancelled', 'user_requested')

    const cancelled = events.filter(e => e.to === 'cancelled')
    expect(cancelled).toHaveLength(1)
  })

  it('BUG-3: lifecycle emits for subscribers attached before the transition fires', () => {
    // Late-subscribe replay is an SseProgressReporter concern, not TaskLifecycle.
    // This test asserts the contract: once transitioned, there is exactly one transition
    // event to replay, not zero and not more.
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't-bug3' }))
    lc.transition('t-bug3', 'processing', 'dispatched')

    // Attach subscriber BEFORE the cancel
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))
    lc.transition('t-bug3', 'cancelled', 'user_requested')

    expect(events.filter(e => e.to === 'cancelled')).toHaveLength(1)
  })

  it('BUG-4: AbortSignal fires on transition(cancelled) via subscriber', () => {
    const lc = new TaskLifecycle()
    const taskId = 't-bug4'
    const ac = new AbortController()
    const activeExecutors = new Map<string, any>([
      [
        taskId,
        { abort: () => ac.abort(), signal: ac.signal, pendingApproval: undefined, sourceTask: {} },
      ],
    ])

    lc.on('transition', ev => {
      if (ev.to !== 'cancelled') return
      const ex = activeExecutors.get(ev.taskId)
      try {
        ex?.abort()
      } catch {
        /* I11 */
      }
    })

    lc.register(buildTask({ id: taskId }))
    lc.transition(taskId, 'processing', 'dispatched')
    lc.transition(taskId, 'cancelled', 'user_requested')

    expect(ac.signal.aborted).toBe(true)
  })

  it('BUG-5: double-click cancel produces exactly one terminal event', () => {
    const lc = new TaskLifecycle()
    const events: any[] = []
    lc.on('transition', ev => events.push(ev))

    lc.register(buildTask({ id: 't-bug5' }))
    lc.transition('t-bug5', 'processing', 'dispatched')

    lc.transition('t-bug5', 'cancelled', 'user_requested') // click 1
    lc.transition('t-bug5', 'cancelled', 'user_requested') // click 2

    expect(events.filter(e => e.to === 'cancelled')).toHaveLength(1)
  })

  it('BUG-6: cancel during waiting_approval produces no denial chat bubble', () => {
    // The state-level guarantee: NO `to=completed` transition fires on the cancel path.
    // Cancel ≠ deny. Deny (which would fire to=completed with reason=denied_by_user) is
    // initiated by a separate user action, not by the cancel flow.
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't-bug6' }))
    lc.transition('t-bug6', 'processing', 'dispatched')
    lc.transition('t-bug6', 'waiting_approval', 'natural')

    const completedEvents: any[] = []
    lc.on('transition', ev => {
      if (ev.to === 'completed') completedEvents.push(ev)
    })

    lc.transition('t-bug6', 'cancelled', 'user_requested')

    expect(completedEvents).toHaveLength(0)
    expect(lc.getStatus('t-bug6')).toBe('cancelled')
  })
})

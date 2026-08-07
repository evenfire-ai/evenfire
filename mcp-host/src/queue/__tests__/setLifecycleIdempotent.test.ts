/**
 * Regression tests for PR-193 review #4: MessageQueue.setLifecycle is re-entrant.
 *
 * Verifies that calling setLifecycle more than once (same lifecycle or a different one)
 * does not accumulate listeners on 'transition' or 'record:evicted'.
 */
import { describe, expect, it } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../messageQueue'

describe('PR-193 review #4: MessageQueue.setLifecycle is re-entrant', () => {
  it('calling setLifecycle twice leaves only one transition listener and one record:evicted listener', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()

    mq.setLifecycle(lc)
    const transitionCountAfterFirst = lc.listenerCount('transition')
    const evictedCountAfterFirst = lc.listenerCount('record:evicted')

    mq.setLifecycle(lc) // Re-attach — should NOT accumulate

    expect(lc.listenerCount('transition')).toBe(transitionCountAfterFirst)
    expect(lc.listenerCount('record:evicted')).toBe(evictedCountAfterFirst)
  })

  it('calling setLifecycle with a different lifecycle detaches from the old one', () => {
    const lcOld = new TaskLifecycle()
    const lcNew = new TaskLifecycle()
    const mq = new MessageQueue()

    mq.setLifecycle(lcOld)
    const oldTransitionBefore = lcOld.listenerCount('transition')
    const oldEvictedBefore = lcOld.listenerCount('record:evicted')

    mq.setLifecycle(lcNew)

    // The old lifecycle should have ONE FEWER listener on each event
    expect(lcOld.listenerCount('transition')).toBe(oldTransitionBefore - 1)
    expect(lcOld.listenerCount('record:evicted')).toBe(oldEvictedBefore - 1)

    // And the new lifecycle should have its listeners attached
    expect(lcNew.listenerCount('transition')).toBeGreaterThan(0)
    expect(lcNew.listenerCount('record:evicted')).toBeGreaterThan(0)
  })

  it('events fire correctly after re-setLifecycle (functional regression)', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)
    mq.setLifecycle(lc) // re-attach

    const events: string[] = []
    mq.on('task:added', () => events.push('added'))
    mq.on('task:completed', () => events.push('completed'))

    const task = mq.createInternalTask('test')
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')
    lc.transition(task.id, 'completed', 'natural')

    // Should see each event ONCE (not twice, which would indicate double-listener)
    expect(events).toEqual(['added', 'completed'])
  })
})

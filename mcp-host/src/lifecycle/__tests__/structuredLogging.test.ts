import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import { TaskLifecycle } from '../taskLifecycle'
import { buildTask } from './helpers'

describe('TaskLifecycle structured logging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a duplicate registration through logger.warn with the prior state', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't-dup' }))
    lc.transition('t-dup', 'processing', 'dispatched')

    lc.register(buildTask({ id: 't-dup' }))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't-dup', status: 'processing' }),
      'duplicate registration suppressed'
    )
  })

  it('reports each transition through logger.info keyed by event', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const lc = new TaskLifecycle()
    const events: Array<{ at: Date }> = []
    lc.on('transition', ev => events.push(ev))

    lc.register(buildTask({ id: 't-log' }))
    lc.transition('t-log', 'processing', 'dispatched')

    expect(info).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenLastCalledWith(
      {
        component: 'TaskLifecycle',
        event: 'transition_emitted',
        taskId: 't-log',
        from: 'pending',
        to: 'processing',
        reason: 'dispatched',
        at: events[1]!.at.toISOString(),
      },
      'task transition'
    )
  })
})

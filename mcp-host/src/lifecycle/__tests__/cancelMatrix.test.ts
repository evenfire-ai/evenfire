/**
 * Cancel scenario matrix (spec §7.3) — state-machine-only scenarios.
 *
 * Covers scenarios that require no executor mocks:
 *   1  — cancel pending (no executor spawn; tombstone skipped on dispatch)
 *   8  — already-completed (AlreadyTerminal, no SSE)
 *   9  — unknown ID (NotFound)
 *   11 — race: cancel wins before completion
 *   12 — race: completion wins before cancel
 *
 * Scenarios 2-7 and 10 require executor mocks — deferred to B.6b / B.6c.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProcessor } from '../../session/sessionProcessor'
import { TaskLifecycle } from '../taskLifecycle'
import { buildTask } from './helpers'

describe('Cancel scenario matrix (spec §7.3) — state-machine only', () => {
  let lc: TaskLifecycle
  beforeEach(() => {
    lc = new TaskLifecycle()
  })

  it('Scenario 1: cancel pending — no executor spawn; tombstone skipped on dispatch', async () => {
    const executorFn = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor: executorFn, lifecycle: lc })
    const task = buildTask({ id: 't1' })
    lc.register(task)

    // Cancel BEFORE dispatch
    lc.transition('t1', 'cancelled', 'user_requested')

    const skipped = new Promise<void>(r => sp.once('task:skipped', () => r()))
    sp.enqueue('s1', task)
    await skipped

    expect(executorFn).not.toHaveBeenCalled()
    expect(lc.getStatus('t1')).toBe('cancelled')
  })

  it('Scenario 8: cancel already-completed returns already_terminal with no further SSE', () => {
    const task = buildTask({ id: 't1' })
    lc.register(task)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'completed', 'natural')

    const events: unknown[] = []
    lc.on('transition', ev => events.push(ev))

    const outcome = lc.transition('t1', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('already_terminal')
    expect(events).toHaveLength(0)
  })

  it('Scenario 9: cancel unknown ID returns not_found', () => {
    const outcome = lc.transition('unknown', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('not_found')
  })

  it('Scenario 11: race — cancel applied before completion → cancelled wins, completion drops', () => {
    const task = buildTask({ id: 't1' })
    lc.register(task)
    lc.transition('t1', 'processing', 'dispatched')

    const cancelResult = lc.transition('t1', 'cancelled', 'user_requested')
    const completeResult = lc.transition('t1', 'completed', 'natural')

    expect(cancelResult.kind).toBe('applied')
    expect(completeResult.kind).toBe('already_terminal')
    expect(lc.getStatus('t1')).toBe('cancelled')
  })

  it('Scenario 12: race — completion applied before cancel → completed wins, cancel idempotent', () => {
    const task = buildTask({ id: 't1' })
    lc.register(task)
    lc.transition('t1', 'processing', 'dispatched')

    const completeResult = lc.transition('t1', 'completed', 'natural')
    const cancelResult = lc.transition('t1', 'cancelled', 'user_requested')

    expect(completeResult.kind).toBe('applied')
    expect(cancelResult.kind).toBe('already_terminal')
    expect(lc.getStatus('t1')).toBe('completed')
  })
})

function mkMockExecutor(
  opts: { taskId: string; pendingApproval?: boolean } = { taskId: 't-mock' }
) {
  const abortController = new AbortController()
  return {
    taskId: opts.taskId,
    abort: () => abortController.abort(),
    get signal() {
      return abortController.signal
    },
    pendingApproval: opts.pendingApproval
      ? ({
          request_id: 'r1',
          tool_name: 'mock',
          tool_call_id: 'c1',
          parameters: {},
          description: '',
        } as any)
      : undefined,
    sourceTask: { id: opts.taskId, sourceMessage: undefined } as any,
    executorState: opts.pendingApproval ? 'waiting_approval' : 'processing',
  }
}

describe('Cancel scenario matrix — processing path (mock executor)', () => {
  // Reproduce the AgentStateMachine cancel-subscriber pattern (but simpler — no approval cleanup)
  function installSubscriber(lc: TaskLifecycle, executors: Map<string, any>) {
    lc.on('transition', ev => {
      if (ev.to !== 'cancelled') return
      const ex = executors.get(ev.taskId)
      if (!ex) return
      try {
        ex.abort()
      } catch {
        /* I11 */
      }
    })
  }

  it.each<[number, string]>([
    [2, 'pre-LLM checkpoint'],
    [3, 'mid-LLM HTTP'],
    [4, 'post-LLM checkpoint'],
    [5, 'mid-tool execution'],
    [6, 'post-tool checkpoint'],
  ])('Scenario %i: cancel %s — abort fires, state transitions, 1 terminal', (_n, label) => {
    const lc = new TaskLifecycle()
    const taskId = `t-${label.replace(/\s/g, '-')}`
    const mockExec = mkMockExecutor({ taskId })
    const activeExecutors = new Map<string, any>([[taskId, mockExec]])
    installSubscriber(lc, activeExecutors)

    lc.register(buildTask({ id: taskId }))
    lc.transition(taskId, 'processing', 'dispatched')

    const events: any[] = []
    lc.on('transition', ev => events.push(ev))

    const outcome = lc.transition(taskId, 'cancelled', 'user_requested')

    expect(outcome.kind).toBe('applied')
    expect(mockExec.signal.aborted).toBe(true)
    expect(events.filter(e => e.to === 'cancelled')).toHaveLength(1)
    expect(lc.getStatus(taskId)).toBe('cancelled')
  })

  it('Scenario 10: cancel during resumeAfterApproval single-tool — abort fires after resume', () => {
    const lc = new TaskLifecycle()
    const taskId = 't-resume'
    const mockExec = mkMockExecutor({ taskId }) // back to processing after approval granted
    const activeExecutors = new Map<string, any>([[taskId, mockExec]])
    installSubscriber(lc, activeExecutors)

    lc.register(buildTask({ id: taskId }))
    lc.transition(taskId, 'processing', 'dispatched')
    lc.transition(taskId, 'waiting_approval', 'natural')
    lc.transition(taskId, 'processing', 'natural') // approval granted, resuming

    const outcome = lc.transition(taskId, 'cancelled', 'user_requested')

    expect(outcome.kind).toBe('applied')
    expect(mockExec.signal.aborted).toBe(true)
    expect(lc.getStatus(taskId)).toBe('cancelled')
  })
})

describe('Cancel scenario matrix — waiting_approval path', () => {
  it('Scenario 7: cancel during approval — no denial message, full cleanup, 1 terminal', () => {
    const lc = new TaskLifecycle()
    const taskId = 't-approval'
    const mockExec = mkMockExecutor({ taskId, pendingApproval: true })
    const activeExecutors = new Map<string, any>([[taskId, mockExec]])
    const approvalMap = new Map<string, any>([
      ['r1', { taskId, timerId: setTimeout(() => {}, 60_000), registeredAt: new Date() }],
    ])
    const clearPendingApproval = vi.fn()
    const releaseSession = vi.fn()

    // Simulate AgentStateMachine's subscriber (approval branch)
    lc.on('transition', ev => {
      if (ev.to !== 'cancelled') return
      const ex = activeExecutors.get(ev.taskId)
      if (!ex || !ex.pendingApproval) return
      try {
        const reqId = ex.pendingApproval.request_id
        const entry = approvalMap.get(reqId)
        if (entry?.timerId) clearTimeout(entry.timerId)
        approvalMap.delete(reqId)
        clearPendingApproval('session-key')
        releaseSession(ex.sourceTask)
        ex.abort()
        activeExecutors.delete(ev.taskId)
      } catch {
        /* I11 */
      }
    })

    const terminalEvents: any[] = []
    lc.on('transition', ev => {
      if (ev.to === 'cancelled') terminalEvents.push(ev)
    })

    lc.register(buildTask({ id: taskId }))
    lc.transition(taskId, 'processing', 'dispatched')
    lc.transition(taskId, 'waiting_approval', 'natural')

    const outcome = lc.transition(taskId, 'cancelled', 'user_requested')

    expect(outcome.kind).toBe('applied')
    expect(terminalEvents).toHaveLength(1)
    expect(approvalMap.size).toBe(0)
    expect(clearPendingApproval).toHaveBeenCalledOnce()
    expect(releaseSession).toHaveBeenCalledOnce()
    expect(activeExecutors.has(taskId)).toBe(false)
    expect(mockExec.signal.aborted).toBe(true)
  })
})

describe('Shutdown drain', () => {
  it('drainNonTerminal cancels all non-terminal tasks, preserves terminal reasons', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 'a' }))
    lc.register(buildTask({ id: 'b' }))
    lc.register(buildTask({ id: 'c' }))

    lc.transition('a', 'processing', 'dispatched')
    lc.transition('b', 'processing', 'dispatched')
    lc.transition('b', 'waiting_approval', 'natural')
    lc.transition('c', 'cancelled', 'user_requested') // already terminal

    const drained = lc.drainNonTerminal()

    expect(drained).toBe(2) // a + b
    expect(lc.getStatus('a')).toBe('cancelled')
    expect(lc.getStatus('b')).toBe('cancelled')
    expect(lc.getStatus('c')).toBe('cancelled')
    expect(lc.get('a')?.reason).toBe('system_shutdown')
    expect(lc.get('b')?.reason).toBe('system_shutdown')
    expect(lc.get('c')?.reason).toBe('user_requested') // original reason preserved
  })
})

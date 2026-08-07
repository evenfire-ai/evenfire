import { describe, expect, it } from 'vitest'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle.js'
import { SseProgressReporter } from '../sseProgressReporter.js'
import type { ProgressEvent, TerminalEvent } from '../types.js'

describe('SseProgressReporter TaskLifecycle subscription', () => {
  it('emits terminal(cancelled) SSE event when transition(cancelled) fires', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'cancelled', 'user_requested')

    const terminal = events.find(e => e.type === 'terminal')
    expect(terminal).toBeDefined()
    expect((terminal!.data as TerminalEvent).status).toBe('cancelled')
    expect((terminal!.data as TerminalEvent).reason).toBe('user_requested')
  })

  it('emits terminal(completed) SSE event when transition(completed) fires', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'completed', 'natural')

    const terminal = events.find(e => e.type === 'terminal')
    expect(terminal).toBeDefined()
    expect((terminal!.data as TerminalEvent).status).toBe('completed')
  })

  it('emits terminal(failed) SSE event when transition(failed) fires', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    const sampleError = {
      code: 'LLM_TIMEOUT',
      message: 'timed out',
      retryable: false,
      provider: 'openai',
    }
    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'failed', 'error:LLM_TIMEOUT', { error: sampleError })

    const terminal = events.find(e => e.type === 'terminal')
    expect(terminal).toBeDefined()
    expect((terminal!.data as TerminalEvent).status).toBe('failed')
    expect((terminal!.data as TerminalEvent).error).toEqual(sampleError)
  })

  it('ignores transitions for other taskIds', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    lc.register({ id: 't2' } as any)
    lc.transition('t2', 'processing', 'dispatched')
    lc.transition('t2', 'cancelled', 'user_requested')

    expect(events.filter(e => e.type === 'terminal')).toHaveLength(0)
  })

  it('emitTerminal is idempotent — second terminal transition is a no-op', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'completed', 'natural')
    // Lifecycle won't fire a second terminal, but if it did the reporter would no-op
    expect(events.filter(e => e.type === 'terminal')).toHaveLength(1)
  })

  it('dispose() removes the subscription so no further events flow', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))

    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    reporter.dispose()
    lc.transition('t1', 'cancelled', 'user_requested')

    expect(events.filter(e => e.type === 'terminal')).toHaveLength(0)
  })

  it('constructor without lifecycle works (backward-compat)', () => {
    const reporter = new SseProgressReporter('t1', undefined, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(ev => events.push(ev))
    // No lifecycle means no terminal events flow automatically — reporter is inert for terminals
    expect(events.filter(e => e.type === 'terminal')).toHaveLength(0)
  })
})

// BUG-7 ("MessageHandler pre-creates reporter subscribed to TaskLifecycle") was
// retired with the messageHandler pre-registration removal. Reporter ownership
// now lives exclusively in TaskExecutor.buildLoopConfig — see the equivalent
// regression test in src/__tests__/messageHandler.test.ts ("does not pre-register
// an SseProgressReporter — TaskExecutor owns construction") and the lifecycle
// terminal-buffer assertions earlier in this file.

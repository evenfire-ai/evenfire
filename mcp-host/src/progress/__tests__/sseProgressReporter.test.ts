// mcp-host/src/progress/__tests__/sseProgressReporter.test.ts
import { describe, expect, it } from 'vitest'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import { BasicSafety } from '../../core/safety/safety.js'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle.js'
import type { TaskError } from '../../queue/types'
import {
  SseProgressReporter,
  ensureReporter,
  progressReporterRegistry,
} from '../sseProgressReporter.js'
import type {
  ProgressEvent,
  TerminalEvent,
  ToolCompleteEvent,
  ToolProgressEvent,
  ToolStartEvent,
} from '../types.js'

describe('SseProgressReporter', () => {
  it('delivers tool_start events to subscribers', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(event => received.push(event))

    const startEvent: ToolStartEvent = {
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'mongodb__find',
      displayName: 'Mongodb',
      intentSummary: 'Searching...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 2,
    }
    reporter.reportToolStart(startEvent)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ type: 'tool_start', data: startEvent })
  })

  it('delivers tool_complete events to subscribers', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(event => received.push(event))

    const completeEvent: ToolCompleteEvent = {
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'mongodb__find',
      displayName: 'Mongodb',
      durationMs: 150,
      isError: false,
      iteration: 0,
      stepIndex: 0,
      totalSteps: 2,
    }
    reporter.reportToolComplete(completeEvent)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ type: 'tool_complete', data: completeEvent })
  })

  it('overrides taskId with its own on reportToolStart', () => {
    const reporter = new SseProgressReporter('real-task-id', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolStart({
      taskId: '', // loop doesn't know taskId
      toolCallId: 'c1',
      toolName: 't',
      displayName: 'T',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    expect((received[0].data as ToolStartEvent).taskId).toBe('real-task-id')
  })

  it('supports multiple subscribers', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received1: ProgressEvent[] = []
    const received2: ProgressEvent[] = []
    reporter.subscribe(e => received1.push(e))
    reporter.subscribe(e => received2.push(e))

    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c1',
      toolName: 't',
      displayName: 'T',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    expect(received1).toHaveLength(1)
    expect(received2).toHaveLength(1)
  })

  it('unsubscribe stops delivery', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    const unsub = reporter.subscribe(e => received.push(e))

    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c1',
      toolName: 't',
      displayName: 'T',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })
    unsub()
    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c2',
      toolName: 't',
      displayName: 'T',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 1,
      totalSteps: 2,
    })

    expect(received).toHaveLength(1)
  })

  it('emitSuspended sends a suspended event', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.emitSuspended('Shell', 'req-42')

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: 'suspended',
      data: {
        taskId: 'task-1',
        requestId: 'req-42',
        displayName: 'Shell',
        reason: 'approval_required',
      },
    })
  })

  it('P1-1: the suspended event never carries the raw tool_name', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.emitSuspended('Shell', 'req-42')

    expect(JSON.stringify(received[0])).not.toContain('toolName')
  })

  it('P1 sticky replay: late subscriber receives the suspended event emitted before it connected', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)

    // Suspend is published before any (re)connected subscriber attaches.
    reporter.emitSuspended('Shell', 'req-42')

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    expect(late).toHaveLength(1)
    expect(late[0]).toEqual({
      type: 'suspended',
      data: {
        taskId: 'task-1',
        requestId: 'req-42',
        displayName: 'Shell',
        reason: 'approval_required',
      },
    })
  })

  it('P1 sticky replay: replayed payload is the same redacted payload published live (no raw tool_name)', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    reporter.emitSuspended('Shell', 'req-42')

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    expect(JSON.stringify(late[0])).not.toContain('toolName')
  })

  it('P1 sticky replay: a second approval (multi-tool-call turn) overwrites the sticky suspended', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)

    // First gate suspends, resumes (reportToolStart clears the sticky), then a
    // SECOND tool in the same turn needs approval. A late subscriber must see
    // the CURRENT pending approval (req-2 / Fetch), never the resolved first one.
    reporter.emitSuspended('Shell', 'req-1')
    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 2,
    })
    reporter.emitSuspended('Fetch', 'req-2')

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    expect(late).toHaveLength(1)
    expect(late[0]).toEqual({
      type: 'suspended',
      data: {
        taskId: 'task-1',
        requestId: 'req-2',
        displayName: 'Fetch',
        reason: 'approval_required',
      },
    })
  })

  it('P1 cleanup: after the approval resolves (reportToolStart), a late subscriber does NOT get a stale suspended', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    reporter.emitSuspended('Shell', 'req-42')

    // Gate resolved → the approved tool starts executing, loop resumes.
    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    // tool_start is transient (not replayed) and suspended was cleared.
    expect(late).toHaveLength(0)
  })

  it('P1 cleanup: after the approval resolves (reportLlmInProgress), a late subscriber does NOT get a stale suspended', () => {
    const reporter = new SseProgressReporter('task-1', undefined, NoopSafety)
    reporter.emitSuspended('Shell', 'req-42')

    // Gate resolved → tool result fed back to the model, LLM resumes.
    reporter.reportLlmInProgress({ taskId: 'task-1', iteration: 1 } as any)

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    expect(late).toHaveLength(0)
  })

  it('P1 cleanup: a late subscriber after terminal receives ONLY the terminal (not a stale suspended)', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)

    reporter.emitSuspended('Shell', 'req-42')

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'completed', 'natural')

    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))

    expect(late.map(e => e.type)).toEqual(['terminal'])
  })

  it('emits terminal(completed) and sets completedAt when lifecycle transitions to completed', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    expect(reporter.completedAt).toBe(Infinity)
    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'completed', 'natural')

    const terminal = received.find(e => e.type === 'terminal')
    expect(terminal).toBeDefined()
    expect((terminal!.data as TerminalEvent).status).toBe('completed')
    expect(reporter.completedAt).toBeLessThanOrEqual(Date.now())
  })

  it('does not deliver events after terminal is emitted', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'completed', 'natural')

    // After terminal, tool events are suppressed
    reporter.reportToolStart({
      taskId: 'task-1',
      toolCallId: 'c1',
      toolName: 't',
      displayName: 'T',
      intentSummary: '...',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('terminal')
  })
})

describe('SseProgressReporter terminal(failed) — via lifecycle', () => {
  const sampleError: TaskError = {
    code: 'LLM_INSUFFICIENT_QUOTA',
    message: 'out of credit',
    retryable: false,
    provider: 'openai',
  }

  it('publishes terminal(failed) event with the correct shape', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'failed', 'error:LLM_INSUFFICIENT_QUOTA', { error: sampleError })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('terminal')
    const data = events[0].data as TerminalEvent
    expect(data.status).toBe('failed')
    expect(data.taskId).toBe('task-1')
    expect(data.error).toEqual(sampleError)
  })

  it('terminal is idempotent — second lifecycle transition is a no-op', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'failed', 'error:LLM_INSUFFICIENT_QUOTA', { error: sampleError })
    // Lifecycle itself prevents double-terminal, but reporter's completed guard also blocks it
    expect(events.filter(e => e.type === 'terminal')).toHaveLength(1)
  })

  it('emits only terminal — no separate done event follows it', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'failed', 'error:LLM_INSUFFICIENT_QUOTA', { error: sampleError })

    expect(events.map(e => e.type)).toEqual(['terminal'])
  })
})

describe('SseProgressReporter terminal(cancelled) — via lifecycle', () => {
  it('terminal(cancelled) publishes a single terminal event (no separate done)', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'cancelled', 'user_requested')

    expect(events.map(e => e.type)).toEqual(['terminal'])
    expect((events[0].data as TerminalEvent).status).toBe('cancelled')
    expect((events[0].data as TerminalEvent).reason).toBe('user_requested')
  })

  it('terminal(cancelled) is idempotent', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-1', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-1' } as any)
    lc.transition('task-1', 'processing', 'dispatched')
    lc.transition('task-1', 'cancelled', 'user_requested')
    // Reporter's completed guard blocks any repeat
    expect(events.map(e => e.type)).toEqual(['terminal'])
  })
})

describe('progressReporterRegistry', () => {
  it('stores and retrieves reporters by taskId', () => {
    const reporter = new SseProgressReporter('reg-task-1', undefined, NoopSafety)
    progressReporterRegistry.set('reg-task-1', reporter)
    expect(progressReporterRegistry.get('reg-task-1')).toBe(reporter)
    progressReporterRegistry.delete('reg-task-1')
  })

  it('expires reporters after TTL once completed', () => {
    const reporter = new SseProgressReporter('reg-task-2', undefined, NoopSafety)
    // TTL is 5 minutes (300s). Set completedAt to 6 minutes ago to trigger eviction.
    reporter.completedAt = Date.now() - 360_000
    progressReporterRegistry.set('reg-task-2', reporter)
    expect(progressReporterRegistry.get('reg-task-2')).toBeUndefined()
  })

  it('waitFor resolves immediately when reporter already exists', async () => {
    const reporter = new SseProgressReporter('wait-task-1', undefined, NoopSafety)
    progressReporterRegistry.set('wait-task-1', reporter)
    const result = await progressReporterRegistry.waitFor('wait-task-1', 1000)
    expect(result).toBe(reporter)
    progressReporterRegistry.delete('wait-task-1')
  })

  it('waitFor resolves when reporter is set after waiting', async () => {
    const reporter = new SseProgressReporter('wait-task-2', undefined, NoopSafety)
    // Set reporter after 50ms delay
    setTimeout(() => {
      progressReporterRegistry.set('wait-task-2', reporter)
    }, 50)
    const result = await progressReporterRegistry.waitFor('wait-task-2', 5000)
    expect(result).toBe(reporter)
    progressReporterRegistry.delete('wait-task-2')
  })

  it('waitFor returns undefined on timeout', async () => {
    const result = await progressReporterRegistry.waitFor('nonexistent-task', 100)
    expect(result).toBeUndefined()
  })
})

describe('ensureReporter (idempotent get-or-create)', () => {
  it('creates and registers a new reporter when none exists', () => {
    const lc = new TaskLifecycle()
    const reporter = ensureReporter('ensure-task-1', lc, NoopSafety)
    expect(reporter).toBeInstanceOf(SseProgressReporter)
    expect(reporter.taskId).toBe('ensure-task-1')
    expect(progressReporterRegistry.get('ensure-task-1')).toBe(reporter)
    progressReporterRegistry.delete('ensure-task-1')
  })

  it('returns the already-registered reporter without constructing a new one', () => {
    const existing = new SseProgressReporter('ensure-task-2', undefined, NoopSafety)
    progressReporterRegistry.set('ensure-task-2', existing)
    const got = ensureReporter('ensure-task-2', new TaskLifecycle(), NoopSafety)
    expect(got).toBe(existing)
    progressReporterRegistry.delete('ensure-task-2')
  })

  it('wakes a blocked waitFor when it registers the fresh reporter', async () => {
    const pending = progressReporterRegistry.waitFor('ensure-task-3', 5000)
    const reporter = ensureReporter('ensure-task-3', new TaskLifecycle(), NoopSafety)
    await expect(pending).resolves.toBe(reporter)
    progressReporterRegistry.delete('ensure-task-3')
  })
})

describe('SseProgressReporter.reportToolProgress', () => {
  const samplePreview: ToolProgressEvent['outputPreview'] = {
    headLines: ['hello'],
    tailLines: ['world'],
    totalLines: 2,
    truncated: false,
  }

  it('publishes a tool_progress event to subscribers with taskId overridden', () => {
    const reporter = new SseProgressReporter('task-42', undefined, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    reporter.reportToolProgress({
      taskId: '', // loop doesn't know taskId — reporter overrides
      toolCallId: 'call-1',
      toolName: 'shell_exec',
      elapsedMs: 30_000,
      outputPreview: samplePreview,
    })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool_progress')
    expect((events[0].data as any).taskId).toBe('task-42')
    expect((events[0].data as any).elapsedMs).toBe(30_000)
    expect((events[0].data as any).outputPreview).toEqual(samplePreview)
  })

  it('is a no-op after terminal has been emitted', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('task-42', lc, NoopSafety)
    const events: ProgressEvent[] = []
    reporter.subscribe(e => events.push(e))

    lc.register({ id: 'task-42' } as any)
    lc.transition('task-42', 'processing', 'dispatched')
    lc.transition('task-42', 'completed', 'natural')

    reporter.reportToolProgress({
      taskId: '',
      toolCallId: 'c',
      toolName: 'shell_exec',
      elapsedMs: 10,
      outputPreview: samplePreview,
    })

    // Only terminal from lifecycle should be in the stream.
    expect(events.map(e => e.type)).toEqual(['terminal'])
  })

  it('does NOT add tool_progress to the terminal replay buffer', () => {
    const reporter = new SseProgressReporter('task-42', undefined, NoopSafety)
    reporter.reportToolProgress({
      taskId: '',
      toolCallId: 'c',
      toolName: 'shell_exec',
      elapsedMs: 10,
      outputPreview: samplePreview,
    })

    // Subscribing after the event — the late subscriber must receive NOTHING
    // (tool_progress is transient, not replayable).
    const late: ProgressEvent[] = []
    reporter.subscribe(e => late.push(e))
    expect(late).toHaveLength(0)
  })
})

describe('SseProgressReporter — boundary redaction', () => {
  // BasicSafety is the production redactor. Passing a tiny secretEntriesProvider
  // exercises the same code path mcp-host runs in production (literal-substring
  // ConfigStore pass + the existing regex SECRET_PATTERNS pass).
  const buildSafety = (entries: Array<{ name: string; value: string }> = []) => {
    return new BasicSafety(() => entries)
  }

  it('redacts ConfigStore secret in tool_start.intentSummary', () => {
    const safety = buildSafety([{ name: 'STRIPE_KEY', value: 'sk_live_abc123xyz' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolStart({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      intentSummary: 'Using sk_live_abc123xyz to authenticate',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    expect(received).toHaveLength(1)
    const data = received[0].data as ToolStartEvent
    expect(data.intentSummary).not.toContain('sk_live_abc123xyz')
    expect(data.intentSummary).toContain('[REDACTED:STRIPE_KEY]')
  })

  it('redacts ConfigStore secret in tool_start.inputPreview', () => {
    const safety = buildSafety([{ name: 'STRIPE_KEY', value: 'sk_live_abc123xyz' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolStart({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      intentSummary: 'running a command',
      inputPreview: 'curl -H "Authorization: Bearer sk_live_abc123xyz" https://api',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    const data = received[0].data as ToolStartEvent
    expect(data.inputPreview).not.toContain('sk_live_abc123xyz')
    expect(data.inputPreview).toContain('[REDACTED:STRIPE_KEY]')
  })

  it('redacts ConfigStore secret in tool_complete.errorSummary', () => {
    const safety = buildSafety([{ name: 'STRIPE_KEY', value: 'sk_live_abc123xyz' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolComplete({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      durationMs: 50,
      isError: true,
      errorSummary: 'Could not authenticate with sk_live_abc123xyz: 401',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    const data = received[0].data as ToolCompleteEvent
    expect(data.errorSummary).not.toContain('sk_live_abc123xyz')
    expect(data.errorSummary).toContain('[REDACTED:STRIPE_KEY]')
  })

  it('publishes tool_complete.tokens intact through redaction (crit #3 guard)', () => {
    const safety = buildSafety([{ name: 'STRIPE_KEY', value: 'sk_live_abc123xyz' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolComplete({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      durationMs: 50,
      isError: false,
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
      tokens: { input: 1200, output: 80, cacheRead: 5000, cacheWrite: 300 },
    })

    expect(received).toHaveLength(1)
    const data = received[0].data as ToolCompleteEvent
    expect(data.tokens).toEqual({ input: 1200, output: 80, cacheRead: 5000, cacheWrite: 300 })
  })

  it('redacts ConfigStore secret in tool_complete.outputPreview head/tail lines', () => {
    // Note: secret value is shaped to bypass the SECRET_PATTERNS regex pass
    // (which would otherwise replace with generic [REDACTED]) so the test
    // proves the ConfigStore literal-substring labeling pass works on
    // outputPreview head/tail lines.
    const safety = buildSafety([{ name: 'GITHUB_TOKEN', value: 'gh-internal-token-xyz123' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolComplete({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      durationMs: 50,
      isError: false,
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
      outputPreview: {
        headLines: ['command output start', 'token: gh-internal-token-xyz123'],
        tailLines: ['gh-internal-token-xyz123 was used', 'done'],
        totalLines: 4,
        truncated: false,
      },
    })

    const data = received[0].data as ToolCompleteEvent
    const allLines = [...data.outputPreview!.headLines, ...data.outputPreview!.tailLines].join('|')
    expect(allLines).not.toContain('gh-internal-token-xyz123')
    expect(allLines).toContain('[REDACTED:GITHUB_TOKEN]')
  })

  it('redacts ConfigStore secret in tool_progress.outputPreview', () => {
    // NOTE: value chosen to bypass SECRET_PATTERNS regex so the test
    // isolates the ConfigStore literal-substring labeling pass.
    // See Task 4's analogous fixture for the same rationale.
    const safety = buildSafety([{ name: 'GITHUB_TOKEN', value: 'gh-internal-token-xyz123' }])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolProgress({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      elapsedMs: 1000,
      outputPreview: {
        headLines: ['streaming...', 'token=gh-internal-token-xyz123'],
        tailLines: ['more output'],
        totalLines: 3,
        truncated: false,
      },
    })

    const data = received[0].data as ToolProgressEvent
    const allLines = [...data.outputPreview!.headLines, ...data.outputPreview!.tailLines].join('|')
    expect(allLines).not.toContain('gh-internal-token-xyz123')
    expect(allLines).toContain('[REDACTED:GITHUB_TOKEN]')
  })

  it('redacts ConfigStore secret in terminal.error.message', () => {
    const safety = buildSafety([{ name: 'API_TOKEN', value: 'tok_secretvalue9999' }])
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t1', lc, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    const failingError: TaskError = {
      code: 'LLM_API_ERROR',
      message: 'auth failed for token tok_secretvalue9999',
      retryable: false,
      provider: 'openai',
    }

    lc.register({ id: 't1' } as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'failed', 'error:LLM_API_ERROR', { error: failingError })

    const terminal = received.find(e => e.type === 'terminal')
    expect(terminal).toBeDefined()
    const data = terminal!.data as TerminalEvent
    expect(data.error?.message).not.toContain('tok_secretvalue9999')
    expect(data.error?.message).toContain('[REDACTED:API_TOKEN]')
    // Code should be unchanged — it's an enum, not free-form
    expect(data.error?.code).toBe('LLM_API_ERROR')
  })

  it('passes events through unchanged when NoopSafety is supplied (test-only opt-out)', () => {
    const reporter = new SseProgressReporter('t1', undefined, NoopSafety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    // Use a value that WOULD match SECRET_PATTERNS so we're sure it's NoopSafety
    // returning input unchanged, not BasicSafety silently failing to redact.
    reporter.reportToolStart({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      intentSummary: 'using ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    const data = received[0].data as ToolStartEvent
    expect(data.intentSummary).toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('applies regex SECRET_PATTERNS even without ConfigStore entries', () => {
    // safety with no ConfigStore entries — only the regex pass should fire
    const safety = buildSafety([])
    const reporter = new SseProgressReporter('t1', undefined, safety)
    const received: ProgressEvent[] = []
    reporter.subscribe(e => received.push(e))

    reporter.reportToolStart({
      taskId: '',
      toolCallId: 'c1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      // GitHub PAT pattern from BasicSafety.SECRET_PATTERNS
      intentSummary: 'using ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })

    const data = received[0].data as ToolStartEvent
    expect(data.intentSummary).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(data.intentSummary).toContain('[REDACTED]')
  })
})

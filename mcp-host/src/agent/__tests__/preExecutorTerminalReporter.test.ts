/**
 * §5.3.1 — pre-executor terminal SSE reporter.
 *
 * Regression coverage for the "Agent is thinking" ~180s hang: a task that fails
 * BEFORE a TaskExecutor is created (budget deny, null llmProvider, any
 * pre-executor path) must still register an SseProgressReporter at the canonical
 * failure point so the terminal SSE event is buffered/emitted instead of being
 * lost — otherwise the desktop stream blocks on `waitFor(taskId, 180_000)`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { SseProgressReporter, progressReporterRegistry } from '../../progress/sseProgressReporter'
import type { TerminalEvent } from '../../progress/types'
import { MessageQueue } from '../../queue'
import type { Task, TaskError } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

/** Minimal SingleTurnProvider stub exposing getProviderType. */
function stubProvider(providerType: string) {
  return { getProviderType: () => providerType } as unknown as Parameters<
    AgentStateMachine['setLLMProvider']
  >[0]
}

/**
 * Wire a machine whose queue transitions the SAME lifecycle (so queue.failTask
 * drives lifecycle.transition('failed') → the reporter's terminal emission).
 */
function setup(opts: { withProvider?: boolean } = {}) {
  const queue = new MessageQueue()
  const lifecycle = new TaskLifecycle()
  queue.setLifecycle(lifecycle)
  const machine = new AgentStateMachine(queue, lifecycle)
  if (opts.withProvider !== false) machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')
  return { queue, lifecycle, machine }
}

/** Register + advance to 'processing' so a terminal transition is legal. */
function dispatch(queue: MessageQueue, lifecycle: TaskLifecycle, content = 'hi'): Task {
  const task = queue.createInternalTask(content)
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
  return task
}

function callHandleTaskFailure(machine: AgentStateMachine, task: Task, error: TaskError): void {
  ;(machine as unknown as { handleTaskFailure: (t: Task, e: TaskError) => void }).handleTaskFailure(
    task,
    error
  )
}

describe('§5.3.1 pre-executor terminal reporter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [id] of progressReporterRegistry.entries()) {
      progressReporterRegistry.delete(id)
    }
  })

  it('budget deny with no prior reporter registers one, emits terminal(failed), and replays to a LATE subscriber', () => {
    const { queue, lifecycle, machine } = setup()
    const task = dispatch(queue, lifecycle)
    expect(progressReporterRegistry.get(task.id)).toBeUndefined()

    machine.handleBudgetDenied(task, 'monthly_cost_exceeded')

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()

    // Late subscriber (attaches AFTER the terminal already fired) gets it by
    // terminalBuffer replay — the crux of the fix.
    const late: TerminalEvent[] = []
    reporter!.subscribe(e => {
      if (e.type === 'terminal') late.push(e.data as TerminalEvent)
    })
    expect(late).toHaveLength(1)
    expect(late[0].status).toBe('failed')
    expect(late[0].error?.code).toBe('BUDGET_EXCEEDED')
    expect(lifecycle.getStatus(task.id)).toBe('failed')
  })

  it('is idempotent: an existing reporter (executor path) is reused, only one terminal is emitted', () => {
    const { queue, lifecycle, machine } = setup()
    const task = dispatch(queue, lifecycle)

    // Executor path already created + registered a reporter subscribed to the lifecycle.
    const preexisting = new SseProgressReporter(task.id, lifecycle, NoopSafety)
    progressReporterRegistry.set(task.id, preexisting)

    const events: string[] = []
    preexisting.subscribe(e => events.push(e.type))

    callHandleTaskFailure(machine, task, {
      code: 'LLM_INSUFFICIENT_QUOTA',
      message: 'out of credit',
      retryable: false,
      provider: 'openai',
    })

    // Same instance, single terminal.
    expect(progressReporterRegistry.get(task.id)).toBe(preexisting)
    expect(events.filter(t => t === 'terminal')).toHaveLength(1)
  })

  it('null llmProvider path (executeTask) emits a terminal (generality beyond budgets)', async () => {
    const { queue, lifecycle, machine } = setup({ withProvider: false })
    const task = dispatch(queue, lifecycle)

    await machine.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    expect(reporter!.completedAt).not.toBe(Infinity)
    expect(lifecycle.getStatus(task.id)).toBe('failed')
  })

  it('fail-open: if constructing the reporter throws, responseCallback and failTask still run', async () => {
    const { queue, lifecycle, machine } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Force the REAL ensureReporter to throw. Spying the named `ensureReporter`
    // export does NOT intercept the direct named binding used inside
    // stateMachine.ts, so instead we make the registry.get() it calls first
    // throw — exercising the actual try/catch fail-open path in handleTaskFailure.
    vi.spyOn(progressReporterRegistry, 'get').mockImplementation(() => {
      throw new Error('reporter boom')
    })

    const task = dispatch(queue, lifecycle)
    const responseCallback = vi.fn().mockResolvedValue(undefined)
    task.responseCallback = responseCallback

    expect(() =>
      callHandleTaskFailure(machine, task, {
        code: 'LLM_INSUFFICIENT_QUOTA',
        message: 'out of credit',
        retryable: false,
        provider: 'openai',
      })
    ).not.toThrow()

    await new Promise(r => setImmediate(r))
    expect(responseCallback).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'LLM_INSUFFICIENT_QUOTA' }),
    })
    expect(lifecycle.getStatus(task.id)).toBe('failed')
  })

  it('anti-leak guard: an ALREADY-terminal task does NOT get a fresh reporter', () => {
    const { queue, lifecycle, machine } = setup()
    const task = dispatch(queue, lifecycle)
    // Drive the task terminal WITHOUT a reporter first.
    lifecycle.transition(task.id, 'failed', 'error:LLM_INSUFFICIENT_QUOTA')
    expect(progressReporterRegistry.get(task.id)).toBeUndefined()

    callHandleTaskFailure(machine, task, {
      code: 'LLM_INSUFFICIENT_QUOTA',
      message: 'out of credit',
      retryable: false,
      provider: 'openai',
    })

    // No reporter created — creating one for a terminal task would strand it with
    // completedAt=Infinity (never evicted). Guard prevents the leak.
    expect(progressReporterRegistry.get(task.id)).toBeUndefined()
  })

  it('redacts a ConfigStore secret in terminal.error.message', () => {
    const { queue, lifecycle, machine } = setup()
    machine.setSecretEntriesProvider(() => [{ name: 'API_TOKEN', value: 'tok_secretvalue9999' }])
    const task = dispatch(queue, lifecycle)

    callHandleTaskFailure(machine, task, {
      code: 'LLM_API_ERROR',
      message: 'auth failed for token tok_secretvalue9999',
      retryable: false,
      provider: 'openai',
    })

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    const late: TerminalEvent[] = []
    reporter!.subscribe(e => {
      if (e.type === 'terminal') late.push(e.data as TerminalEvent)
    })
    expect(late[0].error?.message).not.toContain('tok_secretvalue9999')
    expect(late[0].error?.message).toContain('[REDACTED:API_TOKEN]')
    expect(late[0].error?.code).toBe('LLM_API_ERROR')
  })

  it('integration: a waitFor opened BEFORE the deny resolves fast with a reporter (not undefined)', async () => {
    const { queue, lifecycle, machine } = setup()
    const task = dispatch(queue, lifecycle)

    // Simulate the stream endpoint blocking on the reporter with the real 180s
    // timeout. The fix must resolve it near-instantly.
    const pending = progressReporterRegistry.waitFor(task.id, 180_000)

    machine.handleBudgetDenied(task, 'monthly_cost_exceeded')

    const reporter = await pending
    expect(reporter).toBeDefined()
    expect(reporter).toBe(progressReporterRegistry.get(task.id))

    const late: TerminalEvent[] = []
    reporter!.subscribe(e => {
      if (e.type === 'terminal') late.push(e.data as TerminalEvent)
    })
    expect(late[0].status).toBe('failed')
    expect(late[0].error?.code).toBe('BUDGET_EXCEEDED')
  })
})

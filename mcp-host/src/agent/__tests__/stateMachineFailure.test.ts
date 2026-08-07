import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { SseProgressReporter, progressReporterRegistry } from '../../progress/sseProgressReporter'
import { MessageQueue } from '../../queue'
import type { TaskError } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

describe('AgentStateMachine.handleTaskFailure', () => {
  const testError: TaskError = {
    code: 'LLM_INSUFFICIENT_QUOTA',
    message: 'out of credit',
    retryable: false,
    provider: 'openai',
  }

  function makeMachine() {
    const queue = new MessageQueue()
    const machine = new AgentStateMachine(queue, new TaskLifecycle())
    return { machine, queue }
  }

  it('invokes task.responseCallback with the structured error', async () => {
    const { machine, queue } = makeMachine()
    const responseCallback = vi.fn().mockResolvedValue(undefined)
    const task = queue.createInternalTask('hello')
    task.responseCallback = responseCallback
    queue.enqueue(task)
    queue.dequeue()

    // Access private method via cast
    ;(
      machine as unknown as {
        handleTaskFailure: (t: typeof task, e: TaskError) => void
      }
    ).handleTaskFailure(task, testError)

    // responseCallback is fire-and-forget; await a microtask
    await new Promise(r => setImmediate(r))

    expect(responseCallback).toHaveBeenCalledWith({ error: testError })
  })

  it('emits task:failed event with structured error payload', async () => {
    const { machine, queue } = makeMachine()
    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()

    const events: unknown[] = []
    machine.on('task:failed', e => events.push(e))
    ;(
      machine as unknown as {
        handleTaskFailure: (t: typeof task, e: TaskError) => void
      }
    ).handleTaskFailure(task, testError)

    expect(events).toHaveLength(1)
    expect((events[0] as { data: { error: TaskError } }).data.error).toEqual(testError)
  })

  it('logs a structured single-line format', () => {
    const { machine, queue } = makeMachine()
    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(
      machine as unknown as {
        handleTaskFailure: (t: typeof task, e: TaskError) => void
      }
    ).handleTaskFailure(task, testError)

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /code=LLM_INSUFFICIENT_QUOTA retryable=false provider=openai message="out of credit"/
      )
    )
    errSpy.mockRestore()
  })

  it('catches responseCallback rejection without throwing', async () => {
    const { machine, queue } = makeMachine()
    const task = queue.createInternalTask('hello')
    task.responseCallback = vi.fn().mockRejectedValue(new Error('callback failed'))
    queue.enqueue(task)
    queue.dequeue()

    expect(() =>
      (
        machine as unknown as {
          handleTaskFailure: (t: typeof task, e: TaskError) => void
        }
      ).handleTaskFailure(task, testError)
    ).not.toThrow()

    await new Promise(r => setImmediate(r))
  })
})

describe('AgentStateMachine.handleTaskFailure SSE error reporting', () => {
  afterEach(() => {
    // Clean registry between tests
    for (const [id] of progressReporterRegistry.entries()) {
      progressReporterRegistry.delete(id)
    }
  })

  const testError: TaskError = {
    code: 'LLM_INSUFFICIENT_QUOTA',
    message: 'out of credit',
    retryable: false,
    provider: 'openai',
  }

  it("emits terminal(failed) event on the task's SSE reporter", () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    // Wire the lifecycle into both machine and queue so transitions flow through
    queue.setLifecycle(lifecycle)
    const machine = new AgentStateMachine(queue, lifecycle)
    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()
    // Register task with lifecycle before transitioning
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')

    // Create reporter with the lifecycle so it receives the terminal event
    const reporter = new SseProgressReporter(task.id, lifecycle, NoopSafety)
    progressReporterRegistry.set(task.id, reporter)

    const events: string[] = []
    reporter.subscribe(e => events.push(e.type))
    ;(
      machine as unknown as {
        handleTaskFailure: (t: typeof task, e: TaskError) => void
      }
    ).handleTaskFailure(task, testError)

    expect(events).toEqual(['terminal'])
    const terminalData = (reporter as any).terminalBuffer[0]?.data
    expect(terminalData?.status).toBe('failed')
    expect(terminalData?.error).toEqual(testError)
  })
})

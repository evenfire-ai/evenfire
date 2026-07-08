import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStateMachine } from '../../agent'
import { LlmErrorCode } from '../../core/errors'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { ClassifiedError, SingleTurnProvider } from '../../llm'
import { SseProgressReporter, progressReporterRegistry } from '../../progress/sseProgressReporter'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import type { ProgressEvent } from '../../progress/types'
import { MessageQueue } from '../../queue'

function makeProviderThatThrows(
  rawError: unknown,
  classified: ClassifiedError
): SingleTurnProvider {
  return {
    completeSingleTurn: vi.fn().mockRejectedValue(rawError),
    completeSingleTurnWithTools: vi.fn().mockRejectedValue(rawError),
    getProviderType: () => 'openai' as const,
    classifyError: vi.fn().mockReturnValue(classified),
  }
}

describe('Error flow — end-to-end across all 4 delivery channels', () => {
  afterEach(() => {
    for (const [id] of progressReporterRegistry.entries()) {
      progressReporterRegistry.delete(id)
    }
  })

  it('delivers an insufficient_quota error with byte-identical shape across responseCallback, SSE, task:failed, and task.error', async () => {
    // Arrange
    const rawError = {
      status: 429,
      error: { code: 'insufficient_quota', message: 'out of credit' },
    }
    const classified: ClassifiedError = {
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'out of credit',
    }
    const provider = makeProviderThatThrows(rawError, classified)

    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    // Wire lifecycle into queue so queue.failTask triggers lifecycle.transition('failed'),
    // which SseProgressReporter intercepts to emit terminal(failed) (Phase D.2).
    queue.setLifecycle(lifecycle)
    const machine = new AgentStateMachine(queue, lifecycle)
    machine.setLLMProvider(provider, 'gpt-4o')

    const task = queue.createInternalTask('hello')

    // Channel 1: responseCallback
    const responseCallbackPayloads: unknown[] = []
    task.responseCallback = async payload => {
      responseCallbackPayloads.push(payload)
    }

    // Channel 2: SSE stream via reporter — must be created with lifecycle so it
    // receives the terminal(failed) transition emitted by queue.failTask.
    const reporter = new SseProgressReporter(task.id, lifecycle, NoopSafety)
    progressReporterRegistry.set(task.id, reporter)
    const sseEvents: ProgressEvent[] = []
    reporter.subscribe(e => sseEvents.push(e))

    // Channel 3: task:failed event
    const failedEvents: unknown[] = []
    machine.on('task:failed', e => failedEvents.push(e))

    // Act — enqueue registers task with lifecycle (pending), dequeue advances to processing.
    // This is required so lifecycle.transition('failed') is legal (pending → processing → failed).
    queue.enqueue(task)
    queue.dequeue()
    await machine.executeTask(task)
    // Allow microtasks for fire-and-forget responseCallback
    await new Promise(r => setImmediate(r))

    // Expected canonical shape
    const expectedError = {
      code: 'LLM_INSUFFICIENT_QUOTA',
      message: 'out of credit',
      retryable: false,
      provider: 'openai',
    }

    // Channel 1: responseCallback was called exactly once with structured error
    expect(responseCallbackPayloads).toHaveLength(1)
    expect((responseCallbackPayloads[0] as { error: unknown }).error).toEqual(expectedError)

    // Channel 2: SSE stream emitted terminal(failed); the event carries the full error shape
    expect(sseEvents.map(e => e.type)).toEqual(['terminal'])
    const terminalEvent = sseEvents[0]
    expect(terminalEvent.type).toBe('terminal')
    expect((terminalEvent as { data: unknown }).data).toEqual({
      taskId: task.id,
      status: 'failed',
      reason: expect.stringContaining('error:'),
      error: expectedError,
    })

    // Channel 3: task:failed event payload carries structured error
    expect(failedEvents).toHaveLength(1)
    expect((failedEvents[0] as { data: { error: unknown } }).data.error).toEqual(expectedError)

    // Channel 4: task.error itself is the structured shape
    expect(task.error).toEqual(expectedError)

    // No retries — SDK method called exactly once
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(task.status).toBe('failed')
  })

  it('does not retry even for retryable errors (queue-level retry was dropped)', async () => {
    const classified: ClassifiedError = {
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    }
    const provider = makeProviderThatThrows({ status: 429 }, classified)

    const queue = new MessageQueue()
    const machine = new AgentStateMachine(queue, new TaskLifecycle())
    machine.setLLMProvider(provider, 'gpt-4o')

    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    await machine.executeTask(task)

    // Exactly one call — the queue did not retry, even though retryable: true.
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(task.status).toBe('failed')

    // The structured error's retryable flag IS preserved (it's advisory for the UI).
    expect(task.error).toEqual({
      code: 'LLM_RATE_LIMITED',
      message: 'rate limited',
      retryable: true,
      provider: 'openai',
    })
  })

  it('authentication failures surface immediately with retryable=false', async () => {
    const classified: ClassifiedError = {
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      message: 'Invalid API key',
    }
    const provider = makeProviderThatThrows({ status: 401 }, classified)

    const queue = new MessageQueue()
    const machine = new AgentStateMachine(queue, new TaskLifecycle())
    machine.setLLMProvider(provider, 'gpt-4o')

    const task = queue.createInternalTask('hello')
    const responseCallbackPayloads: unknown[] = []
    task.responseCallback = async payload => {
      responseCallbackPayloads.push(payload)
    }

    queue.enqueue(task)
    await machine.executeTask(task)
    await new Promise(r => setImmediate(r))

    expect(responseCallbackPayloads).toHaveLength(1)
    expect(
      (responseCallbackPayloads[0] as { error: { code: string; retryable: boolean } }).error
    ).toMatchObject({ code: 'LLM_AUTHENTICATION_FAILED', retryable: false })
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
  })
})

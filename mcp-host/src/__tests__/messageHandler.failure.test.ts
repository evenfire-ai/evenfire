import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { IncomingMessageHandler, PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import type { Task, TaskError } from '../queue/types'
import { ResultStore } from '../resultStore'
import type { IncomingMessage } from '../server'

function createTestMessage(content = 'Hello', messageId = 'm1'): IncomingMessage {
  return {
    sender: 'user-1',
    content,
    channelType: 'rpc',
    channelId: 'chan',
    messageId,
    timestamp: new Date().toISOString(),
    hostRef: 'test-host',
  }
}

function makeTestDeps() {
  const messageQueue = new MessageQueue()
  const agent = new EventEmitter() as any
  const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
  const taskLifecycle = new TaskLifecycle()
  messageQueue.setLifecycle(taskLifecycle)
  return {
    messageQueue,
    agent,
    pendingTaskResults,
    getModel: () => 'test-model',
    sanitizeAttachments: (a: any) => a,
    timeoutMs: 60000,
    taskLifecycle,
  }
}

const sampleError: TaskError = {
  code: 'LLM_INSUFFICIENT_QUOTA',
  message: 'out of credit',
  retryable: false,
  provider: 'openai',
}

describe('IncomingMessageHandler sync failure path', () => {
  it('resolves with success:false and the structured error', async () => {
    const deps = makeTestDeps()
    const handler = new IncomingMessageHandler(createTestMessage('hello', 'm1'), deps)

    // Capture the task when it is enqueued via task:added event
    let capturedTask: Task | null = null
    deps.messageQueue.once('task:added', (event: { task?: Task }) => {
      capturedTask = event.task ?? null
    })

    const promise = handler.execute()
    // Allow handler to attach listeners
    await new Promise(r => setTimeout(r, 5))
    if (!capturedTask) throw new Error('task:added event not received')
    const task: Task = capturedTask
    expect(task).toBeDefined()
    // Set error and emit task:failed
    task.error = sampleError
    deps.messageQueue.emit('task:failed', { type: 'task:failed', task, timestamp: new Date() })

    const response = await promise
    expect(response.success).toBe(false)
    expect(response.error).toEqual(sampleError)
  })

  it('times out with a structured LLM_API_CALL_FAILED error', async () => {
    const deps = makeTestDeps()
    deps.timeoutMs = 10
    const handler = new IncomingMessageHandler(createTestMessage('hello', 'm2'), deps)

    const response = await handler.execute()
    expect(response.success).toBe(false)
    expect(response.error).toEqual({
      code: 'LLM_API_CALL_FAILED',
      message: 'Task processing timeout',
      retryable: true,
      provider: 'unknown',
    })
  })
})

describe('IncomingMessageHandler async (executeAsync) failure path', () => {
  it('stores structured error in pendingTaskResults via responseCallback when task fails', async () => {
    const deps = makeTestDeps()
    const handler = new IncomingMessageHandler(createTestMessage('hello', 'm3'), deps)

    const response = handler.executeAsync()
    expect(response.status).toBe('pending')
    expect(response.taskId).toBeDefined()

    const task = deps.messageQueue.getTask(response.taskId!)
    expect(task).toBeDefined()

    // Delivery goes through responseCallback (called by handleTaskFailure before failTask emits
    // task:failed). Invoke the overridden callback directly to simulate that path.
    await task!.responseCallback!({ error: sampleError })

    const stored = deps.pendingTaskResults.get(response.taskId!)
    expect(stored).toBeDefined()
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toEqual(sampleError)
    expect(stored?.response).toBeUndefined()
  })

  it('cleans up listeners on task:failed without writing to pendingTaskResults', async () => {
    const deps = makeTestDeps()
    const handler = new IncomingMessageHandler(createTestMessage('hello', 'm4'), deps)

    const response = handler.executeAsync()
    expect(response.taskId).toBeDefined()

    const task = deps.messageQueue.getTask(response.taskId!)
    expect(task).toBeDefined()

    // Emit task:failed without going through responseCallback — pendingTaskResults must stay empty
    // (onFinalFailure only cleans up listeners, delivery is the responseCallback's job)
    deps.messageQueue.emit('task:failed', { type: 'task:failed', task, timestamp: new Date() })

    await new Promise(r => setImmediate(r))

    // pendingTaskResults should NOT have been written by the cleanup-only handler
    const stored = deps.pendingTaskResults.get(response.taskId!)
    expect(stored).toBeUndefined()
  })
})

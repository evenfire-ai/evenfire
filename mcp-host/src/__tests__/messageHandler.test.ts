import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { IncomingMessageHandler, PendingTaskEntry } from '../messageHandler'
import { progressReporterRegistry } from '../progress/sseProgressReporter'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage } from '../server'

function createTestMessage(content = 'Hello'): IncomingMessage {
  return {
    sender: 'user-1',
    content,
    channelType: 'telegram',
    channelId: 'test-channel',
    messageId: `msg-${Date.now()}`,
    timestamp: new Date().toISOString(),
    hostRef: 'test-host',
  }
}

function createMockDeps() {
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
    timeoutMs: 500, // short timeout for tests
    taskLifecycle,
  }
}

describe('IncomingMessageHandler', () => {
  it('should resolve with completed response when task finishes normally', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('Hi')
    const handler = new IncomingMessageHandler(message, deps)

    const resultPromise = handler.execute()

    // Simulate task completion: find the task and call its responseCallback
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()
    expect(task).not.toBeNull()
    await task!.responseCallback!({ response: 'Hello back!' })

    const result = await resultPromise
    expect(result.success).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.response).toBe('Hello back!')
    expect(result.model).toBe('test-model')
  })

  it('should resolve with error when task fails', async () => {
    const deps = createMockDeps()
    const handler = new IncomingMessageHandler(createTestMessage(), deps)

    const resultPromise = handler.execute()

    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!
    // Simulate failure via queue event — no retries now
    deps.messageQueue.failTask(task, {
      code: 'LLM_API_CALL_FAILED',
      message: 'Something broke',
      retryable: false,
      provider: 'openai',
    })

    const result = await resultPromise
    expect(result.success).toBe(false)
    expect(result.error).toEqual({
      code: 'LLM_API_CALL_FAILED',
      message: 'Something broke',
      retryable: false,
      provider: 'openai',
    })
  })

  it('should resolve with timeout error after timeoutMs', async () => {
    const deps = createMockDeps()
    deps.timeoutMs = 50 // 50ms timeout
    const handler = new IncomingMessageHandler(createTestMessage(), deps)

    const result = await handler.execute()

    expect(result.success).toBe(false)
    expect(result.error).toEqual({
      code: 'LLM_API_CALL_FAILED',
      message: 'Task processing timeout',
      retryable: true,
      provider: 'unknown',
    })
  })

  it('should resolve with approval notification on first approval event', async () => {
    const deps = createMockDeps()
    const handler = new IncomingMessageHandler(createTestMessage(), deps)

    const resultPromise = handler.execute()

    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!

    // Simulate approval event from agent
    deps.agent.emit('tool:approval_needed', {
      data: {
        taskId: task.id,
        requestId: 'req-1',
        userId: 'user-1',
        notification: 'Approve shell_exec?',
      },
    })

    const result = await resultPromise
    expect(result.success).toBe(true)
    expect(result.status).toBe('waiting_approval')
    expect(result.approval?.notification).toBe('Approve shell_exec?')
  })

  it('should store subsequent responses in pendingTaskResults', async () => {
    const deps = createMockDeps()
    const handler = new IncomingMessageHandler(createTestMessage(), deps)

    const resultPromise = handler.execute()

    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!

    // First: approval event resolves the promise
    deps.agent.emit('tool:approval_needed', {
      data: {
        taskId: task.id,
        requestId: 'req-1',
        userId: 'user-1',
        notification: 'Approve?',
      },
    })
    await resultPromise // resolve first

    // Second: task completes after approval — should be stored, not resolve again
    await task.responseCallback!({ response: 'Final result' })

    const stored = deps.pendingTaskResults.get(task.id)
    expect(stored).toBeDefined()
    expect(stored!.status).toBe('completed')
    expect(stored!.response).toBe('Final result')
  })

  describe('executeAsync', () => {
    it('should return immediately with pending status and taskId', () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()

      expect(result.success).toBe(true)
      expect(result.status).toBe('pending')
      expect(result.taskId).toBeDefined()
      expect(typeof result.taskId).toBe('string')
    })

    it('should enqueue the task', () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      handler.executeAsync()

      const task = deps.messageQueue.dequeue()
      expect(task).not.toBeNull()
    })

    it('should store completed result in pendingTaskResults when task finishes', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()
      const taskId = result.taskId!

      // Dequeue and simulate completion via the overridden responseCallback
      const task = deps.messageQueue.dequeue()!
      await task.responseCallback!({ response: 'Async result' })

      const stored = deps.pendingTaskResults.get(taskId)
      expect(stored).toBeDefined()
      expect(stored!.status).toBe('completed')
      expect(stored!.response).toBe('Async result')
      expect(stored!.model).toBe('test-model')
    })

    it('should store approval notification in pendingTaskResults', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()
      const taskId = result.taskId!

      // Dequeue to get the task id for the approval event
      const task = deps.messageQueue.dequeue()!

      // Simulate approval event
      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId: task.id,
          requestId: 'req-async-1',
          userId: 'user-1',
          notification: 'Approve async tool?',
        },
      })

      // Allow event to propagate
      await new Promise(r => setTimeout(r, 10))

      const stored = deps.pendingTaskResults.get(taskId)
      expect(stored).toBeDefined()
      expect(stored!.status).toBe('waiting_approval')
      expect(stored!.approval?.requestId).toBe('req-async-1')
      expect(stored!.approval?.notification).toBe('Approve async tool?')
    })
  })

  describe('approval cache invalidation', () => {
    it('clears the stored waiting_approval entry when approval is granted (executeAsync path)', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()
      const taskId = result.taskId!

      // Dequeue so the task is real
      deps.messageQueue.dequeue()

      // 1. Approval needed → entry stored
      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId,
          requestId: 'req-stale-1',
          userId: 'user-1',
          notification: 'Approve thing?',
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(taskId)?.status).toBe('waiting_approval')

      // 2. Approval granted → entry must be cleared, so that the next poll
      //    sees no entry (handleTaskResult returns 'pending' instead of stale
      //    waiting_approval).
      deps.agent.emit('tool:approval_granted', {
        data: {
          toolName: 'shell_exec',
          requestId: 'req-stale-1',
          userId: 'user-1',
          alwaysApprove: false,
          taskId,
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(taskId)).toBeUndefined()
    })

    it('clears the stored waiting_approval entry when approval is denied (executeAsync path)', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()
      const taskId = result.taskId!
      deps.messageQueue.dequeue()

      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId,
          requestId: 'req-stale-2',
          userId: 'user-1',
          notification: 'Approve thing?',
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(taskId)?.status).toBe('waiting_approval')

      deps.agent.emit('tool:approval_denied', {
        data: {
          toolName: 'shell_exec',
          requestId: 'req-stale-2',
          userId: 'user-1',
          taskId,
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(taskId)).toBeUndefined()
    })

    it('clears the entry stored after first resolve on the sync path (multi-approval staleness)', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const resultPromise = handler.execute()
      await new Promise(r => setTimeout(r, 10))
      const task = deps.messageQueue.dequeue()!

      // First approval resolves the promise (sync path's first-resolve branch).
      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId: task.id,
          requestId: 'req-sync-1',
          userId: 'user-1',
          notification: 'First approval?',
        },
      })
      await resultPromise

      // Second approval is stored to pendingTaskResults (this is the path that
      // the channel-reader's waitForTaskResult polls).
      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId: task.id,
          requestId: 'req-sync-2',
          userId: 'user-1',
          notification: 'Second approval?',
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(task.id)?.approval?.requestId).toBe('req-sync-2')

      // Granted → entry must be cleared so the next poll doesn't re-surface
      // the same notification.
      deps.agent.emit('tool:approval_granted', {
        data: {
          toolName: 'shell_exec',
          requestId: 'req-sync-2',
          userId: 'user-1',
          alwaysApprove: false,
          taskId: task.id,
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(task.id)).toBeUndefined()
    })

    it('does not clear the entry for a different task (taskId routing)', async () => {
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)

      const result = handler.executeAsync()
      const taskId = result.taskId!
      deps.messageQueue.dequeue()

      deps.agent.emit('tool:approval_needed', {
        data: {
          taskId,
          requestId: 'req-mine',
          userId: 'user-1',
          notification: 'Mine?',
        },
      })
      await new Promise(r => setTimeout(r, 0))

      // A granted event for a *different* task must not nuke our entry.
      deps.agent.emit('tool:approval_granted', {
        data: {
          toolName: 'shell_exec',
          requestId: 'req-someone-else',
          userId: 'user-2',
          alwaysApprove: false,
          taskId: 'some-other-task-id',
        },
      })
      await new Promise(r => setTimeout(r, 0))
      expect(deps.pendingTaskResults.get(taskId)?.status).toBe('waiting_approval')
    })
  })

  describe('SSE reporter ownership', () => {
    it('does not pre-register an SseProgressReporter — TaskExecutor owns construction', () => {
      // Single construction site: reporters are built by TaskExecutor.buildLoopConfig.
      // Any code path that pre-registers in messageHandler would drift from
      // taskExecutor's safety wiring (the bug fixed in 8919ec06 + the broader
      // soft-contract risk). Asserting NO pre-registration locks that in.
      const deps = createMockDeps()
      const handler = new IncomingMessageHandler(createTestMessage(), deps)
      const taskId = (handler as unknown as { task: { id: string } }).task.id
      expect(progressReporterRegistry.get(taskId)).toBeUndefined()
    })
  })
})

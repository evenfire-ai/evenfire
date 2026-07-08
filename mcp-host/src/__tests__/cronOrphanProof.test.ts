/**
 * Regression guard for issue #529 — cron tasks must dispatch through SessionProcessor.
 *
 * Uses the production wireCronDispatch wiring (no duplicated handler logic).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wireCronDispatch } from '../agent/cronDispatch'
import { CronScheduler } from '../agent/cronScheduler'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { MessageQueue } from '../queue/messageQueue'
import type { Task } from '../queue/types'
import { SessionProcessor, serializeSessionKey } from '../session'

describe('cron orphan dispatch regression (issue #529)', () => {
  let lifecycle: TaskLifecycle
  let queue: MessageQueue
  let scheduler: CronScheduler
  let executorCalls: Task[]
  let sessionKeys: string[]
  let releaseExecutor: (() => void) | null
  let executorGate: Promise<void> | null
  let sessionProcessor: SessionProcessor

  beforeEach(() => {
    vi.clearAllMocks()
    lifecycle = new TaskLifecycle()
    queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    scheduler = new CronScheduler(queue)
    executorCalls = []
    sessionKeys = []
    releaseExecutor = null
    executorGate = null

    sessionProcessor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle,
      executor: async (task: Task) => {
        executorCalls.push(task)
        if (executorGate) {
          await executorGate
        }
        return false
      },
    })

    sessionProcessor.on('task:enqueued', ({ sessionKey }) => {
      sessionKeys.push(sessionKey)
    })

    wireCronDispatch(scheduler, {
      sessionProcessor,
      pendingCronResults: new Map(),
      sanitizeAttachments: attachments => attachments,
    })
  })

  afterEach(() => {
    scheduler.stop()
    releaseExecutor?.()
  })

  async function waitForExecutorCalls(count: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (executorCalls.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Expected ${count} executor calls, got ${executorCalls.length}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('UT-1: scheduled fire dispatches through SessionProcessor to the executor', async () => {
    const job = scheduler.createJob('orphan-proof', '0 * * * *', 'run health check')
    expect(job).not.toBeNull()

    scheduler.triggerJob(job!.id)
    await waitForExecutorCalls(1)

    expect(executorCalls).toHaveLength(1)
    expect(executorCalls[0]!.source).toBe('cron')
    expect(executorCalls[0]!.cronJobId).toBe(job!.id)
  })

  it('UT-2: channel task still dispatches (no regression on channel path)', async () => {
    const channelTask: Task = {
      id: 'channel-task-1',
      source: 'channel',
      sourceMessage: {
        sender: 'user-1',
        content: 'hello',
        channelType: 'telegram',
        channelId: 'chan-1',
        messageId: 'msg-1',
        timestamp: new Date().toISOString(),
        hostRef: 'test-host',
      },
      priority: 'normal',
      status: 'pending',
      conversationHistory: [
        {
          role: 'user',
          content: 'hello',
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
    }

    lifecycle.register(channelTask)
    const sessionKey = serializeSessionKey({
      userId: 'user-1',
      channelType: 'telegram',
      channelId: 'chan-1',
      threadId: undefined,
    })
    sessionProcessor.enqueue(sessionKey, channelTask)
    await waitForExecutorCalls(1)

    expect(executorCalls[0]!.id).toBe('channel-task-1')
    expect(executorCalls[0]!.source).toBe('channel')
  })

  it('UT-3: origin-less cron executes with synthetic session key', async () => {
    const job = scheduler.createJob('no-origin', '0 * * * *', 'background task')
    expect(job!.origin).toBeUndefined()

    scheduler.triggerJob(job!.id)
    await waitForExecutorCalls(1)

    expect(sessionKeys).toContain(`system:cron:${job!.id}:default`)
    expect(executorCalls[0]!.source).toBe('cron')
  })

  it('UT-4: re-entrant fires of the same job serialize FIFO, never run concurrently', async () => {
    let resolveFirst: (() => void) | null = null
    executorGate = new Promise<void>(resolve => {
      resolveFirst = resolve
    })

    const job = scheduler.createJob('reentrant', '0 * * * *', 'slow task')
    scheduler.triggerJob(job!.id)
    scheduler.triggerJob(job!.id)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(executorCalls).toHaveLength(1)

    releaseExecutor = () => resolveFirst?.()
    releaseExecutor()
    await waitForExecutorCalls(2)

    expect(executorCalls).toHaveLength(2)
    expect(executorCalls[0]!.cronJobId).toBe(job!.id)
    expect(executorCalls[1]!.cronJobId).toBe(job!.id)
  })
})

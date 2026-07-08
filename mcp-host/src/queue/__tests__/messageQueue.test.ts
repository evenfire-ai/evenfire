import { describe, expect, it } from 'vitest'
import { MessageQueue } from '../messageQueue'
import type { TaskError } from '../types'

// ---------------------------------------------------------------------------
// createTaskFromCron — origin / sourceMessage synthesis
// ---------------------------------------------------------------------------

describe('MessageQueue — createTaskFromCron with origin', () => {
  it('should synthesize sourceMessage when origin is provided', () => {
    const queue = new MessageQueue()
    const origin = {
      channelType: 'telegram' as const,
      channelId: '-5130716657',
      sender: '516801777',
    }

    const task = queue.createTaskFromCron('job-123', 'Fetch news', origin, 'normal')

    expect(task.source).toBe('cron')
    expect(task.cronJobId).toBe('job-123')
    expect(task.sourceMessage).toBeDefined()
    expect(task.sourceMessage!.channelType).toBe('telegram')
    expect(task.sourceMessage!.channelId).toBe('-5130716657')
    expect(task.sourceMessage!.sender).toBe('516801777')
    expect(task.sourceMessage!.messageId).toContain('cron-job-123-')
    expect(task.sourceMessage!.content).toBe('')
    expect(task.sourceMessage!.hostRef).toBe('')
  })

  it('should not set sourceMessage when origin is undefined', () => {
    const queue = new MessageQueue()
    const task = queue.createTaskFromCron('job-456', 'Run task', undefined, 'normal')

    expect(task.source).toBe('cron')
    expect(task.sourceMessage).toBeUndefined()
  })

  it('should preserve conversation history with origin', () => {
    const queue = new MessageQueue()
    const origin = {
      channelType: 'email' as const,
      channelId: 'inbox@company.com',
      sender: 'user@company.com',
    }

    const task = queue.createTaskFromCron('job-789', 'Send report', origin, 'high')

    expect(task.priority).toBe('high')
    expect(task.conversationHistory).toHaveLength(2)
    expect(task.conversationHistory[0].role).toBe('system')
    expect(task.conversationHistory[1].role).toBe('user')
    expect(task.conversationHistory[1].content).toBe('Send report')
  })
})

describe('MessageQueue — queue size cap', () => {
  it('should reject tasks when queue is full', () => {
    const queue = new MessageQueue(100, 2) // max 2 tasks

    const task1 = queue.createInternalTask('task 1')
    const task2 = queue.createInternalTask('task 2')
    const task3 = queue.createInternalTask('task 3')

    expect(queue.enqueue(task1)).toBe(true)
    expect(queue.enqueue(task2)).toBe(true)
    expect(queue.enqueue(task3)).toBe(false) // rejected

    const stats = queue.getStats()
    expect(stats.pending).toBe(2)
  })

  it('should accept tasks again after dequeue frees space', () => {
    const queue = new MessageQueue(100, 2)

    const task1 = queue.createInternalTask('task 1')
    const task2 = queue.createInternalTask('task 2')
    queue.enqueue(task1)
    queue.enqueue(task2)

    // Dequeue frees one slot
    queue.dequeue()

    const task3 = queue.createInternalTask('task 3')
    expect(queue.enqueue(task3)).toBe(true)
  })
})

describe('MessageQueue.failTask (no retries)', () => {
  const testError: TaskError = {
    code: 'LLM_INSUFFICIENT_QUOTA',
    message: 'out of credit',
    retryable: false,
    provider: 'openai',
  }

  it('transitions the task to failed without re-enqueueing', () => {
    const queue = new MessageQueue()
    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()

    queue.failTask(task, testError)

    expect(task.status).toBe('failed')
    expect(task.error).toEqual(testError)
    expect(queue.isEmpty()).toBe(true)
    // getFailedTasks removed — task.status is the source of truth now
  })

  it('does not retry even when error.retryable is true', () => {
    const queue = new MessageQueue()
    const retryableError: TaskError = { ...testError, retryable: true, code: 'LLM_RATE_LIMITED' }
    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()

    queue.failTask(task, retryableError)

    expect(task.status).toBe('failed')
    expect(queue.isEmpty()).toBe(true)
  })

  it('emits task:failed synchronously (no setTimeout)', () => {
    const queue = new MessageQueue()
    const events: string[] = []
    queue.on('task:failed', () => events.push('failed'))

    const task = queue.createInternalTask('hello')
    queue.enqueue(task)
    queue.dequeue()
    queue.failTask(task, testError)

    // No setTimeout — event fires immediately
    expect(events).toEqual(['failed'])
  })
})

/**
 * Ownership check on cancel.
 *
 * Verifies that:
 * - TaskRecord.submittedBy is captured from task.sourceMessage.sender at register time.
 * - Null is stored for tasks without a sourceMessage (internal/cron).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '../../queue/types'
import { TaskLifecycle } from '../taskLifecycle'

function mkTaskWithSender(id: string, sender: string | null): Task {
  const base: Task = {
    id,
    source: 'channel',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
  }
  if (sender !== null) {
    return {
      ...base,
      sourceMessage: {
        sender,
        channelType: 'telegram',
        channelId: 'c-1',
        messageId: 'm-1',
        content: 'hello',
        timestamp: new Date().toISOString(),
        hostRef: 'chatllm',
      },
    }
  }
  return base
}

describe('TaskRecord carries submittedBy for ownership checks', () => {
  it('register captures sender from sourceMessage', () => {
    const lc = new TaskLifecycle()
    lc.register(mkTaskWithSender('t1', 'alice'))
    expect(lc.get('t1')?.submittedBy).toBe('alice')
  })

  it('register sets submittedBy=null when sourceMessage is absent (internal task)', () => {
    const lc = new TaskLifecycle()
    lc.register(mkTaskWithSender('t2', null))
    expect(lc.get('t2')?.submittedBy).toBeNull()
  })

  it('register sets submittedBy=null for internal source with no sourceMessage', () => {
    const lc = new TaskLifecycle()
    const task: Task = {
      id: 't3',
      source: 'internal',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }
    lc.register(task)
    expect(lc.get('t3')?.submittedBy).toBeNull()
  })

  it('register captures a Slack sender correctly', () => {
    const lc = new TaskLifecycle()
    lc.register(mkTaskWithSender('t4', 'U012AB3CD'))
    expect(lc.get('t4')?.submittedBy).toBe('U012AB3CD')
  })

  it('submittedBy is still accessible after a state transition', () => {
    const lc = new TaskLifecycle()
    lc.register(mkTaskWithSender('t5', 'bob'))
    lc.transition('t5', 'processing', 'dispatched')
    expect(lc.get('t5')?.submittedBy).toBe('bob')
  })
})

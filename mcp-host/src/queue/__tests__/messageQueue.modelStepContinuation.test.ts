/**
 * #1043 — the queue factory that admits a model-step continuation.
 *
 * The continuation is admitted under the task id its claim already wrote, so
 * `getTask` and TaskLifecycle resolve it and the ordinary executor path owns
 * it from there. Only the factory, the index and the lifecycle wiring are
 * exercised here; the executor has its own tests.
 */
import { describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { IncomingMessage } from '../../server/types'
import { MessageQueue } from '../messageQueue'
import type { ModelStepContinuationRef, QueueEvent, Task } from '../types'

const CONTINUATION_TASK_ID = 'task-claim-1'
const CHECKPOINT_ID = 'cp-1043'

function continuationMessage(): IncomingMessage {
  return {
    content: 'summarize the repository',
    channelType: 'rpc',
    channelId: 'agent-x',
    sender: 'user-1043',
    timestamp: '2026-10-07T23:58:23.000Z',
    messageId: 'message-continuation',
    hostRef: 'chatllm',
    threadId: 'chat-1',
  }
}

function continuationRef(): ModelStepContinuationRef {
  return {
    checkpointId: CHECKPOINT_ID,
    originTaskId: 'task-origin',
    originTurnNumber: 3,
    provider: 'codex-subscription',
    model: 'gpt-6.1-sol',
    fence: { checkpointId: CHECKPOINT_ID, owner: 'host-instance-1', generation: 1 },
    confirmedResults: 1,
    taskBudget: JSON.stringify({ elapsedActiveMs: 1234 }),
    onVerdict: vi.fn(),
  }
}

describe('MessageQueue — createModelStepContinuationTask (#1043)', () => {
  it('indexes the task under the claim id and keeps its continuation ref', () => {
    const queue = new MessageQueue()
    const message = continuationMessage()
    const ref = continuationRef()

    const task = queue.createModelStepContinuationTask(message, CONTINUATION_TASK_ID, ref)

    // The claim already wrote this id; the admitted task must not renumber it.
    expect(task.id).toBe(CONTINUATION_TASK_ID)
    expect(queue.getTask(CONTINUATION_TASK_ID)).toBe(task)
    expect(task.modelStepContinuation).toBe(ref)
    expect(task.source).toBe('channel')
    expect(task.status).toBe('pending')
    expect(task.sourceMessage).toBe(message)
    expect(task.conversationHistory).toEqual([
      { role: 'user', content: message.content, timestamp: new Date(message.timestamp) },
    ])
  })

  it('registers the continuation in the lifecycle on admit, and its transitions reach the task', () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const events: QueueEvent[] = []
    queue.on('event', (event: QueueEvent) => events.push(event))

    const task: Task = queue.createModelStepContinuationTask(
      continuationMessage(),
      CONTINUATION_TASK_ID,
      continuationRef()
    )

    const outcome = queue.admit(task)
    expect(outcome.admitted).toBe(true)
    expect(lifecycle.getStatus(CONTINUATION_TASK_ID)).toBe('pending')
    // Registration reached the Task object through the queue's index.
    expect(events.find(event => event.type === 'task:added')?.task).toBe(task)

    expect(lifecycle.transition(CONTINUATION_TASK_ID, 'processing', 'dispatched')).toMatchObject({
      kind: 'applied',
    })
    const started = events.filter(event => event.type === 'task:started')
    expect(started).toHaveLength(1)
    expect(started[0].task).toBe(task)

    expect(lifecycle.transition(CONTINUATION_TASK_ID, 'completed', 'natural')).toMatchObject({
      kind: 'applied',
    })
    const completed = events.filter(event => event.type === 'task:completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].task).toBe(task)
  })
})

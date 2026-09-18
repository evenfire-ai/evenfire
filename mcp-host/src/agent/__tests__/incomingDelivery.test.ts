import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ConversationManager } from '../../core/conversation/conversation'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { IncomingMessageHandler, type PendingTaskEntry } from '../../messageHandler'
import { MessageQueue } from '../../queue/messageQueue'
import { ResultStore } from '../../resultStore'
import type { IncomingMessage, MessageResponse } from '../../server/types'
import { IncomingDelivery } from '../incomingDelivery'
import { applySessionModelSelection } from '../sessionModelSelection'

const message: IncomingMessage = {
  content: 'inspect',
  channelType: 'rpc',
  channelId: 'host',
  hostRef: 'host',
  sender: 'owner',
  threadId: 'chat',
  messageId: 'delivery',
  timestamp: '2026-09-17T00:00:00Z',
  model: 'vision-model',
  modelSelectionRevision: 0,
  attachments: [
    { id: 'image', kind: 'image', mimeType: 'image/png', encoding: 'base64', dataBase64: 'YWJj' },
  ],
}

function fixture() {
  const queue = new MessageQueue()
  const lifecycle = new TaskLifecycle()
  queue.setLifecycle(lifecycle)
  const conversations = new ConversationManager()
  const deps = {
    messageQueue: queue,
    taskLifecycle: lifecycle,
    agent: new EventEmitter() as never,
    pendingTaskResults: new ResultStore<PendingTaskEntry>(60_000, entry => entry.storedAt),
    getModel: () => 'vision-model',
    sanitizeAttachments: (items: IncomingMessage['attachments']) => items,
  }
  const dispatch = (input: IncomingMessage) =>
    new IncomingMessageHandler(input, deps).executeAsync()
  const prepare = vi.fn(async (input: IncomingMessage): Promise<MessageResponse> => {
    const selected = await applySessionModelSelection(
      {
        modelCfg: { provider: 'openai', name: 'vision-model' },
        convManager: conversations,
        allowlistView: {
          allowlistAvailable: () => true,
          allowedModels: () => new Map([['openai', [{ model: 'vision-model' }]]]),
        },
      },
      input.sender,
      input.channelId,
      input.threadId,
      input.model!,
      input.modelSelectionRevision
    )
    if (!selected.ok)
      return {
        success: false,
        error: {
          code: selected.reason,
          message: selected.reason,
          retryable: false,
          provider: 'openai',
        },
      }
    return dispatch(input)
  })
  const coordinator = new IncomingDelivery()
  return {
    queue,
    lifecycle,
    prepare,
    dispatch,
    run: (input = message) =>
      coordinator.run(
        input,
        queue,
        () => prepare(input),
        () => dispatch(input)
      ),
  }
}

describe('model CAS and delivery replay', () => {
  it('replays an admitted delivery instead of applying its stale CAS again', async () => {
    const f = fixture()
    const original = await f.run()
    expect(original.success).toBe(true)
    expect(await f.run({ ...message })).toMatchObject({ success: true, taskId: original.taskId })
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.queue.dequeue()?.id).toBe(original.taskId)
    expect(f.queue.dequeue()).toBeNull()
  })

  it('coalesces two deliveries while the first selection write has not admitted a task yet', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.run(), f.run({ ...message })])
    expect(a.success).toBe(true)
    expect(b).toEqual(a)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.queue.dequeue()?.id).toBe(a.taskId)
    expect(f.queue.dequeue()).toBeNull()
  })

  it('uses the existing terminal replay after the original task completes', async () => {
    const f = fixture()
    const first = await f.run()
    const task = f.queue.dequeue()!
    task.result = { response: 'original answer', model: 'vision-model' }
    f.queue.completeTask(task)
    expect(await f.run()).toMatchObject({
      success: true,
      taskId: first.taskId,
      response: 'original answer',
    })
    expect(f.prepare).toHaveBeenCalledTimes(1)
  })

  it('does not cache admission failures or suppress a distinct delivery', async () => {
    const f = fixture()
    expect((await f.run({ ...message, modelSelectionRevision: 9 })).success).toBe(false)
    expect((await f.run(message)).success).toBe(true)
    expect(
      (await f.run({ ...message, messageId: 'second', modelSelectionRevision: 1 })).success
    ).toBe(true)
    expect(f.prepare).toHaveBeenCalledTimes(3)
  })

  it('does not coalesce delivery identities belonging to different senders', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.run(), f.run({ ...message, sender: 'another-owner' })])
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)
    expect(a.taskId).not.toBe(b.taskId)
    expect(f.prepare).toHaveBeenCalledTimes(2)
  })

  it('demonstrates the original failure when CAS is called before duplicate admission', async () => {
    const f = fixture()
    expect((await f.prepare(message)).success).toBe(true)
    expect(await f.prepare(message)).toMatchObject({
      success: false,
      error: { code: 'model_selection_conflict' },
    })
  })
})

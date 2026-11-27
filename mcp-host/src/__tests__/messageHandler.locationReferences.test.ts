/**
 * A re-delivered message (same messageId) is answered from the task record
 * without running admission again. Its ack must name the same folder ids as
 * the original ack, or Desktop reads a Host that dropped the folder. The
 * original ack is the real admission's, dispatching to the real handler.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { buildGfsLocationReference } from '@clerum/gfs-interaction-policy'
import views from '../agent/__tests__/fixtures/gfsc-resolve-views.json'
import type { FileReferenceGfscClient } from '../agent/fileReferenceResolver'
import {
  type IncomingAdmissionDeps,
  createIncomingAdmission,
  replayedIncomingMessage,
} from '../agent/incomingAdmission'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage } from '../server'

const RID = '00000000000000000000000000000001'

function folderMessage(messageId: string): IncomingMessage {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    name: 'Folder-1',
  })
  if (!built.ok) throw new Error(built.message)
  return {
    sender: 'user-1',
    content: 'create a file here',
    channelType: 'rpc',
    channelId: 'agent-1',
    messageId,
    timestamp: new Date().toISOString(),
    hostRef: 'test-host',
    locationReferences: [built.value],
  }
}

function setup() {
  const messageQueue = new MessageQueue()
  const taskLifecycle = new TaskLifecycle()
  messageQueue.setLifecycle(taskLifecycle)
  const handlerDeps = {
    messageQueue,
    agent: new EventEmitter() as never,
    pendingTaskResults: new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt),
    getModel: () => 'test-model',
    sanitizeAttachments: <T>(a: T) => a,
    timeoutMs: 500,
    taskLifecycle,
  }
  const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async () => views.directory['1'])
  const dispatch: IncomingAdmissionDeps['dispatch'] = (message, options) => {
    const handler = new IncomingMessageHandler(message, handlerDeps)
    return options?.async ? handler.executeAsync() : handler.execute()
  }
  const admit = createIncomingAdmission({
    limits: { maxCount: 4, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => undefined,
    resolveTaskModel: () => null,
    resolveImageInput: () => undefined,
    applySessionModelSelection: vi.fn(),
    dispatch,
    fileReferenceGfs: () => ({ status: 'available', client: { resolve } }),
    logger: { info: vi.fn(), warn: vi.fn() },
    approvalSnapshot: () => ({ effective: undefined, hostSpec: undefined }),
  })
  // The path main.ts takes for a delivery the queue already admitted.
  const replay = (message: IncomingMessage, options?: { async?: boolean }) =>
    dispatch(replayedIncomingMessage(message), options)
  return { admit, replay, resolve, messageQueue, taskLifecycle }
}

describe('duplicate delivery keeps acceptedLocationReferenceIds', () => {
  it('T-H6: a re-delivery while the task is in flight names the same folder ids', async () => {
    const { admit, replay, resolve, taskLifecycle } = setup()
    const message = folderMessage('msg-loc-inflight')
    const original = await admit(message, { async: true })
    expect(original).toMatchObject({ success: true, status: 'pending' })
    expect(original.acceptedLocationReferenceIds).toHaveLength(1)

    const replayed = await replay(message, { async: true })

    expect(replayed).toEqual({
      success: true,
      status: 'pending',
      taskId: original.taskId,
      acceptedLocationReferenceIds: original.acceptedLocationReferenceIds,
    })
    // HK1: the replay asked gfsc nothing and created no second task.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(taskLifecycle.getStats().total).toBe(1)
  })

  it('T-H6: a re-delivery after the task completed names the same folder ids', async () => {
    const { admit, replay, messageQueue } = setup()
    const message = folderMessage('msg-loc-completed')
    const original = await admit(message, { async: true })
    const task = messageQueue.dequeue()!
    task.result = { response: 'done', model: 'test-model' }
    messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'done' })

    const replayed = await replay(message)

    expect(replayed).toMatchObject({
      success: true,
      status: 'completed',
      taskId: original.taskId,
      acceptedLocationReferenceIds: original.acceptedLocationReferenceIds,
    })
    expect(original.acceptedLocationReferenceIds).toHaveLength(1)
  })
})

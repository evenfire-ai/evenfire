import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task } from '../../queue/types'
import { SessionProcessor } from '../sessionProcessor'
import { type SessionKey, serializeSessionKey } from '../types'

vi.mock('../../config', () => ({
  config: { devMode: true },
}))

function createTaskForSession(id: string, key: SessionKey): { task: Task; sessionKey: string } {
  return {
    sessionKey: serializeSessionKey(key),
    task: {
      id,
      source: 'channel',
      sourceMessage: {
        sender: key.userId,
        content: `msg-${id}`,
        channelType: key.channelType as 'telegram' | 'email' | 'slack',
        channelId: key.channelId,
        messageId: `mid-${id}`,
        timestamp: new Date().toISOString(),
        hostRef: 'test',
        threadId: key.threadId,
      },
      priority: 'normal',
      status: 'pending',
      conversationHistory: [{ role: 'user', content: `msg-${id}`, timestamp: new Date() }],
      createdAt: new Date(),
    },
  }
}

describe('Session isolation — integration', () => {
  it('should isolate Alice on Telegram from Alice on Slack', async () => {
    const lc = new TaskLifecycle()
    const executionLog: Array<{ id: string; sessionKey: string }> = []
    let completed = 0
    let resolveAll!: () => void
    const allDone = new Promise<void>(r => {
      resolveAll = r
    })

    const processor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle: lc,
      executor: async task => {
        const sk = serializeSessionKey({
          userId: task.sourceMessage!.sender,
          channelType: task.sourceMessage!.channelType,
          channelId: task.sourceMessage!.channelId,
          threadId: task.sourceMessage!.threadId,
        })
        executionLog.push({ id: task.id, sessionKey: sk })
        completed++
        if (completed === 2) resolveAll()
        return false
      },
    })

    const tg = createTaskForSession('t1', {
      userId: 'alice',
      channelType: 'telegram',
      channelId: 'chat-1',
    })
    const slack = createTaskForSession('t2', {
      userId: 'alice',
      channelType: 'slack',
      channelId: 'C1',
    })

    lc.register(tg.task)
    lc.register(slack.task)
    processor.enqueue(tg.sessionKey, tg.task)
    processor.enqueue(slack.sessionKey, slack.task)

    await allDone

    expect(executionLog).toHaveLength(2)
    expect(executionLog[0].sessionKey).not.toBe(executionLog[1].sessionKey)
  })

  it('should isolate Slack threads from each other', async () => {
    const lc = new TaskLifecycle()
    const executionLog: string[] = []
    let completed = 0
    let resolveAll!: () => void
    const allDone = new Promise<void>(r => {
      resolveAll = r
    })

    const processor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle: lc,
      executor: async task => {
        executionLog.push(task.id)
        completed++
        if (completed === 2) resolveAll()
        return false
      },
    })

    const t1 = createTaskForSession('t1', {
      userId: 'bob',
      channelType: 'slack',
      channelId: 'C1',
      threadId: 'thread-A',
    })
    const t2 = createTaskForSession('t2', {
      userId: 'bob',
      channelType: 'slack',
      channelId: 'C1',
      threadId: 'thread-B',
    })

    lc.register(t1.task)
    lc.register(t2.task)
    processor.enqueue(t1.sessionKey, t1.task)
    processor.enqueue(t2.sessionKey, t2.task)

    await allDone

    expect(executionLog).toHaveLength(2)
    expect(executionLog).toContain('t1')
    expect(executionLog).toContain('t2')
  })

  it('should serialize tasks within the same Telegram DM', async () => {
    const lc = new TaskLifecycle()
    const order: string[] = []
    let resolveT2!: () => void
    const t2Done = new Promise<void>(r => {
      resolveT2 = r
    })

    const processor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle: lc,
      executor: async task => {
        order.push(`start:${task.id}`)
        if (task.id === 't1') {
          await new Promise(r => setTimeout(r, 30))
        }
        order.push(`end:${task.id}`)
        if (task.id === 't2') resolveT2()
        return false
      },
    })

    const key = { userId: 'alice', channelType: 'telegram', channelId: 'dm-alice' }
    const t1 = createTaskForSession('t1', key)
    const t2 = createTaskForSession('t2', key)

    lc.register(t1.task)
    lc.register(t2.task)
    processor.enqueue(t1.sessionKey, t1.task)
    processor.enqueue(t2.sessionKey, t2.task)

    await t2Done

    expect(order).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2'])
  })
})

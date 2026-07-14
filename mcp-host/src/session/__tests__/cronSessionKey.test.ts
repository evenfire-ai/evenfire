import { describe, expect, it } from 'vitest'
import type { Task } from '../../queue/types'
import { resolveCronTaskSessionKey, serializeSessionKey } from '../index'

describe('resolveCronTaskSessionKey', () => {
  it('isolates origin-less cron jobs per cronJobId', () => {
    const taskA: Task = {
      id: 'a',
      source: 'cron',
      cronJobId: 'job-a',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }
    const taskB: Task = {
      id: 'b',
      source: 'cron',
      cronJobId: 'job-b',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }

    expect(serializeSessionKey(resolveCronTaskSessionKey(taskA))).toBe('system:cron:job-a:default')
    expect(serializeSessionKey(resolveCronTaskSessionKey(taskB))).toBe('system:cron:job-b:default')
  })

  it('falls back to the unique task id when cronJobId is missing', () => {
    const taskA: Task = {
      id: 'task-1',
      source: 'cron',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }
    const taskB: Task = {
      id: 'task-2',
      source: 'cron',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }

    expect(serializeSessionKey(resolveCronTaskSessionKey(taskA))).toBe('system:cron:task-1:default')
    expect(serializeSessionKey(resolveCronTaskSessionKey(taskB))).toBe('system:cron:task-2:default')
  })

  it('reuses channel tuple when cron task has origin', () => {
    const task: Task = {
      id: 'c',
      source: 'cron',
      cronJobId: 'job-c',
      sourceMessage: {
        sender: 'user-9',
        channelType: 'telegram',
        channelId: 'chan-9',
        content: '',
        timestamp: new Date().toISOString(),
        messageId: 'm-1',
        hostRef: 'chatllm',
      },
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }

    expect(serializeSessionKey(resolveCronTaskSessionKey(task))).toBe(
      'user-9:telegram:chan-9:default'
    )
  })
})

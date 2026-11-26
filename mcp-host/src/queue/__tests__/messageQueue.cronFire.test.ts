import { describe, expect, it, vi } from 'vitest'
import { wireCronDispatch } from '../../agent/cronDispatch'
import { CronScheduler } from '../../agent/cronScheduler'
import type { CronJob } from '../../agent/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SessionProcessor } from '../../session'
import { MessageQueue } from '../messageQueue'

const PROMPT = 'check the deploy workflow status'

function teamsIdentity(): NonNullable<CronJob['providerIdentity']> {
  return {
    medium: 'teams',
    providerUserId: 'user-1',
    providerWorkspaceId: 'workspace-1',
    providerChannelId: '19:channel',
    providerChannelType: 'channel',
    providerEventId: 'evt-should-not-fire',
    providerTarget: {
      hostRef: 'host-1',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'general',
      providerBotId: null,
      providerBotUsername: null,
    },
  }
}

describe('MessageQueue cron fire', () => {
  it('keeps the origin channel, the stored provider channel, and the task prompt', () => {
    const queue = new MessageQueue()
    const task = queue.createTaskFromCron(
      'job-1',
      PROMPT,
      {
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'reply-1',
      },
      'normal',
      teamsIdentity()
    )

    expect(task.sourceMessage?.content).toBe(PROMPT)
    expect(task.sourceMessage?.messageId).toBe(`cron-${task.id}`)
    expect(task.sourceMessage?.channelId).toBe('19:conversation')
    expect(task.sourceMessage?.threadId).toBe('reply-1')
    expect(task.sourceMessage?.providerIdentity?.providerChannelId).toBe('19:channel')
    expect(task.sourceMessage?.providerIdentity?.providerTarget).toEqual({
      hostRef: 'host-1',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'general',
      providerBotId: null,
      providerBotUsername: null,
    })
    expect(task.sourceMessage?.providerIdentity).not.toHaveProperty('providerEventId')
    expect(task.conversationHistory.find(message => message.role === 'user')?.content).toBe(PROMPT)
  })

  it('registers and dispatches a cron task when pendingQueue is already at its cap', () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue(100, 1)
    queue.setLifecycle(lifecycle)
    expect(queue.enqueue(queue.createInternalTask('filler'))).toBe(true)

    const sessionProcessor = { enqueue: vi.fn() }
    const scheduler = new CronScheduler(queue)
    wireCronDispatch(scheduler, {
      sessionProcessor: sessionProcessor as unknown as SessionProcessor,
      pendingCronResults: { set: () => undefined },
      sanitizeAttachments: attachments => attachments,
    })

    const job = scheduler.createJob(
      'deploy',
      '* * * * *',
      PROMPT,
      undefined,
      {
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'reply-1',
      },
      teamsIdentity()
    )
    job!.providerIdentity = {
      ...job!.providerIdentity!,
      providerEventId: 'evt-should-not-fire',
    }

    const task = scheduler.triggerJob(job!.id)

    expect(task).not.toBeNull()
    expect(lifecycle.getStatus(task!.id)).toBe('pending')
    expect(sessionProcessor.enqueue).toHaveBeenCalledTimes(1)
    expect(sessionProcessor.enqueue).toHaveBeenCalledWith(expect.any(String), task)
    expect(task!.sourceMessage?.messageId).toBe(`cron-${task!.id}`)
    expect(task!.sourceMessage?.content).toBe(PROMPT)
    expect(task!.sourceMessage?.channelId).toBe('19:conversation')
    expect(task!.sourceMessage?.threadId).toBe('reply-1')
    expect(task!.sourceMessage?.providerIdentity?.providerChannelId).toBe('19:channel')
    expect(task!.sourceMessage?.providerIdentity).not.toHaveProperty('providerEventId')
    scheduler.stop()
  })
})

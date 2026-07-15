import { describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import {
  CronManageTool,
  STATELESS_CRON_FORBIDDEN_MESSAGE,
  STATELESS_CRON_NOTICE,
} from '../cronManage'

function createScheduler(): CronScheduler {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  return new CronScheduler(queue)
}

describe('CronManageTool — stateless cron policy', () => {
  it('defaults stateless hosts to forbid create and enable without opening HITL approval', async () => {
    const scheduler = createScheduler()
    const tool = new CronManageTool(scheduler, undefined, true)

    expect(tool.requiresApproval()).toBe(false)

    const created = await tool.execute({
      action: 'create',
      name: 'daily',
      schedule: '0 0 * * *',
      task: 'do it',
    })
    expect(created.is_error).toBe(true)
    expect(created.content).toContain(STATELESS_CRON_FORBIDDEN_MESSAGE)
    expect(scheduler.hasEnabledJobs()).toBe(false)

    const existing = scheduler.createJob('existing', '0 * * * *', 'do it')!
    scheduler.disableJob(existing.id)
    const enabled = await tool.execute({ action: 'enable', jobId: existing.id })
    expect(enabled.is_error).toBe(true)
    expect(enabled.content).toContain(STATELESS_CRON_FORBIDDEN_MESSAGE)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('preserves current HITL and stateless notice behavior when explicitly allowed', async () => {
    const scheduler = createScheduler()
    const tool = new CronManageTool(scheduler, undefined, true, true)

    expect(tool.requiresApproval()).toBe(true)

    const created = await tool.execute({
      action: 'create',
      name: 'daily',
      schedule: '0 0 * * *',
      task: 'do it',
    })
    expect(created.is_error).toBe(false)
    expect(created.content).toContain(STATELESS_CRON_NOTICE)
    expect(scheduler.hasEnabledJobs()).toBe(true)
  })
})

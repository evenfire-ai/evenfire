import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue } from '../../queue/messageQueue'
import { STATELESS_ALLOW_CRON_MANAGE_ENV, STATELESS_LIFECYCLE_ENV } from '../../statelessCronPolicy'
import { CronScheduler } from '../cronScheduler'

function createQueue(): MessageQueue {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  return queue
}

describe('CronScheduler — stateless cron policy', () => {
  const originalLifecycle = process.env[STATELESS_LIFECYCLE_ENV]
  const originalAllow = process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalLifecycle === undefined) delete process.env[STATELESS_LIFECYCLE_ENV]
    else process.env[STATELESS_LIFECYCLE_ENV] = originalLifecycle
    if (originalAllow === undefined) delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
    else process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = originalAllow
  })

  it('keeps newly created schedules disabled when enabled schedules are forbidden', () => {
    const scheduler = new CronScheduler(createQueue(), { allowEnabledJobs: false })
    const job = scheduler.createJob('daily', '0 0 * * *', 'do it')!

    expect(job.enabled).toBe(false)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('disables imported enabled schedules before start can program timers', () => {
    const source = new CronScheduler(createQueue())
    source.createJob('daily', '0 0 * * *', 'do it')

    const scheduler = new CronScheduler(createQueue(), { allowEnabledJobs: false })
    expect(scheduler.importJobs(source.exportJobs())).toBe(1)
    scheduler.start()

    expect(scheduler.getAllJobs()).toHaveLength(1)
    expect(scheduler.getAllJobs()[0].enabled).toBe(false)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('rejects re-enable attempts when enabled schedules are forbidden', () => {
    const scheduler = new CronScheduler(createQueue(), { allowEnabledJobs: false })
    const job = scheduler.createJob('daily', '0 0 * * *', 'do it')!

    expect(scheduler.enableJob(job.id)).toBe(false)
    expect(scheduler.getJob(job.id)?.enabled).toBe(false)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('defaults to the stateless lifecycle environment when no constructor option is provided', () => {
    process.env[STATELESS_LIFECYCLE_ENV] = 'true'
    delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]

    const scheduler = new CronScheduler(createQueue())
    const job = scheduler.createJob('daily', '0 0 * * *', 'do it')!

    expect(job.enabled).toBe(false)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('preserves enabled schedules for stateless hosts when cron management is explicitly allowed', () => {
    process.env[STATELESS_LIFECYCLE_ENV] = 'true'
    process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'

    const scheduler = new CronScheduler(createQueue())
    const job = scheduler.createJob('daily', '0 0 * * *', 'do it')!

    expect(job.enabled).toBe(true)
    expect(scheduler.hasEnabledJobs()).toBe(true)
  })
})

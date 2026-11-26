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
    vi.useRealTimers()
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

  it('never runs a schedule created under the policy, while an allowed scheduler does', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-26T12:00:30.000Z'))
    const queue = createQueue()
    const createTask = vi.spyOn(queue, 'createTaskFromCron')
    const runsOf = (jobId: string) => createTask.mock.calls.filter(([id]) => id === jobId).length
    const blocked = new CronScheduler(queue, { allowEnabledJobs: false })
    const allowed = new CronScheduler(queue, { allowEnabledJobs: true })
    const job = blocked.createJob('blocked', '*/1 * * * *', 'blocked task')!
    expect(blocked.enableJob(job.id)).toBe(false)
    const witness = allowed.createJob('control', '*/1 * * * *', 'control task')!
    blocked.start()
    allowed.start()

    vi.advanceTimersByTime(31_000) // 12:01:01

    expect({ blocked: runsOf(job.id), control: runsOf(witness.id) }).toEqual({
      blocked: 0,
      control: 1,
    })
    blocked.stop()
    allowed.stop()
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

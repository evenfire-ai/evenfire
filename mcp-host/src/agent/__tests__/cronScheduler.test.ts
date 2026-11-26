import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue } from '../../queue/messageQueue'
import { CronScheduler } from '../cronScheduler'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockQueue(): MessageQueue {
  const queue = new MessageQueue()
  // Spy on enqueue so we can verify tasks are created
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  return queue
}

// ---------------------------------------------------------------------------
// CronScheduler — Job CRUD
// ---------------------------------------------------------------------------

describe('CronScheduler — Job CRUD', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue

  beforeEach(() => {
    queue = createMockQueue()
    scheduler = new CronScheduler(queue)
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should start with zero jobs', () => {
    expect(scheduler.getAllJobs()).toHaveLength(0)
  })

  it('should create a job with valid schedule', () => {
    const job = scheduler.createJob('test-job', '*/5 * * * *', 'run health check')
    expect(job).not.toBeNull()
    expect(job!.name).toBe('test-job')
    expect(job!.schedule).toBe('*/5 * * * *')
    expect(job!.task).toBe('run health check')
    expect(job!.enabled).toBe(true)
    expect(job!.id).toBeTruthy()
    expect(job!.nextRun).toBeInstanceOf(Date)
    expect(job!.createdAt).toBeInstanceOf(Date)
  })

  it('should return null for invalid schedule (wrong field count)', () => {
    const job = scheduler.createJob('bad', '* *', 'task')
    expect(job).toBeNull()
  })

  it('should assign unique IDs to each job', () => {
    const job1 = scheduler.createJob('j1', '0 * * * *', 'task1')
    const job2 = scheduler.createJob('j2', '0 * * * *', 'task2')
    expect(job1!.id).not.toBe(job2!.id)
  })

  it('should store createdBy when provided', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task', 'task-123')
    expect(job!.createdBy).toBe('task-123')
  })

  it('should store origin when provided', () => {
    const origin = {
      channelType: 'telegram' as const,
      channelId: '-5130716657',
      sender: '516801777',
    }
    const job = scheduler.createJob('with-origin', '0 * * * *', 'task', undefined, origin)
    expect(job!.origin).toEqual(origin)
  })

  it('should leave origin undefined when not provided', () => {
    const job = scheduler.createJob('no-origin', '0 * * * *', 'task')
    expect(job!.origin).toBeUndefined()
  })

  it('should list all created jobs', () => {
    scheduler.createJob('j1', '0 * * * *', 't1')
    scheduler.createJob('j2', '0 0 * * *', 't2')
    scheduler.createJob('j3', '*/10 * * * *', 't3')
    expect(scheduler.getAllJobs()).toHaveLength(3)
  })

  it('should get a job by ID', () => {
    const created = scheduler.createJob('find-me', '0 * * * *', 'task')
    const found = scheduler.getJob(created!.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('find-me')
  })

  it('should return null for non-existent job ID', () => {
    expect(scheduler.getJob('non-existent')).toBeNull()
  })

  it('should delete a job', () => {
    const job = scheduler.createJob('del-me', '0 * * * *', 'task')
    expect(scheduler.deleteJob(job!.id)).toBe(true)
    expect(scheduler.getJob(job!.id)).toBeNull()
    expect(scheduler.getAllJobs()).toHaveLength(0)
  })

  it('should return false when deleting non-existent job', () => {
    expect(scheduler.deleteJob('no-such-id')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — Enable / Disable
// ---------------------------------------------------------------------------

describe('CronScheduler — Enable / Disable', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should disable a job', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    expect(scheduler.disableJob(job!.id)).toBe(true)
    expect(scheduler.getJob(job!.id)!.enabled).toBe(false)
  })

  it('should re-enable a disabled job', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    scheduler.disableJob(job!.id)
    expect(scheduler.enableJob(job!.id)).toBe(true)
    expect(scheduler.getJob(job!.id)!.enabled).toBe(true)
  })

  it('should return false for enable/disable on non-existent ID', () => {
    expect(scheduler.enableJob('nope')).toBe(false)
    expect(scheduler.disableJob('nope')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — Trigger (manual execution)
// ---------------------------------------------------------------------------

describe('CronScheduler — Trigger', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue

  beforeEach(() => {
    queue = createMockQueue()
    scheduler = new CronScheduler(queue)
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should manually trigger a job and enqueue a task', () => {
    const job = scheduler.createJob('trigger-me', '0 * * * *', 'do something')
    const task = scheduler.triggerJob(job!.id)

    expect(task).not.toBeNull()
    expect(task!.source).toBe('cron')
    expect(task!.cronJobId).toBe(job!.id)
    expect(queue.enqueue).toHaveBeenCalledWith(task)
  })

  it('should update lastRun on trigger', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    expect(job!.lastRun).toBeUndefined()

    scheduler.triggerJob(job!.id)
    const updated = scheduler.getJob(job!.id)
    expect(updated!.lastRun).toBeInstanceOf(Date)
  })

  it('should return null for non-existent job', () => {
    expect(scheduler.triggerJob('nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — Events
// ---------------------------------------------------------------------------

describe('CronScheduler — Events', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it("should emit 'cron:created' on job creation", () => {
    const handler = vi.fn()
    scheduler.on('cron:created', handler)

    const job = scheduler.createJob('j', '0 * * * *', 'task')
    expect(handler).toHaveBeenCalledWith(job)
  })

  it("should emit 'cron:deleted' on job deletion", () => {
    const handler = vi.fn()
    scheduler.on('cron:deleted', handler)

    const job = scheduler.createJob('j', '0 * * * *', 'task')
    scheduler.deleteJob(job!.id)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].id).toBe(job!.id)
  })

  it("should emit 'cron:triggered' on manual trigger", () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    const job = scheduler.createJob('j', '0 * * * *', 'task')
    scheduler.triggerJob(job!.id)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].job.id).toBe(job!.id)
    expect(handler.mock.calls[0][0].task).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — Start / Stop
// ---------------------------------------------------------------------------

describe('CronScheduler — Start / Stop', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('should not schedule jobs before start()', () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    // Create job but don't start scheduler
    scheduler.createJob('j', '*/5 * * * *', 'task')

    // Advance time well past 5 minutes
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('should schedule enabled jobs on start()', () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    // Create job, then start
    scheduler.createJob('j', '*/5 * * * *', 'task')
    scheduler.start()

    // Advance past next trigger
    vi.advanceTimersByTime(6 * 60 * 1000)
    expect(handler).toHaveBeenCalled()
  })

  it('should not schedule disabled jobs on start()', () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    const job = scheduler.createJob('j', '*/5 * * * *', 'task')
    scheduler.disableJob(job!.id)
    scheduler.start()

    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('should clear all timers on stop()', () => {
    scheduler.createJob('j1', '*/5 * * * *', 'task1')
    scheduler.createJob('j2', '0 * * * *', 'task2')
    scheduler.start()

    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    scheduler.stop()

    vi.advanceTimersByTime(120 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('should be idempotent: calling start() twice is safe', () => {
    scheduler.start()
    scheduler.start() // should not throw or double-schedule
    scheduler.stop()
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — setTimeout overflow guard
// ---------------------------------------------------------------------------

describe('CronScheduler — setTimeout overflow guard', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue

  beforeEach(() => {
    vi.useFakeTimers()
    queue = createMockQueue()
    scheduler = new CronScheduler(queue)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('should not execute a job whose next run is > 24.8 days away', () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    // Create a job scheduled for a specific month far in the future
    // e.g. "0 0 1 1 *" = Jan 1 at midnight — will be ~10 months away
    const job = scheduler.createJob('far-future', '0 0 1 1 *', 'task')
    scheduler.start()

    // Advance 1 hour — should NOT have fired
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('should use relay timers instead of overflowing setTimeout', () => {
    const handler = vi.fn()
    scheduler.on('cron:triggered', handler)

    const job = scheduler.createJob('far-future', '0 0 1 1 *', 'task')
    scheduler.start()

    // Advance by a large amount but less than the actual delay — should
    // re-enter scheduleJob via relay but still not execute
    vi.advanceTimersByTime(25 * 24 * 60 * 60 * 1000) // 25 days
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — Schedule validation (indirect parseNextRun tests)
// ---------------------------------------------------------------------------

describe('CronScheduler — Schedule validation', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it("should accept '0 * * * *' (every hour at :00)", () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    expect(job).not.toBeNull()
    expect(job!.nextRun).toBeInstanceOf(Date)
    expect(job!.nextRun!.getMinutes()).toBe(0)
  })

  it("should accept '0 0 * * *' (daily at midnight)", () => {
    const job = scheduler.createJob('j', '0 0 * * *', 'task')
    expect(job).not.toBeNull()
    expect(job!.nextRun!.getHours()).toBe(0)
    expect(job!.nextRun!.getMinutes()).toBe(0)
  })

  it("should accept '0 9 * * 1' (Monday at 9am)", () => {
    const job = scheduler.createJob('j', '0 9 * * 1', 'task')
    expect(job).not.toBeNull()
    expect(job!.nextRun!.getDay()).toBe(1) // Monday
  })

  it("should accept '*/5 * * * *' (every 5 minutes)", () => {
    const job = scheduler.createJob('j', '*/5 * * * *', 'task')
    expect(job).not.toBeNull()
    expect(job!.nextRun!.getMinutes() % 5).toBe(0)
  })

  it('should reject empty string', () => {
    expect(scheduler.createJob('j', '', 'task')).toBeNull()
  })

  it('should reject too few fields', () => {
    expect(scheduler.createJob('j', '* *', 'task')).toBeNull()
  })

  it('should reject too many fields', () => {
    expect(scheduler.createJob('j', '* * * * * *', 'task')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Next run after a fire: every occurrence once, early and late timers
// ---------------------------------------------------------------------------

describe('CronScheduler — next run after a fire', () => {
  let scheduler: CronScheduler
  let fired: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-26T12:00:30.000Z'))
    scheduler = new CronScheduler(createMockQueue())
    fired = []
    scheduler.on('cron:triggered', () => fired.push(new Date().toISOString()))
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('runs an every-minute schedule in every minute', () => {
    scheduler.start()
    const job = scheduler.createJob('every-minute', '*/1 * * * *', 'task')!
    vi.advanceTimersByTime(270_500) // to 12:05:00.500
    expect(fired).toEqual([
      '2026-11-26T12:01:00.000Z',
      '2026-11-26T12:02:00.000Z',
      '2026-11-26T12:03:00.000Z',
      '2026-11-26T12:04:00.000Z',
      '2026-11-26T12:05:00.000Z',
    ])
    expect(job.nextRun!.toISOString()).toBe('2026-11-26T12:06:00.000Z')
  })

  it('does not run twice in one minute when the timer fires before the scheduled time', () => {
    scheduler.start()
    const job = scheduler.createJob('every-minute', '*/1 * * * *', 'task')! // due 12:01:00.000, in 30 s
    // setSystemTime moves pending timers with the clock: the timer still fires
    // 30 s from now, when Date.now() reads 12:00:59.990 (10 ms before runAt).
    vi.setSystemTime(new Date('2026-11-26T12:00:29.990Z'))
    vi.advanceTimersByTime(30_000) // fires at 12:00:59.990
    vi.advanceTimersByTime(1_000) // 12:01:00.990
    expect(fired).toEqual(['2026-11-26T12:00:59.990Z'])
    expect(job.nextRun!.toISOString()).toBe('2026-11-26T12:02:00.000Z')
    vi.advanceTimersByTime(59_010) // liveness: the next minute does run
    expect(fired).toEqual(['2026-11-26T12:00:59.990Z', '2026-11-26T12:02:00.000Z'])
  })

  it('does not replay the minutes a late timer missed', () => {
    scheduler.start()
    const job = scheduler.createJob('every-minute', '*/1 * * * *', 'task')! // due 12:01:00.000, in 30 s
    vi.setSystemTime(new Date('2026-11-26T12:05:00.000Z')) // the timer now fires at 12:05:30, 4.5 min late
    vi.advanceTimersByTime(30_000)
    expect(fired).toEqual(['2026-11-26T12:05:30.000Z'])
    expect(job.nextRun!.toISOString()).toBe('2026-11-26T12:06:00.000Z')
    vi.advanceTimersByTime(30_000) // liveness
    expect(fired).toEqual(['2026-11-26T12:05:30.000Z', '2026-11-26T12:06:00.000Z'])
  })
})

// ---------------------------------------------------------------------------
// Re-enabling: a disabled job waits for its next cron time; an enabled job
// keeps its pending run
// ---------------------------------------------------------------------------

describe('CronScheduler — re-enabling a disabled job', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-26T12:00:30.000Z'))
    queue = createMockQueue()
    scheduler = new CronScheduler(queue)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('runs a re-enabled job at its next cron time, not at once', () => {
    const createTask = vi.spyOn(queue, 'createTaskFromCron')
    const runsOf = (jobId: string) => createTask.mock.calls.filter(([id]) => id === jobId).length
    scheduler.start()
    const target = scheduler.createJob('target', '*/5 * * * *', 'target task')! // nextRun 12:05
    const control = scheduler.createJob('control', '*/5 * * * *', 'control task')!
    expect(scheduler.disableJob(target.id)).toBe(true)

    vi.advanceTimersByTime(10 * 60_000) // 12:10:30: control ran at 12:05 and 12:10
    expect(scheduler.enableJob(target.id)).toBe(true)
    vi.advanceTimersByTime(60_000) // 12:11:30

    expect({ target: runsOf(target.id), control: runsOf(control.id) }).toEqual({
      target: 0,
      control: 2,
    })
    expect(target.nextRun!.toISOString()).toBe('2026-11-26T12:15:00.000Z')

    vi.advanceTimersByTime(3 * 60_000 + 30_000) // 12:15:00, liveness for the re-enabled job
    expect({ target: runsOf(target.id), control: runsOf(control.id) }).toEqual({
      target: 1,
      control: 3,
    })
  })

  it('keeps the pending run of an enabled job that is enabled again after an early fire', () => {
    const fired: string[] = []
    scheduler.on('cron:triggered', () => fired.push(new Date().toISOString()))
    scheduler.start()
    const job = scheduler.createJob('every-minute', '*/1 * * * *', 'task')! // due 12:01:00.000
    vi.setSystemTime(new Date('2026-11-26T12:00:29.990Z')) // the timer fires 10 ms early
    vi.advanceTimersByTime(30_000) // fires at 12:00:59.990, nextRun becomes 12:02
    expect(scheduler.enableJob(job.id)).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual(['2026-11-26T12:00:59.990Z'])
    expect(job.nextRun!.toISOString()).toBe('2026-11-26T12:02:00.000Z')
    vi.advanceTimersByTime(59_010) // liveness: the pending run still happens
    expect(fired).toEqual(['2026-11-26T12:00:59.990Z', '2026-11-26T12:02:00.000Z'])
  })

  it('keeps a due run of an enabled job that is enabled again before its timer fires', () => {
    const fired: string[] = []
    scheduler.on('cron:triggered', () => fired.push(new Date().toISOString()))
    scheduler.start()
    const job = scheduler.createJob('every-five', '*/5 * * * *', 'task')! // due 12:05:00.000
    vi.setSystemTime(new Date('2026-11-26T12:05:00.000Z')) // due now, timer not fired yet
    expect(scheduler.enableJob(job.id)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['2026-11-26T12:05:00.000Z'])
  })
})

// ---------------------------------------------------------------------------
// Re-enabling an enabled job must not leave an orphaned timer behind
// ---------------------------------------------------------------------------

describe('CronScheduler — repeated enableJob leaves no orphaned timer', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue

  beforeEach(() => {
    vi.useFakeTimers()
    // Mid-minute, so the every-minute schedule fires 30s from now.
    vi.setSystemTime(new Date('2026-11-26T12:00:30.000Z'))
    queue = createMockQueue()
    scheduler = new CronScheduler(queue)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('does not run a job that was enabled twice and then disabled, and runs an enabled job once', () => {
    const createTask = vi.spyOn(queue, 'createTaskFromCron')
    scheduler.start()
    const target = scheduler.createJob('target', '*/1 * * * *', 'target task')!
    const control = scheduler.createJob('control', '*/1 * * * *', 'control task')!

    expect(scheduler.enableJob(target.id)).toBe(true)
    expect(scheduler.enableJob(target.id)).toBe(true)
    expect(scheduler.enableJob(control.id)).toBe(true)
    expect(scheduler.enableJob(control.id)).toBe(true)
    expect(scheduler.disableJob(target.id)).toBe(true)

    // Just past the first fire (30s), before the next minute boundary.
    vi.advanceTimersByTime(31_000)

    const runsOf = (jobId: string) => createTask.mock.calls.filter(([id]) => id === jobId).length
    // The control count is the liveness witness: the timer path ran and fired
    // the enabled job exactly once. One assertion reports both counts.
    expect({ target: runsOf(target.id), control: runsOf(control.id) }).toEqual({
      target: 0,
      control: 1,
    })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// CronScheduler — hasEnabledJobs (cron×stateless D8 probe)
// ---------------------------------------------------------------------------

describe('CronScheduler — hasEnabledJobs (cron×stateless D8 probe)', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('returns false when no jobs exist', () => {
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })

  it('returns true with at least one enabled schedule', () => {
    scheduler.createJob('a', '*/5 * * * *', 'task a')
    expect(scheduler.hasEnabledJobs()).toBe(true)
  })

  it('returns false when every schedule is disabled, true again after re-enable', () => {
    const a = scheduler.createJob('a', '*/5 * * * *', 'task a')!
    const b = scheduler.createJob('b', '0 9 * * 1', 'task b')!
    scheduler.disableJob(a.id)
    expect(scheduler.hasEnabledJobs()).toBe(true) // b still enabled
    scheduler.disableJob(b.id)
    expect(scheduler.hasEnabledJobs()).toBe(false)
    scheduler.enableJob(a.id)
    expect(scheduler.hasEnabledJobs()).toBe(true)
  })

  it('returns false after the last job is deleted', () => {
    const a = scheduler.createJob('a', '*/5 * * * *', 'task a')!
    scheduler.deleteJob(a.id)
    expect(scheduler.hasEnabledJobs()).toBe(false)
  })
})

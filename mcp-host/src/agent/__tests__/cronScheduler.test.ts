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
// CronScheduler — Update
// ---------------------------------------------------------------------------

describe('CronScheduler — Update', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should update job name', () => {
    const job = scheduler.createJob('old-name', '0 * * * *', 'task')
    const updated = scheduler.updateJob(job!.id, { name: 'new-name' })
    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('new-name')
  })

  it('should update job task', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'old-task')
    const updated = scheduler.updateJob(job!.id, { task: 'new-task' })
    expect(updated!.task).toBe('new-task')
  })

  it('should update schedule and recompute nextRun', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    const oldNextRun = job!.nextRun
    const updated = scheduler.updateJob(job!.id, { schedule: '*/10 * * * *' })
    expect(updated!.schedule).toBe('*/10 * * * *')
    // nextRun should be recomputed (may or may not differ, but should be a Date)
    expect(updated!.nextRun).toBeInstanceOf(Date)
  })

  it('should return null for invalid schedule update', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    const updated = scheduler.updateJob(job!.id, { schedule: 'bad' })
    expect(updated).toBeNull()
  })

  it('should return null for non-existent job', () => {
    expect(scheduler.updateJob('nope', { name: 'x' })).toBeNull()
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
// CronScheduler — Export / Import
// ---------------------------------------------------------------------------

describe('CronScheduler — Export / Import', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = new CronScheduler(createMockQueue())
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should export jobs as JSON', () => {
    scheduler.createJob('j1', '0 * * * *', 'task1')
    scheduler.createJob('j2', '*/5 * * * *', 'task2')

    const json = scheduler.exportJobs()
    const parsed = JSON.parse(json)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].name).toBe('j1')
    expect(parsed[1].name).toBe('j2')
  })

  it('should import jobs from JSON', () => {
    scheduler.createJob('j1', '0 * * * *', 'task1')
    const json = scheduler.exportJobs()

    // Create a fresh scheduler and import
    const scheduler2 = new CronScheduler(createMockQueue())
    const count = scheduler2.importJobs(json)
    expect(count).toBe(1)
    expect(scheduler2.getAllJobs()).toHaveLength(1)
    expect(scheduler2.getAllJobs()[0].name).toBe('j1')
    scheduler2.stop()
  })

  it('should return 0 for invalid JSON import', () => {
    expect(scheduler.importJobs('not json')).toBe(0)
  })

  it('should preserve origin through export/import', () => {
    const origin = {
      channelType: 'telegram' as const,
      channelId: '-5130716657',
      sender: '516801777',
    }
    scheduler.createJob('with-origin', '0 * * * *', 'task', undefined, origin)
    const json = scheduler.exportJobs()

    const scheduler2 = new CronScheduler(createMockQueue())
    scheduler2.importJobs(json)
    const imported = scheduler2.getAllJobs()[0]

    expect(imported.origin).toBeDefined()
    expect(imported.origin!.channelType).toBe('telegram')
    expect(imported.origin!.channelId).toBe('-5130716657')
    expect(imported.origin!.sender).toBe('516801777')
    scheduler2.stop()
  })

  it('should preserve jobs without origin through export/import', () => {
    scheduler.createJob('no-origin', '0 * * * *', 'task')
    const json = scheduler.exportJobs()

    const scheduler2 = new CronScheduler(createMockQueue())
    scheduler2.importJobs(json)
    const imported = scheduler2.getAllJobs()[0]

    expect(imported.origin).toBeUndefined()
    scheduler2.stop()
  })

  it('should round-trip dates correctly', () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    const json = scheduler.exportJobs()

    const scheduler2 = new CronScheduler(createMockQueue())
    scheduler2.importJobs(json)
    const imported = scheduler2.getAllJobs()[0]

    expect(imported.createdAt).toBeInstanceOf(Date)
    expect(imported.nextRun).toBeInstanceOf(Date)
    scheduler2.stop()
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
// Double-fire prevention (BUG: setTimeout fires slightly early)
// ---------------------------------------------------------------------------

describe('CronScheduler — no double-fire after execution', () => {
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

  it('should not re-execute within the same cron minute window', () => {
    // Use */1 pattern (every minute) — easier to test with fake timers.
    // The bug: after executeJob, parseNextRun(schedule) can return a time
    // in the same minute window, causing immediate re-fire (delay = 0s).
    // The fix: pass a "from" date 60s in the future to skip the current window.
    scheduler.start()
    const job = scheduler.createJob('once-test', '*/1 * * * *', 'task')
    expect(job).not.toBeNull()

    // The job's nextRun should be within the next minute
    const delay = job!.nextRun!.getTime() - Date.now()
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(60_000)

    // Fire the first execution
    vi.advanceTimersByTime(delay + 100)
    const callCount1 = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callCount1).toBe(1)

    // After the fix, next run should be ≥60s away (not 0s)
    expect(job!.nextRun).toBeDefined()
    const nextDelay = job!.nextRun!.getTime() - Date.now()
    expect(nextDelay).toBeGreaterThan(30_000) // at least 30s, not 0
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

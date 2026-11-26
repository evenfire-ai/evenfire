import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import { MessageQueue, Task } from '../queue'
import { statelessCronSchedulesAllowed, statelessLifecycleEnabled } from '../statelessCronPolicy'
import { parseNextRun } from './cronExpression'
import { CronJob } from './types'

// Maximum safe delay for setTimeout (2^31 - 1 ms ≈ 24.8 days).
// Exceeding this causes Node.js to silently set the timeout to 1ms.
const MAX_SAFE_TIMEOUT = 2_147_483_647

export class CronScheduler extends EventEmitter {
  private jobs: Map<string, CronJob> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private queue: MessageQueue
  private isRunning: boolean = false
  private readonly allowEnabledJobs: boolean

  constructor(
    queue: MessageQueue,
    options: { statelessLifecycle?: boolean; allowEnabledJobs?: boolean } = {}
  ) {
    super()
    this.queue = queue
    this.allowEnabledJobs =
      options.allowEnabledJobs ??
      statelessCronSchedulesAllowed(options.statelessLifecycle ?? statelessLifecycleEnabled())
  }

  start(): void {
    if (this.isRunning) return

    logger.info({ component: 'Cron' }, 'Starting scheduler')
    this.isRunning = true

    for (const job of this.jobs.values()) {
      if (!this.allowEnabledJobs && job.enabled) {
        this.disableJobForPolicy(job)
      }
      if (job.enabled) {
        this.scheduleJob(job)
      }
    }
  }

  stop(): void {
    logger.info({ component: 'Cron' }, 'Stopping scheduler')
    this.isRunning = false

    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  /**
   * Cron×stateless (D8 `activeCronSchedules` condition): cheapest fresh
   * introspection of the store — scan the in-RAM jobs map for any ENABLED
   * schedule. Disabled jobs do not pin the idle gauge.
   */
  hasEnabledJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.enabled) return true
    }
    return false
  }

  /**
   * Create a new cron job.
   */
  createJob(
    name: string,
    schedule: string,
    task: string,
    createdBy?: string,
    origin?: CronJob['origin']
  ): CronJob | null {
    // Validate schedule
    const nextRun = parseNextRun(schedule)
    if (!nextRun) {
      logger.error({ component: 'Cron', schedule }, 'Invalid schedule')
      return null
    }

    const job: CronJob = {
      id: uuidv4(),
      name,
      schedule,
      task,
      enabled: this.allowEnabledJobs,
      nextRun,
      createdAt: new Date(),
      createdBy,
      origin,
    }

    this.jobs.set(job.id, job)
    logger.info(
      { component: 'Cron', jobId: job.id, jobName: name, schedule, nextRun: nextRun.toISOString() },
      'Created job'
    )

    if (this.isRunning) {
      if (job.enabled) {
        this.scheduleJob(job)
      } else {
        logger.info({ component: 'Cron', jobId: job.id, jobName: name }, 'Policy kept job disabled')
      }
    }

    this.emit('cron:created', job)
    return job
  }

  getJob(jobId: string): CronJob | null {
    return this.jobs.get(jobId) || null
  }

  getAllJobs(): CronJob[] {
    return Array.from(this.jobs.values())
  }

  enableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    if (!this.allowEnabledJobs) {
      this.disableJobForPolicy(job)
      return false
    }

    job.enabled = true
    if (this.isRunning) {
      // Replace, never add: an already-enabled job keeps one timer.
      const timer = this.timers.get(jobId)
      if (timer) clearTimeout(timer)
      this.scheduleJob(job)
    }

    logger.info({ component: 'Cron', jobId, jobName: job.name }, 'Enabled job')
    return true
  }

  disableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    job.enabled = false

    const timer = this.timers.get(jobId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(jobId)
    }

    logger.info({ component: 'Cron', jobId, jobName: job.name }, 'Disabled job')
    return true
  }

  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    const timer = this.timers.get(jobId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(jobId)
    }

    this.jobs.delete(jobId)
    logger.info({ component: 'Cron', jobId, jobName: job.name }, 'Deleted job')

    this.emit('cron:deleted', job)
    return true
  }

  private disableJobForPolicy(job: CronJob): void {
    job.enabled = false
    const timer = this.timers.get(job.id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(job.id)
    }
    logger.info(
      { component: 'Cron', jobId: job.id, jobName: job.name },
      'Stateless policy disabled schedule'
    )
  }

  updateJob(
    jobId: string,
    updates: Partial<Pick<CronJob, 'name' | 'schedule' | 'task'>>
  ): CronJob | null {
    const job = this.jobs.get(jobId)
    if (!job) return null

    if (updates.name) job.name = updates.name
    if (updates.task) job.task = updates.task

    if (updates.schedule) {
      const nextRun = parseNextRun(updates.schedule)
      if (!nextRun) {
        logger.error({ component: 'Cron', jobId, schedule: updates.schedule }, 'Invalid schedule')
        return null
      }
      job.schedule = updates.schedule
      job.nextRun = nextRun
    }

    // Reschedule if running and enabled
    if (this.isRunning && job.enabled) {
      const timer = this.timers.get(jobId)
      if (timer) {
        clearTimeout(timer)
        this.timers.delete(jobId)
      }
      this.scheduleJob(job)
    }

    logger.info({ component: 'Cron', jobId, jobName: job.name }, 'Updated job')
    return job
  }

  triggerJob(jobId: string): Task | null {
    const job = this.jobs.get(jobId)
    if (!job) return null

    logger.info({ component: 'Cron', jobId, jobName: job.name }, 'Manually triggering job')
    return this.executeJob(job)
  }

  private scheduleJob(job: CronJob): void {
    if (!job.enabled || !job.nextRun) return

    const now = Date.now()
    const runAt = job.nextRun.getTime()
    const delay = Math.max(0, runAt - now)

    logger.info(
      {
        component: 'Cron',
        jobId: job.id,
        jobName: job.name,
        delaySeconds: Math.round(delay / 1000),
      },
      'Scheduling job'
    )

    // Guard against setTimeout overflow: delays > 2^31-1 ms cause Node.js
    // to silently set the timeout to 1ms, creating a runaway infinite loop.
    // Use a relay timer that wakes up at the safe max and re-checks.
    if (delay > MAX_SAFE_TIMEOUT) {
      logger.info(
        {
          component: 'Cron',
          jobId: job.id,
          jobName: job.name,
          delayDays: Math.round(delay / 86_400_000),
        },
        'Delay exceeds setTimeout max, using relay timer'
      )
      const timer = setTimeout(() => {
        if (job.enabled && job.nextRun) {
          this.scheduleJob(job)
        }
      }, MAX_SAFE_TIMEOUT)
      this.timers.set(job.id, timer)
      return
    }

    const timer = setTimeout(() => {
      if (!job.enabled) return
      this.executeJob(job)

      // The next run is the first occurrence strictly after the one that just
      // fired (cron-parser's next() excludes `currentDate`). runAt covers a timer
      // that fires slightly early; Date.now() covers a late fire, so missed
      // occurrences are not replayed.
      const from = new Date(Math.max(Date.now(), runAt))
      job.nextRun = parseNextRun(job.schedule, from) ?? undefined
      if (job.nextRun && job.enabled) {
        this.scheduleJob(job)
      }
    }, delay)

    this.timers.set(job.id, timer)
  }

  private executeJob(job: CronJob): Task {
    logger.info({ component: 'Cron', jobId: job.id, jobName: job.name }, 'Executing job')
    job.lastRun = new Date()

    const task = this.queue.createTaskFromCron(job.id, job.task, job.origin, 'normal')
    this.queue.enqueue(task)

    this.emit('cron:triggered', { job, task })
    return task
  }

  exportJobs(): string {
    const jobs = Array.from(this.jobs.values()).map(job => ({
      ...job,
      lastRun: job.lastRun?.toISOString(),
      nextRun: job.nextRun?.toISOString(),
      createdAt: job.createdAt.toISOString(),
    }))
    return JSON.stringify(jobs, null, 2)
  }

  importJobs(json: string): number {
    try {
      const jobs = JSON.parse(json) as CronJob[]
      let imported = 0

      for (const jobData of jobs) {
        const job: CronJob = {
          ...jobData,
          lastRun: jobData.lastRun ? new Date(jobData.lastRun) : undefined,
          nextRun: jobData.nextRun ? new Date(jobData.nextRun) : undefined,
          createdAt: new Date(jobData.createdAt),
        }

        job.nextRun = parseNextRun(job.schedule) ?? undefined

        if (!this.allowEnabledJobs && job.enabled) {
          this.disableJobForPolicy(job)
        }

        this.jobs.set(job.id, job)
        if (this.isRunning && job.enabled) {
          this.scheduleJob(job)
        }
        imported++
      }

      logger.info({ component: 'Cron', imported }, 'Imported jobs')
      return imported
    } catch (error) {
      logger.error({ component: 'Cron', error }, 'Failed to import jobs')
      return 0
    }
  }
}

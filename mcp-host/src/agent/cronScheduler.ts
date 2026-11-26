import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { validateCronRecord } from '../db/cronJobs'
import { logger } from '../logger'
import { MessageQueue, Task } from '../queue'
import { statelessCronSchedulesAllowed, statelessLifecycleEnabled } from '../statelessCronPolicy'
import { parseNextRun } from './cronExpression'
import type { CronClaimArgs, CronDurableStore, CronJobRecord } from './cronStore'
import { CronJob } from './types'

// Maximum safe delay for setTimeout (2^31 - 1 ms ≈ 24.8 days).
// Exceeding this causes Node.js to silently set the timeout to 1ms.
export const MAX_SAFE_TIMEOUT = 2_147_483_647

/** Positive delay before a lost claim runs again. Not a delay-0 retry. */
export const CRON_CLAIM_BACKOFF_MS = 1000

/** SQLITE_BUSY on a claim is retried until this long after the first attempt. */
const CRON_CLAIM_BUSY_BUDGET_MS = 30_000

type ClaimFailureReason = 'busy_timeout' | 'sql_error'

function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000)
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  if (candidate.code === 'SQLITE_BUSY') return true
  return typeof candidate.message === 'string' && candidate.message.includes('SQLITE_BUSY')
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class CronScheduler extends EventEmitter {
  private jobs: Map<string, CronJob> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private readonly sleepResolvers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private queue: MessageQueue
  private isRunning: boolean = false
  private terminal = false
  private readonly allowEnabledJobs: boolean
  private readonly store: CronDurableStore | undefined
  private readonly now: () => number

  constructor(
    queue: MessageQueue,
    options: {
      statelessLifecycle?: boolean
      allowEnabledJobs?: boolean
      store?: CronDurableStore
      now?: () => number
    } = {}
  ) {
    super()
    this.queue = queue
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.allowEnabledJobs =
      options.allowEnabledJobs ??
      statelessCronSchedulesAllowed(options.statelessLifecycle ?? statelessLifecycleEnabled())
  }

  /**
   * Fills the in-memory map from the durable store. Does not arm timers.
   * Invalid rows are persisted disabled, including when provider identity is still set.
   */
  async loadFromStore(): Promise<void> {
    if (!this.store || this.terminal) return
    const rows = await this.store.load()
    for (const row of rows) {
      if (this.terminal) return
      const { job, valid } = validateCronRecord(row)
      if (!valid) {
        const wrote = await this.retryBusy(
          () => this.store!.setSchedule(job.id, false, null),
          job.id
        )
        if (!wrote) return
        job.enabled = false
        job.nextRun = undefined
        logger.info({ jobId: job.id, component: 'Cron' }, 'Disabled invalid cron job')
      }
      this.jobs.set(job.id, job)
    }
  }

  start(): void {
    if (this.terminal || this.isRunning) return

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
    this.terminal = true
    this.isRunning = false

    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()

    for (const [timer, resolve] of this.sleepResolvers) {
      clearTimeout(timer)
      resolve()
    }
    this.sleepResolvers.clear()
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
      logger.error({ schedule, component: 'Cron' }, 'Invalid cron schedule')
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
    logger.info({ jobId: job.id, name, schedule, component: 'Cron' }, 'Created cron job')
    logger.info(
      { jobId: job.id, nextRun: nextRun.toISOString(), component: 'Cron' },
      'Computed next cron run'
    )

    if (this.isRunning) {
      if (job.enabled) {
        this.scheduleJob(job)
      } else {
        logger.info({ jobId: job.id, name, component: 'Cron' }, 'Policy kept cron job disabled')
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
      this.scheduleJob(job)
    }

    logger.info({ jobId, name: job.name, component: 'Cron' }, 'Enabled cron job')
    return true
  }

  disableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    job.enabled = false
    this.clearTimer(jobId)

    logger.info({ jobId, name: job.name, component: 'Cron' }, 'Disabled cron job')
    return true
  }

  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    this.clearTimer(jobId)
    this.jobs.delete(jobId)
    logger.info({ jobId, name: job.name, component: 'Cron' }, 'Deleted cron job')

    this.emit('cron:deleted', job)
    return true
  }

  private disableJobForPolicy(job: CronJob): void {
    job.enabled = false
    this.clearTimer(job.id)
    logger.info(
      { jobId: job.id, name: job.name, component: 'Cron' },
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
        logger.error({ schedule: updates.schedule, component: 'Cron' }, 'Invalid cron schedule')
        return null
      }
      job.schedule = updates.schedule
      job.nextRun = nextRun
    }

    // Reschedule if running and enabled
    if (this.isRunning && job.enabled) {
      this.clearTimer(jobId)
      this.scheduleJob(job)
    }

    logger.info({ jobId, name: job.name, component: 'Cron' }, 'Updated cron job')
    return job
  }

  triggerJob(jobId: string): Task | null {
    const job = this.jobs.get(jobId)
    if (!job) return null

    logger.info({ jobId, name: job.name, component: 'Cron' }, 'Manually triggering cron job')
    return this.executeJob(job)
  }

  private scheduleJob(job: CronJob): void {
    if (this.terminal || !job.enabled || !job.nextRun) return

    const now = this.now()
    const runAt = job.nextRun.getTime()
    const delay = Math.max(0, runAt - now)

    logger.info(
      { jobId: job.id, name: job.name, delaySeconds: Math.round(delay / 1000), component: 'Cron' },
      'Scheduling cron job'
    )

    // Guard against setTimeout overflow: delays > 2^31-1 ms cause Node.js
    // to silently set the timeout to 1ms, creating a runaway infinite loop.
    // The relay wakes at the safe max and re-checks. It does not claim.
    if (delay > MAX_SAFE_TIMEOUT) {
      logger.info(
        { jobId: job.id, name: job.name, component: 'Cron' },
        'Cron delay exceeds setTimeout max, using relay timer'
      )
      this.armTimer(job.id, MAX_SAFE_TIMEOUT, () => {
        if (job.enabled && job.nextRun) this.scheduleJob(job)
      })
      return
    }

    if (this.store) {
      this.armTimer(job.id, delay, () => this.claimSlot(job))
      return
    }

    // Memory mode does not claim. Keep the 60s cushion so an early timer
    // does not schedule the same minute again.
    this.armTimer(job.id, delay, () => {
      this.executeJob(job)
      if (this.terminal) return
      const afterExecution = new Date(this.now() + 60_000)
      job.nextRun = parseNextRun(job.schedule, afterExecution) ?? undefined
      if (job.nextRun && job.enabled) this.scheduleJob(job)
    })
  }

  private armTimer(jobId: string, delay: number, fire: () => void | Promise<void>): void {
    this.clearTimer(jobId)
    const timer = setTimeout(() => {
      this.clearTimer(jobId)
      if (this.terminal) return
      try {
        const result = fire()
        if (isPromise(result)) {
          void result.catch(error => {
            logger.error({ err: error, jobId, component: 'Cron' }, 'Cron timer callback failed')
          })
        }
      } catch (error) {
        logger.error({ err: error, jobId, component: 'Cron' }, 'Cron timer callback failed')
      }
    }, delay)
    this.timers.set(jobId, timer)
  }

  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(jobId)
  }

  /**
   * Backoff is its own timer. Its callback is not the claim callback:
   * when the delay ends, and stop() is not terminal, it runs one claim.
   */
  private armBackoff(job: CronJob): void {
    logger.info({ jobId: job.id, component: 'Cron' }, 'Cron claim lost, backing off')
    this.armTimer(job.id, CRON_CLAIM_BACKOFF_MS, () => {
      if (this.terminal) return
      return this.claimSlot(job)
    })
  }

  private async claimSlot(job: CronJob): Promise<void> {
    if (this.terminal || !this.store || !job.enabled || !job.nextRun) return
    const slotMs = job.nextRun.getTime()
    const nowMs = this.now()
    const following = parseNextRun(job.schedule, new Date(Math.max(slotMs, nowMs)))
    if (!following) {
      job.enabled = false
      job.nextRun = undefined
      logger.error({ jobId: job.id, component: 'Cron' }, 'Cron schedule has no following run')
      await this.retryBusy(() => this.store!.setSchedule(job.id, false, null), job.id)
      return
    }

    const claimed = await this.claimWithBusyBudget({
      id: job.id,
      slotSeconds: unixSeconds(slotMs),
      nowSeconds: unixSeconds(nowMs),
      followingSeconds: unixSeconds(following.getTime()),
    })
    if (!claimed || this.terminal) return

    if (claimed.changes === 1) {
      job.nextRun = following
      job.lastRun = new Date(nowMs)
      if (this.terminal) return
      this.executeJob(job)
      this.scheduleJob(job)
      return
    }

    if (claimed.changes === 0) {
      await this.reconcileLostClaim(job)
    }
  }

  private async reconcileLostClaim(job: CronJob): Promise<void> {
    if (this.terminal || !this.store) return
    const row = await this.readWithBusyBudget(job.id)
    if (row === 'failed' || this.terminal) return
    if (row === null) {
      this.jobs.delete(job.id)
      return
    }
    if (!row.enabled || row.nextRunAt == null) {
      job.enabled = false
      job.nextRun = undefined
      return
    }

    const nextMs = row.nextRunAt * 1000
    job.nextRun = new Date(nextMs)
    job.enabled = true
    // A still-due row must not be armed at delay 0. A future row uses the relay rule.
    if (nextMs > this.now()) {
      this.scheduleJob(job)
      return
    }
    this.armBackoff(job)
  }

  private async claimWithBusyBudget(args: CronClaimArgs): Promise<{ changes: number } | null> {
    const store = this.store
    if (!store) return null
    const started = this.now()
    for (;;) {
      if (this.terminal) return null
      if (this.now() - started >= CRON_CLAIM_BUSY_BUDGET_MS) {
        this.exitOnClaimFailure(args.id, 'busy_timeout')
        return null
      }
      try {
        return await store.claim(args)
      } catch (error) {
        const again = await this.pauseForBusy(error, started, args.id)
        if (!again) return null
      }
    }
  }

  private async readWithBusyBudget(id: string): Promise<CronJobRecord | null | 'failed'> {
    const store = this.store
    if (!store) return 'failed'
    const started = this.now()
    for (;;) {
      if (this.terminal) return 'failed'
      try {
        return await store.read(id)
      } catch (error) {
        const again = await this.pauseForBusy(error, started, id)
        if (!again) return 'failed'
      }
    }
  }

  private async retryBusy(op: () => Promise<void>, jobId: string): Promise<boolean> {
    const started = this.now()
    for (;;) {
      if (this.terminal) return false
      try {
        await op()
        return true
      } catch (error) {
        const again = await this.pauseForBusy(error, started, jobId)
        if (!again) return false
      }
    }
  }

  /**
   * @returns true when the caller should try the write again.
   * Busy retries use a positive delay inside the budget. Anything else exits 1
   * and must not arm the slot at delay 0.
   */
  private async pauseForBusy(error: unknown, started: number, jobId: string): Promise<boolean> {
    if (this.terminal) return false
    const elapsed = this.now() - started
    const busy = isSqliteBusy(error)
    if (!busy || elapsed >= CRON_CLAIM_BUSY_BUDGET_MS) {
      this.exitOnClaimFailure(jobId, busy ? 'busy_timeout' : 'sql_error')
      return false
    }
    const remaining = CRON_CLAIM_BUSY_BUDGET_MS - elapsed
    const wait = Math.min(CRON_CLAIM_BACKOFF_MS, remaining)
    if (wait <= 0) {
      this.exitOnClaimFailure(jobId, 'busy_timeout')
      return false
    }
    await this.sleep(wait)
    if (this.terminal) return false
    if (this.now() - started >= CRON_CLAIM_BUSY_BUDGET_MS) {
      this.exitOnClaimFailure(jobId, 'busy_timeout')
      return false
    }
    return true
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.sleepResolvers.delete(timer)
        clearTimeout(timer)
        resolve()
      }, ms)
      this.sleepResolvers.set(timer, resolve)
    })
  }

  private exitOnClaimFailure(jobId: string, reason: ClaimFailureReason): void {
    logger.error({ jobId, reason, component: 'Cron' }, 'Cron claim failed')
    try {
      process.exit(1)
    } catch (error) {
      // A test double throws. Production process.exit does not return.
      // The caller returns without arming the slot at delay 0.
      logger.error(
        { err: error, jobId, component: 'Cron' },
        'Cron claim process exit returned control'
      )
    }
  }

  private executeJob(job: CronJob): Task {
    logger.info({ jobId: job.id, name: job.name, component: 'Cron' }, 'Executing cron job')
    job.lastRun = new Date(this.now())

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

      logger.info({ count: imported, component: 'Cron' }, 'Imported cron jobs')
      return imported
    } catch (error) {
      logger.error({ err: error, component: 'Cron' }, 'Failed to import cron jobs')
      return 0
    }
  }
}

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

/**
 * Memory callers keep a synchronous return. A configured store returns a
 * Promise that resolves only after the worker acknowledgement. The public
 * signature stays synchronous so a scheduler with no store does not have to
 * be awaited.
 */
function durableResult<T>(pending: Promise<T>): T {
  return pending as unknown as T
}

function storedProviderIdentity(
  identity: CronJob['providerIdentity']
): CronJob['providerIdentity'] | undefined {
  if (!identity) return undefined
  const stored: NonNullable<CronJob['providerIdentity']> = {
    medium: identity.medium,
    providerUserId: identity.providerUserId,
    providerChannelId: identity.providerChannelId,
  }
  if (identity.providerWorkspaceId !== undefined) {
    stored.providerWorkspaceId = identity.providerWorkspaceId
  }
  if (identity.providerChannelType !== undefined) {
    stored.providerChannelType = identity.providerChannelType
  }
  if (identity.providerTarget) {
    stored.providerTarget = {
      hostRef: identity.providerTarget.hostRef,
      communicationChannelNamespace: identity.providerTarget.communicationChannelNamespace,
      communicationChannelName: identity.providerTarget.communicationChannelName,
    }
    if (identity.providerTarget.providerBotId !== undefined) {
      stored.providerTarget.providerBotId = identity.providerTarget.providerBotId
    }
    if (identity.providerTarget.providerBotUsername !== undefined) {
      stored.providerTarget.providerBotUsername = identity.providerTarget.providerBotUsername
    }
  }
  return stored
}

function jobToRecord(job: CronJob): CronJobRecord {
  const identity = job.providerIdentity
  const target = identity?.providerTarget
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    task: job.task,
    enabled: job.enabled,
    nextRunAt: job.nextRun ? unixSeconds(job.nextRun.getTime()) : null,
    lastRunAt: job.lastRun ? unixSeconds(job.lastRun.getTime()) : null,
    createdAt: unixSeconds(job.createdAt.getTime()),
    createdBy: job.createdBy ?? null,
    origin: job.origin
      ? {
          channelType: job.origin.channelType,
          channelId: job.origin.channelId,
          sender: job.origin.sender,
          threadId: job.origin.threadId ?? null,
        }
      : null,
    provider: identity
      ? {
          medium: identity.medium,
          providerUserId: identity.providerUserId,
          providerWorkspaceId: identity.providerWorkspaceId ?? null,
          providerChannelId: identity.providerChannelId,
          providerChannelType: identity.providerChannelType ?? null,
          providerTarget: target
            ? {
                hostRef: target.hostRef,
                communicationChannelNamespace: target.communicationChannelNamespace,
                communicationChannelName: target.communicationChannelName,
                providerBotId: target.providerBotId ?? null,
                providerBotUsername: target.providerBotUsername ?? null,
              }
            : null,
        }
      : null,
  }
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
  private readonly invalidJobIds = new Set<string>()

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
   * Invalid rows, and enabled rows when schedules are forbidden, are persisted
   * disabled before the caller starts timers.
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
        this.invalidJobIds.add(job.id)
        logger.info({ jobId: job.id, component: 'Cron' }, 'Disabled invalid cron job')
      } else {
        this.invalidJobIds.delete(job.id)
      }
      this.jobs.set(job.id, job)
    }
    if (this.allowEnabledJobs || this.terminal) return
    for (const job of this.jobs.values()) {
      if (this.terminal) return
      if (!job.enabled) continue
      const wrote = await this.retryBusy(() => this.store!.setSchedule(job.id, false, null), job.id)
      if (!wrote) {
        if (this.terminal) return
        throw new Error('cron stateless disable failed')
      }
      job.enabled = false
      job.nextRun = undefined
      logger.info(
        { jobId: job.id, name: job.name, component: 'Cron' },
        'Stateless policy disabled schedule'
      )
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
   * With a store, the returned promise resolves after the insert acknowledgement.
   */
  createJob(
    name: string,
    schedule: string,
    task: string,
    createdBy?: string,
    origin?: CronJob['origin'],
    providerIdentity?: CronJob['providerIdentity']
  ): CronJob | null {
    const createdAt = new Date(this.now())
    const nextRun = parseNextRun(schedule, createdAt)
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
      createdAt,
      createdBy,
      origin,
    }
    const identity = storedProviderIdentity(providerIdentity)
    if (identity) job.providerIdentity = identity

    if (!this.store) {
      this.installCreated(job)
      return job
    }
    return durableResult(this.persistCreate(job))
  }

  getJob(jobId: string): CronJob | null {
    return this.jobs.get(jobId) || null
  }

  /** Rows that failed load validation. Channel callers do not own these. */
  isInvalidJob(jobId: string): boolean {
    return this.invalidJobIds.has(jobId)
  }

  getAllJobs(): CronJob[] {
    return Array.from(this.jobs.values())
  }

  enableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (this.invalidJobIds.has(jobId)) return false

    if (!this.allowEnabledJobs) {
      this.disableJobForPolicy(job)
      return false
    }

    if (!this.store) {
      job.enabled = true
      if (this.isRunning) this.scheduleJob(job)
      logger.info({ jobId, name: job.name, component: 'Cron' }, 'Enabled cron job')
      return true
    }

    const nextRun = parseNextRun(job.schedule, new Date(this.now()))
    if (!nextRun) return false
    return durableResult(this.persistEnable(job, nextRun))
  }

  disableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (!this.store) {
      this.finishDisable(job)
      return true
    }
    return durableResult(this.persistDisable(job))
  }

  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (!this.store) {
      this.finishDelete(job)
      return true
    }
    return durableResult(this.persistDelete(job))
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
    if (!job || !job.enabled || !this.allowEnabledJobs) return null
    if (!this.store) {
      logger.info({ jobId, name: job.name, component: 'Cron' }, 'Manually triggering cron job')
      return this.executeJob(job)
    }
    return durableResult(this.persistTrigger(job))
  }

  private installCreated(job: CronJob): void {
    this.jobs.set(job.id, job)
    logger.info(
      { jobId: job.id, name: job.name, schedule: job.schedule, component: 'Cron' },
      'Created cron job'
    )
    logger.info(
      { jobId: job.id, nextRun: job.nextRun?.toISOString(), component: 'Cron' },
      'Computed next cron run'
    )

    if (this.isRunning) {
      if (job.enabled) {
        this.scheduleJob(job)
      } else {
        logger.info(
          { jobId: job.id, name: job.name, component: 'Cron' },
          'Policy kept cron job disabled'
        )
      }
    }

    this.emit('cron:created', job)
  }

  private async persistCreate(job: CronJob): Promise<CronJob | null> {
    try {
      await this.store!.insert(jobToRecord(job))
    } catch (error) {
      logger.error({ err: error, jobId: job.id, component: 'Cron' }, 'Cron job insert failed')
      throw error
    }
    this.installCreated(job)
    return job
  }

  private finishEnable(job: CronJob, nextRun: Date): void {
    job.enabled = true
    job.nextRun = nextRun
    if (this.isRunning && !this.terminal) this.scheduleJob(job)
    logger.info({ jobId: job.id, name: job.name, component: 'Cron' }, 'Enabled cron job')
  }

  private async persistEnable(job: CronJob, nextRun: Date): Promise<boolean> {
    try {
      await this.store!.setSchedule(job.id, true, unixSeconds(nextRun.getTime()))
    } catch (error) {
      logger.error({ err: error, jobId: job.id, component: 'Cron' }, 'Cron job enable failed')
      throw error
    }
    const current = this.jobs.get(job.id)
    if (!current) return false
    this.finishEnable(current, nextRun)
    return true
  }

  private finishDisable(job: CronJob): void {
    job.enabled = false
    this.clearTimer(job.id)
    logger.info({ jobId: job.id, name: job.name, component: 'Cron' }, 'Disabled cron job')
  }

  private async persistDisable(job: CronJob): Promise<boolean> {
    const nextRunAt = job.nextRun ? unixSeconds(job.nextRun.getTime()) : null
    try {
      await this.store!.setSchedule(job.id, false, nextRunAt)
    } catch (error) {
      logger.error({ err: error, jobId: job.id, component: 'Cron' }, 'Cron job disable failed')
      throw error
    }
    const current = this.jobs.get(job.id)
    if (!current) return true
    this.finishDisable(current)
    return true
  }

  private finishDelete(job: CronJob): void {
    this.clearTimer(job.id)
    this.jobs.delete(job.id)
    this.invalidJobIds.delete(job.id)
    logger.info({ jobId: job.id, name: job.name, component: 'Cron' }, 'Deleted cron job')
    this.emit('cron:deleted', job)
  }

  private async persistDelete(job: CronJob): Promise<boolean> {
    try {
      await this.store!.delete(job.id)
    } catch (error) {
      logger.error({ err: error, jobId: job.id, component: 'Cron' }, 'Cron job delete failed')
      throw error
    }
    const current = this.jobs.get(job.id)
    if (!current) return true
    this.finishDelete(current)
    return true
  }

  private async persistTrigger(job: CronJob): Promise<Task | null> {
    const nowMs = this.now()
    try {
      await this.store!.setLastRun(job.id, unixSeconds(nowMs))
    } catch (error) {
      logger.error({ err: error, jobId: job.id, component: 'Cron' }, 'Cron trigger write failed')
      throw error
    }
    if (this.terminal) return null
    const current = this.jobs.get(job.id)
    if (!current || !current.enabled || !this.allowEnabledJobs) return null
    logger.info(
      { jobId: job.id, name: current.name, component: 'Cron' },
      'Manually triggering cron job'
    )
    return this.executeJob(current, nowMs)
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

  private executeJob(job: CronJob, atMs: number = this.now()): Task {
    logger.info({ jobId: job.id, name: job.name, component: 'Cron' }, 'Executing cron job')
    job.lastRun = new Date(atMs)

    const task = this.queue.createTaskFromCron(
      job.id,
      job.task,
      job.origin,
      'normal',
      job.providerIdentity
    )
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

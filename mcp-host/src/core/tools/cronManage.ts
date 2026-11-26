import { CronScheduler } from '../../agent/cronScheduler'
import type { CronJob } from '../../agent/types'
import { type CronJobRecord, validateCronRecord } from '../../db/cronJobs'
import type { IncomingMessage } from '../../server'
import {
  STATELESS_ALLOW_CRON_MANAGE_ENV,
  statelessCronManageAllowed,
} from '../../statelessCronPolicy'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'

/**
 * Cron×stateless notice — appended to EVERY cron_manage response on a
 * stateless host (all actions, including reads and errors) so the LLM always
 * relays the cost consequence of active schedules to the user in their
 * language.
 */
export const STATELESS_CRON_NOTICE =
  'Note: this agent is stateless and normally suspends when idle. Active scheduled tasks ' +
  'keep it running continuously -- it will not suspend until all schedules are removed or disabled.'

export const STATELESS_CRON_FORBIDDEN_MESSAGE = `cron_manage create/enable is disabled on stateless hosts by default. Set ${STATELESS_ALLOW_CRON_MANAGE_ENV}=true only for hosts that require persistent schedules.`

const STATELESS_FORBIDDEN_ACTIONS = new Set(['create', 'enable'])

/**
 * A store-backed scheduler method returns a Promise while its declared type
 * stays synchronous. Promise.resolve waits for that worker acknowledgement.
 * A memory scheduler returns the value itself.
 */
function acknowledged<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

/**
 * Native tool for managing cron jobs.
 *
 * Exposes the CronScheduler API to the LLM so the agent can
 * autonomously create, list, delete, enable, disable, trigger,
 * and inspect scheduled tasks.
 */
export class CronManageTool implements Tool {
  constructor(
    private readonly scheduler: CronScheduler,
    private readonly sourceMessage?: IncomingMessage,
    /** Cron×stateless: appends STATELESS_CRON_NOTICE to every response. */
    private readonly statelessLifecycle: boolean = false,
    private readonly allowStatelessCronManage: boolean = statelessCronManageAllowed()
  ) {}

  name() {
    return 'cron_manage'
  }

  description() {
    return (
      'Manage scheduled cron jobs. Supports actions: list (show all jobs), ' +
      'get (show one job by ID), create (new recurring job with a cron schedule and prompt), ' +
      'delete (remove a job), enable/disable (toggle a job), trigger (run a job immediately). ' +
      'Cron expressions use 5-part format: minute hour day month weekday. ' +
      'On stateless hosts, create/enable are disabled by default; when explicitly allowed, ' +
      'create/enable require approval before execution.'
    )
  }

  parametersSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'delete', 'enable', 'disable', 'trigger'],
          description: 'The cron operation to perform',
        },
        jobId: {
          type: 'string',
          description: 'Job ID (required for get, delete, enable, disable, trigger)',
        },
        name: {
          type: 'string',
          description: 'Human-readable job name (required for create)',
        },
        schedule: {
          type: 'string',
          description:
            'Cron expression in 5-part format: minute hour day month weekday. ' +
            "Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1' (Mon 9am), '0 0 * * *' (daily midnight)",
        },
        task: {
          type: 'string',
          description: 'The prompt/task content to execute on each trigger (required for create)',
        },
      },
      required: ['action'],
    }
  }

  requiresSanitization() {
    return false
  }

  requiresApproval() {
    return !this.statelessCronForbidden()
  }

  /**
   * Ownership for a valid row is sender, channelType, and channelId.
   * A source-less caller owns only origin-less jobs. Invalid loaded rows are
   * not owned; a source-less caller can still see them.
   * Non-owned jobs are reported as "not found".
   */
  private owns(job: CronJob): boolean {
    const origin = job.origin
    if (!this.sourceMessage) return !origin
    return (
      !!origin &&
      origin.sender === this.sourceMessage.sender &&
      origin.channelType === this.sourceMessage.channelType &&
      origin.channelId === this.sourceMessage.channelId
    )
  }

  private visible(job: CronJob): boolean {
    if (this.scheduler.isInvalidJob(job.id)) return !this.sourceMessage
    return this.owns(job)
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const action = params.action as string

    try {
      if (this.statelessCronForbidden() && STATELESS_FORBIDDEN_ACTIONS.has(action)) {
        return this.error(STATELESS_CRON_FORBIDDEN_MESSAGE, startTime)
      }

      switch (action) {
        case 'list':
          return this.success(
            this.scheduler.getAllJobs().filter(j => this.visible(j)),
            startTime
          )

        case 'get':
          return this.handleGet(params, startTime)

        case 'create':
          return await this.handleCreate(params, startTime)

        case 'delete':
          return await this.handleDelete(params, startTime)

        case 'enable':
          return await this.handleToggle(params, true, startTime)

        case 'disable':
          return await this.handleToggle(params, false, startTime)

        case 'trigger':
          return await this.handleTrigger(params, startTime)

        default:
          return this.error(`Unknown action: ${action}`, startTime)
      }
    } catch (err) {
      return this.error(`Error: ${(err as Error).message}`, startTime)
    }
  }

  private handleGet(params: Record<string, unknown>, startTime: number): ToolOutput {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.visible(job)) return this.error(`Job not found: ${jobId}`, startTime)

    return this.success(job, startTime)
  }

  private async handleCreate(
    params: Record<string, unknown>,
    startTime: number
  ): Promise<ToolOutput> {
    const name = params.name as string
    const schedule = params.schedule as string
    const task = params.task as string

    if (!name) return this.error('Missing required parameter: name', startTime)
    if (!schedule) return this.error('Missing required parameter: schedule', startTime)
    if (!task) return this.error('Missing required parameter: task', startTime)

    const origin = this.originFromSource()
    const providerIdentity = this.validatedProviderIdentity(origin)
    const job = await acknowledged(
      this.scheduler.createJob(name, schedule, task, undefined, origin, providerIdentity)
    )
    if (!job) return this.error(`Invalid cron schedule: ${schedule}`, startTime)

    return this.success(job, startTime)
  }

  private async handleDelete(
    params: Record<string, unknown>,
    startTime: number
  ): Promise<ToolOutput> {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.visible(job)) return this.error(`Job not found: ${jobId}`, startTime)

    await acknowledged(this.scheduler.deleteJob(jobId))
    return this.success({ deleted: true, jobId }, startTime)
  }

  private async handleToggle(
    params: Record<string, unknown>,
    enable: boolean,
    startTime: number
  ): Promise<ToolOutput> {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.visible(job)) return this.error(`Job not found: ${jobId}`, startTime)

    const ok = await acknowledged(
      enable ? this.scheduler.enableJob(jobId) : this.scheduler.disableJob(jobId)
    )

    if (!ok) {
      if (enable && this.scheduler.isInvalidJob(jobId)) {
        return this.error(`Invalid cron job: ${jobId}`, startTime)
      }
      return this.error(`Job not found: ${jobId}`, startTime)
    }

    return this.success({ jobId, enabled: enable }, startTime)
  }

  private async handleTrigger(
    params: Record<string, unknown>,
    startTime: number
  ): Promise<ToolOutput> {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.visible(job)) return this.error(`Job not found: ${jobId}`, startTime)
    if (!job.enabled) return this.error(`Job is disabled: ${jobId}`, startTime)

    const task = await acknowledged(this.scheduler.triggerJob(jobId))
    if (!task) return this.error(`Cannot trigger job: ${jobId}`, startTime)

    return this.success({ triggered: true, jobId, taskId: task.id }, startTime)
  }

  private originFromSource(): CronJob['origin'] | undefined {
    const source = this.sourceMessage
    if (!source) return undefined
    const origin: NonNullable<CronJob['origin']> = {
      channelType: source.channelType,
      channelId: source.channelId,
      sender: source.sender,
    }
    if (typeof source.threadId === 'string' && source.threadId.trim() !== '') {
      origin.threadId = source.threadId
    }
    return origin
  }

  /** Copies a valid provider identity and drops providerEventId. */
  private validatedProviderIdentity(
    origin: CronJob['origin'] | undefined
  ): CronJob['providerIdentity'] | undefined {
    const source = this.sourceMessage
    const identity = source?.providerIdentity
    if (!source || !origin || !identity || identity.medium !== source.channelType) return undefined
    const probe: CronJobRecord = {
      id: 'probe',
      name: 'probe',
      schedule: '0 * * * *',
      task: 'probe',
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: 0,
      createdBy: null,
      origin: {
        channelType: origin.channelType,
        channelId: origin.channelId,
        sender: origin.sender,
        threadId: origin.threadId ?? null,
      },
      provider: {
        medium: identity.medium,
        providerUserId: identity.providerUserId,
        providerWorkspaceId: identity.providerWorkspaceId ?? null,
        providerChannelId: identity.providerChannelId,
        providerChannelType: identity.providerChannelType ?? null,
        providerTarget: identity.providerTarget
          ? {
              hostRef: identity.providerTarget.hostRef,
              communicationChannelNamespace: identity.providerTarget.communicationChannelNamespace,
              communicationChannelName: identity.providerTarget.communicationChannelName,
              providerBotId: identity.providerTarget.providerBotId ?? null,
              providerBotUsername: identity.providerTarget.providerBotUsername ?? null,
            }
          : null,
      },
    }
    const result = validateCronRecord(probe)
    if (!result.valid || !result.job.providerIdentity) return undefined
    return result.job.providerIdentity
  }

  private success(data: unknown, startTime: number): ToolOutput {
    return {
      content: this.withStatelessNotice(JSON.stringify(data, null, 2)),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }

  private error(message: string, startTime: number): ToolOutput {
    return {
      content: this.withStatelessNotice(message),
      duration_ms: Date.now() - startTime,
      is_error: true,
    }
  }

  /** Cron×stateless: every response on a stateless host carries the notice. */
  private withStatelessNotice(content: string): string {
    if (!this.statelessLifecycle || !this.allowStatelessCronManage) return content
    return `${content}\n\n${STATELESS_CRON_NOTICE}`
  }

  private statelessCronForbidden(): boolean {
    return this.statelessLifecycle && !this.allowStatelessCronManage
  }
}

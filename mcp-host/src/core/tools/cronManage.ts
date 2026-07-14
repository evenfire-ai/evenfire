import { CronScheduler } from '../../agent/cronScheduler'
import type { CronJob } from '../../agent/types'
import type { IncomingMessage } from '../../server'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'

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
    private readonly sourceMessage?: IncomingMessage
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
      'This tool requires approval before execution.'
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
    return true
  }

  /**
   * Ownership (F4): a caller owns a job when the job's `origin` matches the
   * caller's (sender, channelType) — the same (person, channel) identity used
   * for workspace isolation. A source-less (system/cron/internal) caller owns
   * only origin-less jobs. Non-owned jobs are reported as "not found" so the
   * tool is not an existence oracle for other users' jobs.
   */
  private owns(job: CronJob): boolean {
    const origin = job.origin
    if (!this.sourceMessage) return !origin
    return (
      !!origin &&
      origin.sender === this.sourceMessage.sender &&
      origin.channelType === this.sourceMessage.channelType
    )
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const action = params.action as string

    try {
      switch (action) {
        case 'list':
          return this.success(
            this.scheduler.getAllJobs().filter(j => this.owns(j)),
            startTime
          )

        case 'get':
          return this.handleGet(params, startTime)

        case 'create':
          return this.handleCreate(params, startTime)

        case 'delete':
          return this.handleDelete(params, startTime)

        case 'enable':
          return this.handleToggle(params, true, startTime)

        case 'disable':
          return this.handleToggle(params, false, startTime)

        case 'trigger':
          return this.handleTrigger(params, startTime)

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
    if (!job || !this.owns(job)) return this.error(`Job not found: ${jobId}`, startTime)

    return this.success(job, startTime)
  }

  private handleCreate(params: Record<string, unknown>, startTime: number): ToolOutput {
    const name = params.name as string
    const schedule = params.schedule as string
    const task = params.task as string

    if (!name) return this.error('Missing required parameter: name', startTime)
    if (!schedule) return this.error('Missing required parameter: schedule', startTime)
    if (!task) return this.error('Missing required parameter: task', startTime)

    const origin = this.sourceMessage
      ? {
          channelType: this.sourceMessage.channelType,
          channelId: this.sourceMessage.channelId,
          sender: this.sourceMessage.sender,
        }
      : undefined

    const job = this.scheduler.createJob(name, schedule, task, undefined, origin)
    if (!job) return this.error(`Invalid cron schedule: ${schedule}`, startTime)

    return this.success(job, startTime)
  }

  private handleDelete(params: Record<string, unknown>, startTime: number): ToolOutput {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.owns(job)) return this.error(`Job not found: ${jobId}`, startTime)

    this.scheduler.deleteJob(jobId)
    return this.success({ deleted: true, jobId }, startTime)
  }

  private handleToggle(
    params: Record<string, unknown>,
    enable: boolean,
    startTime: number
  ): ToolOutput {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.owns(job)) return this.error(`Job not found: ${jobId}`, startTime)

    const ok = enable ? this.scheduler.enableJob(jobId) : this.scheduler.disableJob(jobId)

    if (!ok) return this.error(`Job not found: ${jobId}`, startTime)

    return this.success({ jobId, enabled: enable }, startTime)
  }

  private handleTrigger(params: Record<string, unknown>, startTime: number): ToolOutput {
    const jobId = params.jobId as string
    if (!jobId) return this.error('Missing required parameter: jobId', startTime)

    const job = this.scheduler.getJob(jobId)
    if (!job || !this.owns(job)) return this.error(`Job not found: ${jobId}`, startTime)

    const task = this.scheduler.triggerJob(jobId)
    if (!task) return this.error(`Job not found: ${jobId}`, startTime)

    return this.success({ triggered: true, jobId, taskId: task.id }, startTime)
  }

  private success(data: unknown, startTime: number): ToolOutput {
    return {
      content: JSON.stringify(data, null, 2),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }

  private error(message: string, startTime: number): ToolOutput {
    return {
      content: message,
      duration_ms: Date.now() - startTime,
      is_error: true,
    }
  }
}

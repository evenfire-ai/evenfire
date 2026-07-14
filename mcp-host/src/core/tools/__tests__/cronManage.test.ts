import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import { CronManageTool } from '../cronManage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createScheduler(): CronScheduler {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  return new CronScheduler(queue)
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('CronManageTool — metadata', () => {
  const scheduler = createScheduler()
  const tool = new CronManageTool(scheduler)

  afterEach(() => scheduler.stop())

  it("should have name 'cron_manage'", () => {
    expect(tool.name()).toBe('cron_manage')
  })

  it('should require approval', () => {
    expect(tool.requiresApproval()).toBe(true)
  })

  it('should not require sanitization', () => {
    expect(tool.requiresSanitization()).toBe(false)
  })

  it('should have a valid parameters schema with action enum', () => {
    const schema = tool.parametersSchema()
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('action')
    const actionProp = (schema.properties as any).action
    expect(actionProp.enum).toContain('list')
    expect(actionProp.enum).toContain('create')
    expect(actionProp.enum).toContain('delete')
    expect(actionProp.enum).toContain('trigger')
  })
})

// ---------------------------------------------------------------------------
// list action
// ---------------------------------------------------------------------------

describe('CronManageTool — list', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should return empty array when no jobs exist', async () => {
    const result = await tool.execute({ action: 'list' })
    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual([])
  })

  it('should return all jobs after creation', async () => {
    scheduler.createJob('j1', '0 * * * *', 'task1')
    scheduler.createJob('j2', '*/5 * * * *', 'task2')

    const result = await tool.execute({ action: 'list' })
    expect(result.is_error).toBe(false)
    const jobs = JSON.parse(result.content)
    expect(jobs).toHaveLength(2)
    expect(jobs[0].name).toBe('j1')
    expect(jobs[1].name).toBe('j2')
  })
})

// ---------------------------------------------------------------------------
// get action
// ---------------------------------------------------------------------------

describe('CronManageTool — get', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should return a job by ID', async () => {
    const job = scheduler.createJob('find-me', '0 * * * *', 'task')
    const result = await tool.execute({ action: 'get', jobId: job!.id })
    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content).name).toBe('find-me')
  })

  it('should return error for non-existent job', async () => {
    const result = await tool.execute({ action: 'get', jobId: 'nope' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('should return error when jobId is missing', async () => {
    const result = await tool.execute({ action: 'get' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('jobId')
  })
})

// ---------------------------------------------------------------------------
// create action
// ---------------------------------------------------------------------------

describe('CronManageTool — create', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should create a job with valid params', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'health-check',
      schedule: '*/5 * * * *',
      task: 'Check server health',
    })
    expect(result.is_error).toBe(false)
    const job = JSON.parse(result.content)
    expect(job.name).toBe('health-check')
    expect(job.schedule).toBe('*/5 * * * *')
    expect(job.task).toBe('Check server health')
    expect(job.enabled).toBe(true)

    // Verify it was actually registered in the scheduler
    expect(scheduler.getAllJobs()).toHaveLength(1)
  })

  it('should return error when name is missing', async () => {
    const result = await tool.execute({
      action: 'create',
      schedule: '*/5 * * * *',
      task: 't',
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('name')
  })

  it('should return error when schedule is missing', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'j',
      task: 't',
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('schedule')
  })

  it('should return error when task is missing', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'j',
      schedule: '*/5 * * * *',
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('task')
  })

  it('should return error for invalid cron schedule', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'j',
      schedule: 'bad schedule',
      task: 't',
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Invalid cron schedule')
  })
})

// ---------------------------------------------------------------------------
// delete action
// ---------------------------------------------------------------------------

describe('CronManageTool — delete', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should delete an existing job', async () => {
    const job = scheduler.createJob('del-me', '0 * * * *', 'task')
    const result = await tool.execute({ action: 'delete', jobId: job!.id })
    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content).deleted).toBe(true)
    expect(scheduler.getAllJobs()).toHaveLength(0)
  })

  it('should return error for non-existent job', async () => {
    const result = await tool.execute({ action: 'delete', jobId: 'nope' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('should return error when jobId is missing', async () => {
    const result = await tool.execute({ action: 'delete' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('jobId')
  })
})

// ---------------------------------------------------------------------------
// enable / disable actions
// ---------------------------------------------------------------------------

describe('CronManageTool — enable / disable', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should disable a job', async () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    const result = await tool.execute({ action: 'disable', jobId: job!.id })
    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content).enabled).toBe(false)
    expect(scheduler.getJob(job!.id)!.enabled).toBe(false)
  })

  it('should enable a disabled job', async () => {
    const job = scheduler.createJob('j', '0 * * * *', 'task')
    scheduler.disableJob(job!.id)
    const result = await tool.execute({ action: 'enable', jobId: job!.id })
    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content).enabled).toBe(true)
    expect(scheduler.getJob(job!.id)!.enabled).toBe(true)
  })

  it('should return error for non-existent job', async () => {
    const r1 = await tool.execute({ action: 'enable', jobId: 'nope' })
    expect(r1.is_error).toBe(true)
    const r2 = await tool.execute({ action: 'disable', jobId: 'nope' })
    expect(r2.is_error).toBe(true)
  })

  it('should return error when jobId is missing', async () => {
    const r1 = await tool.execute({ action: 'enable' })
    expect(r1.is_error).toBe(true)
    const r2 = await tool.execute({ action: 'disable' })
    expect(r2.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// trigger action
// ---------------------------------------------------------------------------

describe('CronManageTool — trigger', () => {
  let scheduler: CronScheduler
  let tool: CronManageTool

  beforeEach(() => {
    scheduler = createScheduler()
    tool = new CronManageTool(scheduler)
  })

  afterEach(() => scheduler.stop())

  it('should trigger a job and return task info', async () => {
    const job = scheduler.createJob('j', '0 * * * *', 'run report')
    const result = await tool.execute({ action: 'trigger', jobId: job!.id })
    expect(result.is_error).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.triggered).toBe(true)
    expect(parsed.jobId).toBe(job!.id)
    expect(parsed.taskId).toBeTruthy()
  })

  it('should return error for non-existent job', async () => {
    const result = await tool.execute({ action: 'trigger', jobId: 'nope' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('should return error when jobId is missing', async () => {
    const result = await tool.execute({ action: 'trigger' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('jobId')
  })
})

// ---------------------------------------------------------------------------
// create action — origin from sourceMessage
// ---------------------------------------------------------------------------

describe('CronManageTool — create with sourceMessage origin', () => {
  let scheduler: CronScheduler

  beforeEach(() => {
    scheduler = createScheduler()
  })

  afterEach(() => scheduler.stop())

  it('should store origin from sourceMessage on created job', async () => {
    const sourceMessage = {
      content: 'schedule a task',
      channelType: 'telegram' as const,
      channelId: '-5130716657',
      sender: '516801777',
      timestamp: new Date().toISOString(),
      messageId: 'msg-123',
      hostRef: 'chatllm',
    }

    const tool = new CronManageTool(scheduler, sourceMessage)
    const result = await tool.execute({
      action: 'create',
      name: 'test-origin',
      schedule: '*/5 * * * *',
      task: 'run check',
    })

    expect(result.is_error).toBe(false)
    const job = JSON.parse(result.content)
    expect(job.origin).toBeDefined()
    expect(job.origin.channelType).toBe('telegram')
    expect(job.origin.channelId).toBe('-5130716657')
    expect(job.origin.sender).toBe('516801777')

    // Verify stored in scheduler
    const stored = scheduler.getJob(job.id)
    expect(stored!.origin).toEqual({
      channelType: 'telegram',
      channelId: '-5130716657',
      sender: '516801777',
    })
  })

  it('should not store origin when no sourceMessage', async () => {
    const tool = new CronManageTool(scheduler)
    const result = await tool.execute({
      action: 'create',
      name: 'no-origin',
      schedule: '0 * * * *',
      task: 'task',
    })

    expect(result.is_error).toBe(false)
    const job = JSON.parse(result.content)
    expect(job.origin).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Unknown action
// ---------------------------------------------------------------------------

describe('CronManageTool — unknown action', () => {
  it('should return error for unknown action', async () => {
    const scheduler = createScheduler()
    const tool = new CronManageTool(scheduler)
    const result = await tool.execute({ action: 'explode' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Unknown action')
    scheduler.stop()
  })
})

// ---------------------------------------------------------------------------
// ToolOutput contract
// ---------------------------------------------------------------------------

describe('CronManageTool — ToolOutput contract', () => {
  it('should always return duration_ms >= 0', async () => {
    const scheduler = createScheduler()
    const tool = new CronManageTool(scheduler)

    const r1 = await tool.execute({ action: 'list' })
    expect(r1.duration_ms).toBeGreaterThanOrEqual(0)

    const r2 = await tool.execute({ action: 'get' }) // error case
    expect(r2.duration_ms).toBeGreaterThanOrEqual(0)

    scheduler.stop()
  })
})

// ---------------------------------------------------------------------------
// Ownership / cross-user isolation (F4)
// ---------------------------------------------------------------------------

describe('CronManageTool — ownership (F4)', () => {
  let scheduler: CronScheduler

  const sourceA = {
    content: 'a',
    channelType: 'telegram' as const,
    channelId: 'cA',
    sender: 'alice',
    timestamp: new Date().toISOString(),
    messageId: 'mA',
    hostRef: 'h',
  }
  const sourceB = { ...sourceA, sender: 'bob', channelId: 'cB', messageId: 'mB' }

  beforeEach(() => {
    scheduler = createScheduler()
  })

  afterEach(() => scheduler.stop())

  async function createJobAs(source: typeof sourceA, name: string): Promise<string> {
    const tool = new CronManageTool(scheduler, source)
    const res = await tool.execute({
      action: 'create',
      name,
      schedule: '0 * * * *',
      task: 't',
    })
    return JSON.parse(res.content).id as string
  }

  it("list only returns the caller's own jobs", async () => {
    await createJobAs(sourceA, 'a-job')
    await createJobAs(sourceB, 'b-job')

    const aTool = new CronManageTool(scheduler, sourceA)
    const list = JSON.parse((await aTool.execute({ action: 'list' })).content)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('a-job')
  })

  it("get/trigger/delete/disable on another user's job report not-found", async () => {
    const aJobId = await createJobAs(sourceA, 'a-job')
    const bTool = new CronManageTool(scheduler, sourceB)

    for (const action of ['get', 'trigger', 'delete', 'disable'] as const) {
      const res = await bTool.execute({ action, jobId: aJobId })
      expect(res.is_error).toBe(true)
      expect(res.content).toContain('not found')
    }
    // A's job is untouched (still enabled, still present).
    expect(scheduler.getJob(aJobId)?.enabled).toBe(true)
  })

  it('the owner can manage their own job', async () => {
    const aJobId = await createJobAs(sourceA, 'a-job')
    const aTool = new CronManageTool(scheduler, sourceA)

    const got = await aTool.execute({ action: 'get', jobId: aJobId })
    expect(got.is_error).toBe(false)
    const del = await aTool.execute({ action: 'delete', jobId: aJobId })
    expect(del.is_error).toBe(false)
    expect(scheduler.getJob(aJobId)).toBeNull()
  })

  it('a source-less (system) caller sees only origin-less jobs', async () => {
    await createJobAs(sourceA, 'a-job') // has origin
    scheduler.createJob('sys-job', '0 * * * *', 't') // no origin

    const sysTool = new CronManageTool(scheduler)
    const list = JSON.parse((await sysTool.execute({ action: 'list' })).content)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('sys-job')
  })

  it('same sender on a different channel is NOT the owner (channelType matters)', async () => {
    const aJobId = await createJobAs(sourceA, 'a-job') // telegram:alice
    const slackAlice = { ...sourceA, channelType: 'slack' as const, channelId: 'cS' }
    const tool = new CronManageTool(scheduler, slackAlice)

    expect(JSON.parse((await tool.execute({ action: 'list' })).content)).toHaveLength(0)
    const got = await tool.execute({ action: 'get', jobId: aJobId })
    expect(got.is_error).toBe(true)
    expect(got.content).toContain('not found')
  })

  it('same (sender, channelType) on a different channelId IS still the owner', async () => {
    const aJobId = await createJobAs(sourceA, 'a-job') // telegram:alice @ cA
    const sameUserOtherChat = { ...sourceA, channelId: 'cOTHER', messageId: 'm2' }
    const tool = new CronManageTool(scheduler, sameUserOtherChat)

    // channelId is intentionally NOT part of ownership (matches the workspace
    // userKey = hash(channelType:sender)): the user owns their job across chats.
    expect(JSON.parse((await tool.execute({ action: 'list' })).content)).toHaveLength(1)
    const got = await tool.execute({ action: 'get', jobId: aJobId })
    expect(got.is_error).toBe(false)
  })
})

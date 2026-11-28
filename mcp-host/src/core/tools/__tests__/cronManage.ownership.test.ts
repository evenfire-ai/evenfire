import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import type { CronDurableStore, CronJobRecord } from '../../../agent/cronStore'
import { MessageQueue } from '../../../queue/messageQueue'
import type { IncomingMessage } from '../../../server'
import { CronManageTool } from '../cronManage'

const EVENT_ID = 'event-should-not-persist'

function teamsSource(channelId = '19:conversation'): IncomingMessage {
  return {
    content: 'schedule the check',
    channelType: 'teams',
    channelId,
    sender: 'user-1',
    timestamp: '2026-11-26T00:00:00.000Z',
    messageId: `m-${channelId}`,
    hostRef: 'host-1',
    threadId: 'reply-1',
    providerIdentity: {
      medium: 'teams',
      providerUserId: 'user-1',
      providerWorkspaceId: 'workspace-1',
      providerChannelId: '19:channel',
      providerChannelType: null,
      providerEventId: EVENT_ID,
      providerTarget: {
        hostRef: 'host-1',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'general',
        providerBotId: null,
        providerBotUsername: null,
      },
    },
  }
}

function createHarness(options?: {
  allowEnabledJobs?: boolean
  store?: CronDurableStore
  now?: () => number
}): { queue: MessageQueue; scheduler: CronScheduler } {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  const scheduler = new CronScheduler(queue, {
    allowEnabledJobs: options?.allowEnabledJobs,
    store: options?.store,
    now: options?.now,
  })
  return { queue, scheduler }
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

type Gate = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function gate(): Gate {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createStore(): {
  store: CronDurableStore
  inserted: CronJobRecord[]
  holdInsert: Gate
  holdDelete: Gate
  holdSchedule: Gate
  holdLastRun: Gate
} {
  const inserted: CronJobRecord[] = []
  const holdInsert = gate()
  const holdDelete = gate()
  const holdSchedule = gate()
  const holdLastRun = gate()
  const store: CronDurableStore = {
    load: vi.fn(async () => []),
    insert: vi.fn((row: CronJobRecord) => {
      inserted.push(row)
      return holdInsert.promise
    }),
    delete: vi.fn(() => holdDelete.promise),
    read: vi.fn(async () => null),
    claim: vi.fn(async () => ({ changes: 0 })),
    setSchedule: vi.fn(() => holdSchedule.promise),
    setLastRun: vi.fn(() => holdLastRun.promise),
  }
  return { store, inserted, holdInsert, holdDelete, holdSchedule, holdLastRun }
}

describe('CronManageTool ownership and identity', () => {
  const schedulers: CronScheduler[] = []

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop()
    schedulers.length = 0
    vi.restoreAllMocks()
  })

  function track(scheduler: CronScheduler): CronScheduler {
    schedulers.push(scheduler)
    return scheduler
  }

  it('stores the Teams conversation id, provider channel id, and thread without providerEventId', async () => {
    const { scheduler } = createHarness()
    track(scheduler)
    const source = teamsSource()
    const tool = new CronManageTool(scheduler, source)

    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })

    expect(created.is_error).toBe(false)
    const job = JSON.parse(created.content)
    expect(job.origin).toEqual({
      channelType: 'teams',
      channelId: '19:conversation',
      sender: 'user-1',
      threadId: 'reply-1',
    })
    expect(job.providerIdentity).toEqual({
      medium: 'teams',
      providerUserId: 'user-1',
      providerWorkspaceId: 'workspace-1',
      providerChannelId: '19:channel',
      providerChannelType: null,
      providerTarget: source.providerIdentity?.providerTarget,
    })
    expect(job.providerIdentity).not.toHaveProperty('providerEventId')
    expect(JSON.stringify(job)).not.toContain(EVENT_ID)

    const stored = scheduler.getJob(job.id)
    expect(stored?.origin?.channelId).toBe('19:conversation')
    expect(stored?.origin?.threadId).toBe('reply-1')
    expect(stored?.providerIdentity?.providerChannelId).toBe('19:channel')
    expect(stored?.providerIdentity).not.toHaveProperty('providerEventId')
  })

  it('keeps origin and thread when provider identity fails validation', async () => {
    const { scheduler } = createHarness()
    track(scheduler)
    const source = teamsSource()
    source.providerIdentity = {
      ...source.providerIdentity!,
      providerUserId: 'someone-else',
    }
    const tool = new CronManageTool(scheduler, source)

    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })

    expect(created.is_error).toBe(false)
    const job = JSON.parse(created.content)
    expect(job.origin.threadId).toBe('reply-1')
    expect(job.origin.channelId).toBe('19:conversation')
    expect(job.providerIdentity).toBeUndefined()
    expect(scheduler.getJob(job.id)?.providerIdentity).toBeUndefined()
  })

  it('returns not-found for a different channelId and does not call triggerJob', async () => {
    const { scheduler } = createHarness()
    track(scheduler)
    const owner = new CronManageTool(scheduler, teamsSource())
    const created = await owner.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    const jobId = JSON.parse(created.content).id as string
    const owned = await owner.execute({ action: 'get', jobId })
    expect(owned.is_error).toBe(false)

    const trigger = vi.spyOn(scheduler, 'triggerJob')
    const remove = vi.spyOn(scheduler, 'deleteJob')
    const enable = vi.spyOn(scheduler, 'enableJob')
    const disable = vi.spyOn(scheduler, 'disableJob')
    const other = new CronManageTool(scheduler, teamsSource('19:other'))

    expect(JSON.parse((await other.execute({ action: 'list' })).content)).toEqual([])
    for (const action of ['get', 'delete', 'enable', 'disable', 'trigger'] as const) {
      const result = await other.execute({ action, jobId })
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('not found')
    }

    expect(trigger).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(scheduler.getJob(jobId)?.enabled).toBe(true)
    expect(scheduler.getJob(jobId)?.origin?.channelId).toBe('19:conversation')
  })

  it('returns an error for trigger of a disabled job and does not enqueue', async () => {
    const { queue, scheduler } = createHarness()
    track(scheduler)
    const tool = new CronManageTool(scheduler, teamsSource())
    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    const jobId = JSON.parse(created.content).id as string
    const disabled = await tool.execute({ action: 'disable', jobId })
    expect(disabled.is_error).toBe(false)
    expect(scheduler.getJob(jobId)?.enabled).toBe(false)

    const triggered = await tool.execute({ action: 'trigger', jobId })
    expect(triggered.is_error).toBe(true)
    expect(triggered.content).toContain('disabled')
    expect(triggered.content).not.toContain('not found')
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('returns an error and does not enqueue when schedules are forbidden', async () => {
    const { queue, scheduler } = createHarness({ allowEnabledJobs: false })
    track(scheduler)
    const tool = new CronManageTool(scheduler, teamsSource())
    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    expect(created.is_error).toBe(false)
    const jobId = JSON.parse(created.content).id as string
    expect(scheduler.getJob(jobId)?.enabled).toBe(false)

    const triggered = await tool.execute({ action: 'trigger', jobId })
    expect(triggered.is_error).toBe(true)
    expect(queue.enqueue).not.toHaveBeenCalled()

    const stored = scheduler.getJob(jobId)
    expect(stored).not.toBeNull()
    stored!.enabled = true
    const forced = await tool.execute({ action: 'trigger', jobId })
    expect(forced.is_error).toBe(true)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('reports create only after the insert acknowledgement', async () => {
    const { store, inserted, holdInsert } = createStore()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const { scheduler } = createHarness({
      store,
      now: () => Date.parse('2026-11-26T00:00:00.000Z'),
    })
    track(scheduler)
    scheduler.start()
    const timersAtStart = setTimeoutSpy.mock.calls.length
    let createdEvent = false
    scheduler.on('cron:created', () => {
      createdEvent = true
    })
    const tool = new CronManageTool(scheduler, teamsSource())
    let settled = false
    const pending = tool
      .execute({
        action: 'create',
        name: 'standup',
        schedule: '0 * * * *',
        task: 'check the channel',
      })
      .then(result => {
        settled = true
        return result
      })

    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(createdEvent).toBe(false)
    expect(scheduler.getAllJobs()).toHaveLength(0)
    expect(setTimeoutSpy.mock.calls.length).toBe(timersAtStart)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]?.origin).toEqual({
      channelType: 'teams',
      channelId: '19:conversation',
      sender: 'user-1',
      threadId: 'reply-1',
    })
    expect(inserted[0]?.provider?.providerChannelId).toBe('19:channel')
    expect(inserted[0]?.provider?.providerUserId).toBe('user-1')
    expect(inserted[0]?.enabled).toBe(true)
    expect(typeof inserted[0]?.nextRunAt).toBe('number')
    expect(JSON.stringify(inserted[0])).not.toContain(EVENT_ID)

    holdInsert.resolve()
    const result = await pending
    expect(settled).toBe(true)
    expect(result.is_error).toBe(false)
    expect(createdEvent).toBe(true)
    expect(scheduler.getAllJobs()).toHaveLength(1)
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(timersAtStart)
    const stored = scheduler.getAllJobs()[0]
    expect(stored?.origin?.threadId).toBe('reply-1')
    expect(stored?.providerIdentity?.providerChannelId).toBe('19:channel')
  })

  it('returns a SQL error from create and does not keep the job', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit)
    const { scheduler } = createHarness({
      store: {
        load: async () => [],
        insert: async () => {
          throw new Error('SQLITE_FULL')
        },
        delete: async () => undefined,
        read: async () => null,
        claim: async () => ({ changes: 0 }),
        setSchedule: async () => undefined,
        setLastRun: async () => undefined,
      },
    })
    track(scheduler)
    const tool = new CronManageTool(scheduler, teamsSource())

    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })

    expect(created.is_error).toBe(true)
    expect(created.content).toContain('SQLITE_FULL')
    expect(scheduler.getAllJobs()).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('reports delete, enable, disable, and trigger only after the store acknowledgement', async () => {
    const { store, holdInsert, holdDelete, holdSchedule, holdLastRun } = createStore()
    const { queue, scheduler } = createHarness({ store })
    track(scheduler)
    const tool = new CronManageTool(scheduler, teamsSource())
    const creating = tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    holdInsert.resolve()
    const created = await creating
    expect(created.is_error).toBe(false)
    const jobId = JSON.parse(created.content).id as string
    expect(scheduler.getJob(jobId)?.enabled).toBe(true)

    let deleteSettled = false
    const deleting = tool.execute({ action: 'delete', jobId }).then(result => {
      deleteSettled = true
      return result
    })
    await flushMicrotasks()
    expect(deleteSettled).toBe(false)
    expect(scheduler.getJob(jobId)).not.toBeNull()
    holdDelete.resolve()
    const deleted = await deleting
    expect(deleted.is_error).toBe(false)
    expect(scheduler.getJob(jobId)).toBeNull()

    const recreated = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    expect(recreated.is_error).toBe(false)
    const enabledId = JSON.parse(recreated.content).id as string
    let disableSettled = false
    const disabling = tool.execute({ action: 'disable', jobId: enabledId }).then(result => {
      disableSettled = true
      return result
    })
    await flushMicrotasks()
    expect(disableSettled).toBe(false)
    expect(scheduler.getJob(enabledId)?.enabled).toBe(true)
    holdSchedule.resolve()
    const disabled = await disabling
    expect(disabled.is_error).toBe(false)
    expect(scheduler.getJob(enabledId)?.enabled).toBe(false)

    const enableGate = gate()
    vi.mocked(store.setSchedule).mockImplementation(() => enableGate.promise)
    let enableSettled = false
    const enabling = tool.execute({ action: 'enable', jobId: enabledId }).then(result => {
      enableSettled = true
      return result
    })
    await flushMicrotasks()
    expect(enableSettled).toBe(false)
    expect(scheduler.getJob(enabledId)?.enabled).toBe(false)
    enableGate.resolve()
    const enabled = await enabling
    expect(enabled.is_error).toBe(false)
    expect(scheduler.getJob(enabledId)?.enabled).toBe(true)

    let triggerSettled = false
    const triggering = tool.execute({ action: 'trigger', jobId: enabledId }).then(result => {
      triggerSettled = true
      return result
    })
    await flushMicrotasks()
    expect(triggerSettled).toBe(false)
    expect(queue.enqueue).not.toHaveBeenCalled()
    holdLastRun.resolve()
    const triggered = await triggering
    expect(triggered.is_error).toBe(false)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue or exit when trigger write fails', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit)
    const { queue, scheduler } = createHarness({
      store: {
        load: async () => [],
        insert: async () => undefined,
        delete: async () => undefined,
        read: async () => null,
        claim: async () => ({ changes: 0 }),
        setSchedule: async () => undefined,
        setLastRun: async () => {
          throw new Error('SQLITE_FULL')
        },
      },
    })
    track(scheduler)
    const tool = new CronManageTool(scheduler, teamsSource())
    const created = await tool.execute({
      action: 'create',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
    })
    expect(created.is_error).toBe(false)
    const jobId = JSON.parse(created.content).id as string

    const triggered = await tool.execute({ action: 'trigger', jobId })
    expect(triggered.is_error).toBe(true)
    expect(triggered.content).toContain('SQLITE_FULL')
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(scheduler.getJob(jobId)?.lastRun).toBeUndefined()
  })

  it('hides invalid rows from channel callers and refuses enable without a write', async () => {
    const setSchedule = vi.fn(async () => undefined)
    const row: CronJobRecord = {
      id: 'invalid-provider',
      name: 'standup',
      schedule: '0 * * * *',
      task: 'check the channel',
      enabled: true,
      nextRunAt: 1_764_120_000,
      lastRunAt: null,
      createdAt: 1_764_110_000,
      createdBy: null,
      origin: {
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'reply-1',
      },
      provider: {
        medium: 'teams',
        providerUserId: 'someone-else',
        providerWorkspaceId: 'workspace-1',
        providerChannelId: '19:channel',
        providerChannelType: null,
        providerTarget: null,
      },
    }
    const { scheduler } = createHarness({
      store: {
        load: async () => [row],
        insert: async () => undefined,
        delete: async () => undefined,
        read: async () => null,
        claim: async () => ({ changes: 0 }),
        setSchedule,
        setLastRun: async () => undefined,
      },
    })
    track(scheduler)
    await scheduler.loadFromStore()
    expect(setSchedule).toHaveBeenCalledTimes(1)
    expect(setSchedule).toHaveBeenCalledWith('invalid-provider', false, null)
    expect(scheduler.getJob('invalid-provider')?.enabled).toBe(false)

    const channel = new CronManageTool(scheduler, teamsSource())
    const hidden = await channel.execute({ action: 'get', jobId: 'invalid-provider' })
    expect(hidden.is_error).toBe(true)
    expect(hidden.content).toContain('not found')

    const system = new CronManageTool(scheduler)
    const listed = JSON.parse((await system.execute({ action: 'list' })).content) as Array<{
      id: string
    }>
    expect(listed.map(job => job.id)).toEqual(['invalid-provider'])
    const enabled = await system.execute({ action: 'enable', jobId: 'invalid-provider' })
    expect(enabled.is_error).toBe(true)
    expect(enabled.content).toContain('Invalid cron job')
    expect(scheduler.getJob('invalid-provider')?.enabled).toBe(false)
    expect(setSchedule).toHaveBeenCalledTimes(1)
    expect(scheduler.enableJob('invalid-provider')).toBe(false)
  })
})

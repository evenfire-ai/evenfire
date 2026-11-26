/**
 * Durable cron arming. Run with TZ=UTC: hour fields follow the process zone.
 * Live timers are setTimeout handles that were not later passed to clearTimeout.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import { MessageQueue } from '../../queue/messageQueue'
import { CRON_CLAIM_BACKOFF_MS, CronScheduler, MAX_SAFE_TIMEOUT } from '../cronScheduler'
import type { CronClaimArgs, CronDurableStore, CronJobRecord } from '../cronStore'

const MISSED_SLOT = '2026-11-22T00:00:00Z'
const CLAIM_AT = '2026-11-25T07:59:30Z'
const FOLLOWING_AT = '2026-11-25T08:00:00Z'

beforeAll(() => {
  if (new Date().getTimezoneOffset() !== 0) {
    throw new Error('cronScheduler.durable.test.ts requires TZ=UTC')
  }
})

function createQueue(): MessageQueue {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  return queue
}

function seconds(iso: string): number {
  return Date.parse(iso) / 1000
}

function record(overrides: Partial<CronJobRecord> & Pick<CronJobRecord, 'id'>): CronJobRecord {
  return {
    name: 'job',
    schedule: '0 */8 * * *',
    task: 'check the deploy',
    enabled: true,
    nextRunAt: seconds(MISSED_SLOT),
    lastRunAt: null,
    createdAt: seconds(MISSED_SLOT),
    createdBy: null,
    origin: null,
    provider: null,
    ...overrides,
  }
}

function createStore(initial: CronJobRecord[]): {
  store: CronDurableStore
  rows: Map<string, CronJobRecord>
} {
  const rows = new Map(initial.map(row => [row.id, { ...row }]))
  const store: CronDurableStore = {
    load: vi.fn(async () => [...rows.values()].map(row => ({ ...row }))),
    insert: vi.fn(async () => {
      throw new Error('insert was called')
    }),
    delete: vi.fn(async () => {
      throw new Error('delete was called')
    }),
    read: vi.fn(async (id: string) => {
      const row = rows.get(id)
      return row ? { ...row } : null
    }),
    claim: vi.fn(async (args: CronClaimArgs) => {
      const row = rows.get(args.id)
      if (!row || row.enabled !== true || row.nextRunAt !== args.slotSeconds) return { changes: 0 }
      row.lastRunAt = args.nowSeconds
      row.nextRunAt = args.followingSeconds
      return { changes: 1 }
    }),
    setSchedule: vi.fn(async (id: string, enabled: boolean, nextRunAt: number | null) => {
      const row = rows.get(id)
      if (!row) return
      row.enabled = enabled
      row.nextRunAt = nextRunAt
    }),
    setLastRun: vi.fn(async () => {
      throw new Error('setLastRun was called')
    }),
  }
  return { store, rows }
}

function teamsProvider(): NonNullable<CronJobRecord['provider']> {
  return {
    medium: 'teams',
    providerUserId: 'user-1',
    providerWorkspaceId: 'workspace-1',
    providerChannelId: '19:channel',
    providerChannelType: null,
    providerTarget: {
      hostRef: 'host-1',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'general',
      providerBotId: null,
      providerBotUsername: null,
    },
  }
}

describe('CronScheduler durable claim', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  function liveTimerDelays(): number[] {
    const cleared = new Set(clearTimeoutSpy.mock.calls.map((call: readonly unknown[]) => call[0]))
    const delays: number[] = []
    setTimeoutSpy.mock.calls.forEach((call: readonly unknown[], index: number) => {
      const handle = setTimeoutSpy.mock.results[index]?.value
      if (cleared.has(handle)) return
      delays.push(Number(call[1]))
    })
    return delays
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${String(code)}`)
    }) as typeof process.exit)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dispatches one missed slot and does not dispatch it again', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store, rows } = createStore([record({ id: 'missed' })])
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()
    expect(liveTimerDelays()).toEqual([])
    expect(store.claim).not.toHaveBeenCalled()

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(rows.get('missed')?.nextRunAt).toBe(seconds(FOLLOWING_AT))
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(store.claim).toHaveBeenCalledWith({
      id: 'missed',
      slotSeconds: seconds(MISSED_SLOT),
      nowSeconds: seconds(CLAIM_AT),
      followingSeconds: seconds(FOLLOWING_AT),
    })

    const secondQueue = createQueue()
    const second = new CronScheduler(secondQueue, { store, now: () => Date.now() })
    await second.loadFromStore()
    second.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(secondQueue.enqueue).not.toHaveBeenCalled()
    expect(store.claim).toHaveBeenCalledTimes(1)
    scheduler.stop()
    second.stop()
  })

  it('stores the slot plus 60 seconds when the claim clock is 5 ms early', async () => {
    const slotMs = Date.parse('2026-11-25T08:00:00.000Z')
    const nowMs = slotMs - 5
    vi.setSystemTime(nowMs)
    const queue = createQueue()
    const { store, rows } = createStore([
      record({
        id: 'early',
        schedule: '* * * * *',
        nextRunAt: slotMs / 1000,
      }),
    ])
    const scheduler = new CronScheduler(queue, { store, now: () => nowMs })

    await scheduler.loadFromStore()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5)

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(rows.get('early')?.nextRunAt).toBe(slotMs / 1000 + 60)
    expect(rows.get('early')?.nextRunAt).not.toBe(slotMs / 1000 + 120)
    expect(store.claim).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('does not claim when the next run is past the safe setTimeout delay', async () => {
    const nextMs = Date.UTC(2027, 0, 1)
    const nowMs = nextMs - (MAX_SAFE_TIMEOUT + 1000)
    vi.setSystemTime(nowMs)
    const queue = createQueue()
    const { store } = createStore([
      record({
        id: 'far',
        schedule: '0 0 1 1 *',
        nextRunAt: nextMs / 1000,
      }),
    ])
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()
    scheduler.start()

    expect(store.claim).not.toHaveBeenCalled()
    expect(liveTimerDelays()).toEqual([MAX_SAFE_TIMEOUT])

    await vi.advanceTimersByTimeAsync(1)

    expect(store.claim).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('exits on SQLITE_FULL and does not claim again at delay 0', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store } = createStore([record({ id: 'full' })])
    vi.mocked(store.claim).mockImplementation(async () => {
      throw new Error('SQLITE_FULL: database or disk is full')
    })
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })
    const errorLog = vi.spyOn(logger, 'error')

    await scheduler.loadFromStore()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const claimLog = errorLog.mock.calls.find(call => call[1] === 'Cron claim failed')
    const fields = claimLog?.[0] as { err?: unknown; jobId?: string; reason?: string } | undefined
    expect(fields?.jobId).toBe('full')
    expect(fields?.reason).toBe('sql_error')
    expect(fields?.err).toBeInstanceOf(Error)
    expect((fields?.err as Error).message).toContain('SQLITE_FULL')
    expect(queue.enqueue).not.toHaveBeenCalled()

    const timeoutsAfterFailure = setTimeoutSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(999)

    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(
      setTimeoutSpy.mock.calls
        .slice(timeoutsAfterFailure)
        .filter((call: readonly unknown[]) => Number(call[1]) === 0)
    ).toHaveLength(0)
    scheduler.stop()
  })

  it('arms one timer at the future row when the claim changes nothing', async () => {
    const nowMs = Date.parse(CLAIM_AT)
    const futureMs = Date.parse('2026-11-25T09:30:00Z')
    vi.setSystemTime(nowMs)
    const queue = createQueue()
    const { store } = createStore([record({ id: 'lost-future' })])
    const futureRow = record({ id: 'lost-future', nextRunAt: futureMs / 1000 })
    vi.mocked(store.claim).mockResolvedValue({ changes: 0 })
    vi.mocked(store.read).mockResolvedValue(futureRow)
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(liveTimerDelays()).toEqual([futureMs - nowMs])

    await vi.advanceTimersByTimeAsync(futureMs - nowMs - 1)
    expect(store.claim).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(store.claim).toHaveBeenCalledTimes(2)
    expect(queue.enqueue).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('backs off a still-due row instead of claiming at delay 0', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store } = createStore([record({ id: 'lost-due' })])
    const dueRow = record({ id: 'lost-due' })
    vi.mocked(store.claim).mockResolvedValue({ changes: 0 })
    vi.mocked(store.read).mockResolvedValue(dueRow)
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(store.claim).toHaveBeenCalledTimes(1)
    const slotCallback = setTimeoutSpy.mock.calls.find(
      (call: readonly unknown[]) => Number(call[1]) === 0
    )?.[0]
    const backoffCallback = setTimeoutSpy.mock.calls.find(
      (call: readonly unknown[]) => Number(call[1]) === CRON_CLAIM_BACKOFF_MS
    )?.[0]
    expect(backoffCallback).toBeTypeOf('function')
    expect(backoffCallback).not.toBe(slotCallback)
    expect(CRON_CLAIM_BACKOFF_MS).toBe(1000)

    await vi.advanceTimersByTimeAsync(999)
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(queue.enqueue).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(store.claim).toHaveBeenCalledTimes(2)
    expect(queue.enqueue).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('retries SQLITE_BUSY before 30000 ms and does not retry at delay 0', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store, rows } = createStore([record({ id: 'busy' })])
    const claimAt: number[] = []
    vi.mocked(store.claim).mockImplementation(async (args: CronClaimArgs) => {
      claimAt.push(Date.now())
      if (claimAt.length === 1) throw new Error('SQLITE_BUSY')
      const row = rows.get(args.id)
      if (!row || row.nextRunAt !== args.slotSeconds) return { changes: 0 }
      row.lastRunAt = args.nowSeconds
      row.nextRunAt = args.followingSeconds
      return { changes: 1 }
    })
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })
    const started = Date.now()

    await scheduler.loadFromStore()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.claim).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(store.claim).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(store.claim).toHaveBeenCalledTimes(2)
    expect(claimAt[1] - claimAt[0]).toBeGreaterThan(0)
    expect(claimAt[1] - claimAt[0]).toBeLessThan(30_000)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(exitSpy).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('enqueues a memory-mode due fire without calling a store', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const scheduler = new CronScheduler(queue, { now: () => Date.now() })

    await scheduler.loadFromStore()
    scheduler.start()
    const job = scheduler.createJob('memory', '* * * * *', 'ping')
    expect(job).not.toBeNull()

    const delay = job!.nextRun!.getTime() - Date.now()
    expect(delay).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(delay)

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    const task = vi.mocked(queue.enqueue).mock.calls[0]?.[0]
    expect(task?.source).toBe('cron')
    expect(task?.cronJobId).toBe(job!.id)
    scheduler.stop()
  })

  it('disables an invalid record that still has provider identity and does not arm it', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store } = createStore([
      record({
        id: 'bad-schedule',
        schedule: 'not-a-cron',
        origin: {
          channelType: 'teams',
          channelId: '19:conversation',
          sender: 'user-1',
          threadId: 'reply-1',
        },
        provider: teamsProvider(),
      }),
    ])
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()

    expect(store.setSchedule).toHaveBeenCalledWith('bad-schedule', false, null)
    const job = scheduler.getJob('bad-schedule')
    expect(job?.enabled).toBe(false)
    expect(job?.providerIdentity?.providerChannelId).toBe('19:channel')
    expect(liveTimerDelays()).toEqual([])

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.claim).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(liveTimerDelays()).toEqual([])
    scheduler.stop()
  })

  it('does not arm again after stop', async () => {
    vi.setSystemTime(new Date(CLAIM_AT))
    const queue = createQueue()
    const { store } = createStore([record({ id: 'stopped' })])
    const scheduler = new CronScheduler(queue, { store, now: () => Date.now() })

    await scheduler.loadFromStore()
    scheduler.start()
    expect(liveTimerDelays()).toEqual([0])

    scheduler.stop()
    expect(liveTimerDelays()).toEqual([])

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.claim).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(liveTimerDelays()).toEqual([])
  })
})

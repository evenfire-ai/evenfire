import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { DbClient } from '../src/db.js'

const wire = vi.hoisted(() => ({ query: vi.fn<DbClient['query']>() }))

vi.mock('../src/services/tracing/maintenance/inventorySampler.js', () => ({
  createControlPlaneInventoryCache: () => ({
    start: async () => undefined,
    stop: async () => undefined,
    snapshot: () => ({ workloads: [] }),
  }),
}))

vi.mock('../src/services/tracing/pools.js', () => ({
  withTraceMaintenanceClient: (work: (db: DbClient) => unknown) => work(wire),
  closeTraceMaintenancePool: async () => undefined,
}))

vi.mock('../src/services/tracing/maintenance/gcpBigQueryBillingAdapter.js', () => ({
  gcpBigQueryBillingConfigFromEnv: () => ({
    enabled: true,
    importIntervalMs: 3_600_000,
    lookbackDays: 1,
  }),
  loadNormalizedGcpBillingRows: async () => {
    throw new Error('fixture billing provider unavailable')
  },
}))

vi.mock('../src/services/tracing/maintenance/gcpBigQueryPricingAdapter.js', () => ({
  gcpBigQueryPricingConfigFromEnv: () => ({ enabled: false }),
  loadNormalizedGcpPricingEvidence: async () => [],
}))

const grains = [
  'agent_run',
  'administrative',
  'infrastructure_telemetry',
  'infrastructure_cost',
  'approval_prompt',
] as const

type Mode =
  | 'complete'
  | 'lock-lost'
  | 'setup-failure'
  | 'late-grain-failure'
  | 'commit-error'
  | 'ack-lost'
  | 'stop-during-commit'
type WakeLog = {
  event: string
  outcome?: string
  err?: Error
  retentionDurationMsByGrain?: Record<string, number>
  retentionGrain?: string
  retentionGrainDurationMs?: number
}

function latch<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function worker(scheduler: fc.Scheduler, billingEnabled = false) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'))
  vi.stubEnv('TRACING_INFRASTRUCTURE_COST_ENABLED', String(billingEnabled))
  vi.resetModules()

  let terminate: (() => void) | undefined
  const once = process.once.bind(process)
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') {
      terminate = listener
      return process
    }
    if (event === 'SIGINT') return process
    return once(event, listener)
  })

  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  let mode: Mode
  let committed = 0
  let agentAttempts = 0
  const queries: string[] = []
  const limits: number[] = []
  const wakeFailure = new Error('fixture database operation rejected')
  let observed = latch<WakeLog>()
  const stopped = latch<void>()
  const importErrors: WakeLog[] = []
  const { rootLogger } = await import('../src/observability/logger.js')
  const observe = (fields: Omit<WakeLog, 'event'>, message?: string) => {
    if (message === 'trace maintenance shutdown completed') stopped.resolve()
    if (message === 'normalized GCP billing import failed') {
      importErrors.push({ ...fields, event: message })
    }
    if (message?.startsWith('trace maintenance wake ')) {
      observed.resolve({ ...fields, event: message })
    }
  }
  vi.spyOn(rootLogger, 'info').mockImplementation(observe)
  vi.spyOn(rootLogger, 'error').mockImplementation(observe)

  wire.query.mockImplementation(async (sql, params) => {
    if (sql === 'COMMIT' && mode === 'stop-during-commit') terminate!()
    await scheduler.schedule(Promise.resolve(undefined), sql.split('\n')[0])
    queries.push(sql)
    if (sql.includes('pg_try_advisory_xact_lock')) {
      return { rows: [{ acquired: mode !== 'lock-lost' }], rowCount: 1 }
    }
    if (mode === 'setup-failure' && sql.includes('COUNT(*)')) throw wakeFailure
    if (sql === 'COMMIT') {
      if (mode !== 'commit-error') committed += 1
      if (mode === 'commit-error' || mode === 'ack-lost') throw wakeFailure
      queries.push('COMMIT acknowledged')
    }
    if (sql.includes('governed_trace_prune_expired_')) {
      const family = params?.[0]
      limits.push(Number(params?.at(-1)))
      clock += 7
      if (family === 'agent_run') {
        agentAttempts += 1
        if (mode === 'late-grain-failure') {
          if (agentAttempts === 2) throw wakeFailure
          return { rows: [], rowCount: 200 }
        }
      }
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  let started = false
  return {
    committed: () => committed,
    importErrors,
    async wake(next: Mode) {
      mode = next
      agentAttempts = 0
      queries.length = 0
      limits.length = 0
      observed = latch<WakeLog>()
      if (!started) {
        started = true
        await import('../src/traceMaintenance.js')
      } else {
        await vi.advanceTimersByTimeAsync(60_000)
      }
      const log = await scheduler.waitFor(observed.promise)
      await vi.advanceTimersByTimeAsync(0)
      const timings = Object.fromEntries(grains.map(grain => [grain, 7]))
      if (next === 'lock-lost') {
        expect(log.outcome).toBe('lock_not_acquired')
        expect(limits).toEqual([])
      } else if (next === 'complete' || next === 'stop-during-commit') {
        expect(log).toMatchObject({
          event: 'trace maintenance wake completed',
          retentionDurationMsByGrain: timings,
        })
        expect(queries.at(-1)).toBe('COMMIT acknowledged')
      } else {
        expect(log.err).toBe(wakeFailure)
        expect(log.retentionDurationMsByGrain).toEqual(next === 'setup-failure' ? {} : timings)
        if (next === 'late-grain-failure') {
          expect(log).toMatchObject({ retentionGrain: 'agent_run', retentionGrainDurationMs: 7 })
          expect(queries).not.toContain('COMMIT')
        } else {
          expect(log).not.toHaveProperty('retentionGrain')
        }
      }
      if (next !== 'complete' && next !== 'stop-during-commit') {
        expect(queries.at(-1)).toBe('ROLLBACK')
      }
      expect(limits.every(limit => limit <= 200)).toBe(true)
    },
    async stop() {
      try {
        if (!started) return
        terminate!()
        await scheduler.waitFor(stopped.promise)
        const requests = wire.query.mock.calls.length
        await vi.advanceTimersByTimeAsync(60_000)
        expect(wire.query).toHaveBeenCalledTimes(requests)
      } finally {
        vi.useRealTimers()
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
        wire.query.mockReset()
      }
    },
  }
}

type WakeModel = { committed: number; stopped: boolean }
type Worker = Awaited<ReturnType<typeof worker>>

class Wake implements fc.AsyncCommand<WakeModel, Worker> {
  constructor(private readonly mode: Mode) {}

  check(model: Readonly<WakeModel>) {
    return !model.stopped
  }

  async run(model: WakeModel, real: Worker) {
    if (
      this.mode === 'complete' ||
      this.mode === 'ack-lost' ||
      this.mode === 'stop-during-commit'
    ) {
      model.committed += 1
    }
    await real.wake(this.mode)
    expect(real.committed()).toBe(model.committed)
    if (this.mode === 'stop-during-commit') model.stopped = true
  }

  toString() {
    return this.mode
  }
}

describe('the real trace maintenance entry point', () => {
  it('contains a provider import error and still reports the successful wake', async () => {
    const scheduler = fc.sample(fc.scheduler(), { seed: 1, numRuns: 1 })[0]!
    const real = await worker(scheduler, true)
    try {
      await real.wake('complete')
      expect(real.committed()).toBe(1)
      expect(real.importErrors).toHaveLength(1)
      expect(real.importErrors[0]?.err?.message).toBe('fixture billing provider unavailable')
      expect(real.importErrors[0]).not.toHaveProperty('retentionDurationMsByGrain')
    } finally {
      await real.stop()
    }
  })

  it('reports completed attempts on a later SQL failure or COMMIT rejection', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const real = await worker(scheduler)
        try {
          const model = { committed: 0, stopped: false }
          for (const outcome of [
            'complete',
            'late-grain-failure',
            'commit-error',
            'stop-during-commit',
          ] as const) {
            await new Wake(outcome).run(model, real)
          }
        } finally {
          await real.stop()
        }
      }),
      { numRuns: 1 }
    )
  })

  it('keeps wake acceptance consistent across scheduled failures, retries and stops', async () => {
    const modes = fc.constantFrom<Mode>(
      'complete',
      'lock-lost',
      'setup-failure',
      'late-grain-failure',
      'commit-error',
      'ack-lost',
      'stop-during-commit'
    )
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([modes.map(mode => new Wake(mode))], {
          maxCommands: 4,
        }),
        async (scheduler, commands) => {
          const real = await worker(scheduler)
          try {
            await fc.asyncModelRun(
              () => ({ model: { committed: 0, stopped: false }, real }),
              commands
            )
          } finally {
            await real.stop()
          }
        }
      ),
      { numRuns: 16 }
    )
  })
})

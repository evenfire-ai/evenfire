/**
 * LLM catalog sync cron (Fase 4 §9): the tick calls syncDiscoveredModels under a
 * SESSION advisory lock, deduping across replicas, releasing the lock in every
 * path, and never propagating errors. The default-OFF flag is asserted at the
 * config layer (the cron itself is flag-agnostic; main.ts gates on the flag).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSyncResult } from '../src/services/llmCatalogSync.js'
import {
  runLlmCatalogSyncTick,
  startLlmCatalogSyncCron,
  stopLlmCatalogSyncCron,
} from '../src/services/llmCatalogSyncCron.js'

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

const OK: CatalogSyncResult = {
  source: 'live',
  fetchedAt: '2026-08-12T00:00:00.000Z',
  ranAt: '2026-08-12T00:00:00.000Z',
  added: 0,
  updated: 0,
  staled: 0,
}

/**
 * A fake pool sharing a single advisory-lock state across every client it hands
 * out — the real cross-replica contract. `calls` records the lock lifecycle.
 */
function makeLockPool(
  shared: { held: boolean },
  calls: string[],
  opts: { failUnlock?: boolean } = {}
) {
  const releaseArgs: Array<Error | boolean | undefined> = []
  const connector = {
    releaseArgs,
    connect: vi.fn(async () => {
      const query = vi.fn(async (sql: string) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const acquired = !shared.held
          if (acquired) shared.held = true
          calls.push(acquired ? 'acquire:ok' : 'acquire:skip')
          return { rows: [{ acquired }], rowCount: 1 }
        }
        if (/pg_advisory_unlock/.test(sql)) {
          // Simulate a broken unlock: the SESSION lock is NOT freed here.
          if (opts.failUnlock) {
            calls.push('unlock:throw')
            throw new Error('unlock failed')
          }
          shared.held = false
          calls.push('unlock')
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      })
      const release = vi.fn((destroy?: Error | boolean) => {
        releaseArgs.push(destroy)
        if (destroy) {
          // Destroying the connection ends the session → the lock is freed even
          // though the explicit unlock failed.
          shared.held = false
          calls.push('release:destroy')
        } else {
          calls.push('release')
        }
      })
      return { query, release }
    }),
  }
  return connector
}

afterEach(() => {
  stopLlmCatalogSyncCron()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runLlmCatalogSyncTick', () => {
  it('acquires the lock, runs the sync, then unlocks and releases — in order', async () => {
    const calls: string[] = []
    const connector = makeLockPool({ held: false }, calls)
    const sync = vi.fn(async () => OK)

    const res = await runLlmCatalogSyncTick({ connector, sync })

    expect(sync).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ skippedLock: false, ran: true, errored: false })
    // Full session-lock cycle: acquire → (work) → unlock → release.
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release'])
  })

  it('skips the tick when the lock is already held (no sync, no unlock, still releases)', async () => {
    const calls: string[] = []
    const connector = makeLockPool({ held: true }, calls) // lock already taken
    const sync = vi.fn(async () => OK)

    const res = await runLlmCatalogSyncTick({ connector, sync })

    expect(sync).not.toHaveBeenCalled()
    expect(res.skippedLock).toBe(true)
    // We only unlock what we acquired: skip → no unlock, but the client is released.
    expect(calls).toEqual(['acquire:skip', 'release'])
  })

  it('never propagates a sync error; still unlocks and releases', async () => {
    const calls: string[] = []
    const connector = makeLockPool({ held: false }, calls)
    const sync = vi.fn(async () => {
      throw new Error('boom')
    })

    const res = await runLlmCatalogSyncTick({ connector, sync })

    expect(res.errored).toBe(true)
    expect(res.ran).toBe(false)
    // Lock released despite the failure — no wedged lock.
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release'])
  })

  it('DESTROYS the connection (not a plain release) when pg_advisory_unlock throws', async () => {
    const calls: string[] = []
    const shared = { held: false }
    const connector = makeLockPool(shared, calls, { failUnlock: true })
    const sync = vi.fn(async () => OK)

    const res = await runLlmCatalogSyncTick({ connector, sync })

    // The tick still ran and did not propagate; the unlock threw and was caught.
    expect(res).toEqual({ skippedLock: false, ran: true, errored: false })
    // No neutral pool-release on this path — the connection is DESTROYED with the
    // error so the session (and thus the session lock) actually ends. Exactly one
    // release call, and it carries the error (no double-release, no live-conn reuse).
    expect(connector.releaseArgs).toHaveLength(1)
    expect(connector.releaseArgs[0]).toBeInstanceOf(Error)
    expect(calls).toEqual(['acquire:ok', 'unlock:throw', 'release:destroy'])
    // Observable invariant: no lock left hanging on the (now destroyed) connection.
    expect(shared.held).toBe(false)
  })

  it('does not propagate when connector.connect() throws (no hung state, no release)', async () => {
    const connectErr = new Error('pool exhausted')
    const connector = { connect: vi.fn(async () => Promise.reject(connectErr)) }
    const sync = vi.fn(async () => OK)

    const res = await runLlmCatalogSyncTick({ connector, sync })

    // Caught and reported, never thrown; sync never reached; nothing to release.
    expect(res).toEqual({ skippedLock: false, ran: false, errored: true })
    expect(sync).not.toHaveBeenCalled()
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('two replicas do NOT run the tick concurrently (session advisory lock)', async () => {
    const calls: string[] = []
    const shared = { held: false }
    const connector = makeLockPool(shared, calls)

    // Replica A holds the lock while its sync is in flight (deferred).
    let releaseA: () => void = () => {}
    const syncA = vi.fn(
      () =>
        new Promise<CatalogSyncResult>(resolve => {
          releaseA = () => resolve(OK)
        })
    )
    const syncB = vi.fn(async () => OK)

    const tickA = runLlmCatalogSyncTick({ connector, sync: syncA })
    // Let A acquire the lock before B tries.
    await vi.waitFor(() => expect(shared.held).toBe(true))

    const resB = await runLlmCatalogSyncTick({ connector, sync: syncB })
    expect(resB.skippedLock).toBe(true)
    expect(syncB).not.toHaveBeenCalled()

    releaseA()
    const resA = await tickA
    expect(resA.ran).toBe(true)
    expect(syncA).toHaveBeenCalledTimes(1)
  })
})

describe('startLlmCatalogSyncCron', () => {
  it('unref()s the interval so it never holds the process open', () => {
    const unref = vi.fn()
    const spy = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)

    startLlmCatalogSyncCron(
      { connector: makeLockPool({ held: false }, []), sync: async () => OK },
      1000
    )
    expect(unref).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('fires the tick on the interval and stops firing after stop', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const connector = makeLockPool({ held: false }, calls)
    const sync = vi.fn(async () => OK)

    startLlmCatalogSyncCron({ connector, sync }, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sync).toHaveBeenCalledTimes(1)

    stopLlmCatalogSyncCron()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sync).toHaveBeenCalledTimes(1) // no further ticks after stop
  })

  it('is idempotent — a second start does not create a second interval', () => {
    const spy = vi.spyOn(global, 'setInterval')
    const deps = { connector: makeLockPool({ held: false }, []), sync: async () => OK }
    startLlmCatalogSyncCron(deps, 1000)
    startLlmCatalogSyncCron(deps, 1000)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('config flag — default OFF, strict === "true"', () => {
  const ENV = 'LLM_CATALOG_SYNC_CRON_ENABLED'
  afterEach(() => {
    delete process.env[ENV]
    vi.resetModules()
  })

  async function loadFlag(value?: string): Promise<boolean> {
    vi.resetModules()
    if (value === undefined) delete process.env[ENV]
    else process.env[ENV] = value
    const { config } = await import('../src/config.js')
    return config.llmCatalogSyncCronEnabled
  }

  it('is false when unset', async () => {
    expect(await loadFlag(undefined)).toBe(false)
  })
  it('is true only for exactly "true"', async () => {
    expect(await loadFlag('true')).toBe(true)
  })
  it('is false for the default-on idiom values ("1", "false")', async () => {
    expect(await loadFlag('1')).toBe(false)
    expect(await loadFlag('false')).toBe(false)
  })
})

/**
 * LLM catalog sync cron (Fase 4 §9): the tick calls syncDiscoveredModels under a
 * SESSION advisory lock, deduping across replicas, releasing the lock in every
 * path, and never propagating errors. The default-OFF flag is asserted at the
 * config layer (the cron itself is flag-agnostic; main.ts gates on the flag).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSyncResult } from '../src/services/llmCatalogSync.js'
import {
  LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS,
  type LlmCatalogSyncCronDeps,
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
  enabledImageInputChanged: 0,
  materialized: false,
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
  // Interval far above the first-run jitter, so advancing past the jitter can
  // never also reach the first interval tick, whatever Math.random returns.
  const INTERVAL_MS = 60_000

  it('unref()s both the first-run timeout and the interval so neither holds the process open', () => {
    const timeoutUnref = vi.fn()
    const intervalUnref = vi.fn()
    let firstRun: (() => void) | undefined
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      firstRun = fn
      return { unref: timeoutUnref } as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    const intervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref: intervalUnref } as unknown as ReturnType<typeof setInterval>)

    startLlmCatalogSyncCron(
      { connector: makeLockPool({ held: false }, []), sync: async () => OK },
      INTERVAL_MS
    )
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutUnref).toHaveBeenCalledTimes(1)
    // The interval is armed by the first run, not by start().
    expect(intervalSpy).not.toHaveBeenCalled()
    expect(firstRun).toBeTypeOf('function')

    firstRun?.()
    expect(intervalSpy).toHaveBeenCalledTimes(1)
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(INTERVAL_MS)
    expect(intervalUnref).toHaveBeenCalledTimes(1)
  })

  it('schedules the first run inside the jitter window, not one interval later', () => {
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    startLlmCatalogSyncCron(
      { connector: makeLockPool({ held: false }, []), sync: async () => OK },
      INTERVAL_MS
    )
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    const delay = timeoutSpy.mock.calls[0]?.[1]
    expect(delay).toBeGreaterThanOrEqual(0)
    expect(delay).toBeLessThan(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
  })

  it('runs one tick shortly after start, then keeps ticking on the interval', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const connector = makeLockPool({ held: false }, calls)
    const sync = vi.fn(async () => OK)

    startLlmCatalogSyncCron({ connector, sync }, INTERVAL_MS)
    // start() does not run the tick synchronously — boot never waits on it.
    expect(sync).not.toHaveBeenCalled()
    expect(connector.connect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    // One full lock-guarded tick, long before the first interval would elapse.
    expect(sync).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release'])

    // Witness that the interval still runs after the first tick.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release', 'acquire:ok', 'unlock', 'release'])
  })

  it('fires the first run and the interval, and stops firing after stop', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const connector = makeLockPool({ held: false }, calls)
    const sync = vi.fn(async () => OK)

    startLlmCatalogSyncCron({ connector, sync }, INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + INTERVAL_MS)
    expect(sync).toHaveBeenCalledTimes(2) // first run + one interval tick

    stopLlmCatalogSyncCron()
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS)
    expect(sync).toHaveBeenCalledTimes(2) // no further ticks after stop
  })

  it('stop before the first run cancels it; a later start still runs', async () => {
    vi.useFakeTimers()
    const connector = makeLockPool({ held: false }, [])
    const sync = vi.fn(async () => OK)

    startLlmCatalogSyncCron({ connector, sync }, INTERVAL_MS)
    stopLlmCatalogSyncCron()
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + 2 * INTERVAL_MS)
    expect(sync).not.toHaveBeenCalled()
    expect(connector.connect).not.toHaveBeenCalled()

    // Witness: the same clock and deps DO tick once started again, so the zero
    // above is the cancelled first run, not a timer that could never fire.
    startLlmCatalogSyncCron({ connector, sync }, INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second start creates no second first run and no second interval', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    const intervalSpy = vi.spyOn(global, 'setInterval')
    const sync = vi.fn(async () => OK)
    const deps = { connector: makeLockPool({ held: false }, []), sync }

    startLlmCatalogSyncCron(deps, INTERVAL_MS)
    startLlmCatalogSyncCron(deps, INTERVAL_MS) // while the first run is pending
    expect(timeoutSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(intervalSpy).toHaveBeenCalledTimes(1)

    startLlmCatalogSyncCron(deps, INTERVAL_MS) // after the interval is armed
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(intervalSpy).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(2) // one first run + one interval tick
  })

  it('requires an injected sync (compile-time)', () => {
    // #654: the sync now needs a ConfigMap materializer and the cron has no
    // gateway, so a default here could only be a call the sync would reject.
    // The guarantee is the TYPE, not a runtime branch — hence no assertion on
    // behaviour, only that omitting `sync` fails to compile.
    // @ts-expect-error `sync` is required
    const missingSync: LlmCatalogSyncCronDeps = { connector: makeLockPool({ held: false }, []) }
    expect(missingSync.connector).toBeDefined()
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

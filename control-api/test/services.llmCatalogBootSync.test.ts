/**
 * The boot catalog sync: the cron's first tick, or a tick of its own with the
 * cron off, retried while it could not decide. The real sync runs against the
 * strict fake DB, so what each test asserts is what the runs left behind
 * (`llm_catalog_sync_runs`, the rows) — except the probe schedule, which is a
 * cost bound and is asserted as the times models.dev was asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import { assessCatalog, syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import {
  LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS,
  LLM_CATALOG_BOOT_SYNC_RETRY_MAX_DELAY_MS,
  LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS,
  type LlmCatalogSyncCronDeps,
  startLlmCatalogBootSync,
  startLlmCatalogSyncCron,
  stopLlmCatalogSyncCron,
} from '../src/services/llmCatalogSyncCron.js'
import {
  type ModelsDevCatalogResult,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { type FakeDb, makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
  trimSnapshot,
} from './helpers/modelsDevFixtures.js'

const CRON_LOCK = "SELECT pg_try_advisory_lock(hashtext('llm-catalog-sync-cron-v1')) AS acquired"
const HOUR = 60 * 60 * 1000
const INTERVAL_MS = 24 * HOUR

const ALL_CLAUDE = Object.keys(LIVE_MODELS_DEV_CATALOG.anthropic.models).length
const LIVE = loadStub(
  trimLiveCatalog({ anthropic: ALL_CLAUDE }),
  'live',
  LIVE_MODELS_DEV_CAPTURED_AT
)
const SMALL_LIVE = loadStub(trimLiveCatalog({ anthropic: 2 }), 'live', LIVE_MODELS_DEV_CAPTURED_AT)
const VENDORED = loadStub(trimSnapshot({ anthropic: 5 }), 'vendored')
const VENDORED_WITH_OFF_PROVIDER = loadStub(trimSnapshot({ anthropic: 5, groq: 3 }), 'vendored')
// Above the small live catalog, below the whole provider: the small one is implausible.
const FLOOR = 5

/** A models.dev that answers each probe from `answers`, repeating the last one. */
function modelsDev(answers: Array<() => Promise<ModelsDevCatalogResult>>) {
  const askedAt: number[] = []
  return {
    askedAt,
    load: async () => {
      askedAt.push(Date.now())
      return answers[Math.min(askedAt.length - 1, answers.length - 1)]()
    },
  }
}

/** Advances fake time in small steps until `done()` holds, at most `limitMs`. */
async function advanceUntil(done: () => boolean, limitMs = 10_000, stepMs = 50): Promise<void> {
  for (let waited = 0; !done(); waited += stepMs) {
    if (waited >= limitMs) throw new Error(`condition not met within ${limitMs}ms of fake time`)
    await vi.advanceTimersByTimeAsync(stepMs)
  }
}

let db: FakeDb
let retry: AllowlistPublishRetry

function deps(
  boot: () => Promise<ModelsDevCatalogResult>,
  probe: () => Promise<ModelsDevCatalogResult>,
  cron = db.pool('cron')
): LlmCatalogSyncCronDeps {
  return {
    connector: cron as never,
    sync: catalog =>
      syncDiscoveredModels(
        {
          materializer: db.materializer,
          loadCatalog: catalog ? async () => catalog : boot,
          minPlausibleLiveTotal: FLOOR,
          publishRetry: retry,
        },
        db.connector
      ),
    loadCatalog: probe,
    isDecidable: c => assessCatalog(c, FLOOR).decidable,
  }
}

const sources = () => db.runs.map(r => r.source)
const enabledClaude = () => db.rows.filter(r => r.provider === 'claude' && r.enabled).length
const eligibleClaude = mapCatalogToProviders(
  trimLiveCatalog({ anthropic: ALL_CLAUDE })
).claude.filter(isAutoEnableEligible).length

beforeEach(() => {
  vi.useFakeTimers()
  db = makeFakeDb()
  retry = new AllowlistPublishRetry()
})

afterEach(() => {
  stopLlmCatalogSyncCron()
  retry.stop()
  vi.useRealTimers()
})

describe('boot catalog sync', () => {
  it('with the cron on, the boot sync is its first tick: one run at start', async () => {
    const probe = modelsDev([LIVE])
    startLlmCatalogSyncCron(deps(LIVE, probe.load), INTERVAL_MS)
    // A boot sync started on top of the cron is the same schedule, not a second run.
    startLlmCatalogBootSync(deps(LIVE, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + 2 * HOUR)
    expect(sources()).toEqual(['live'])
    expect(enabledClaude()).toBe(eligibleClaude)
    expect(probe.askedAt).toEqual([])
  })

  it('with the cron off, runs once at start and never again', async () => {
    startLlmCatalogBootSync(deps(LIVE, modelsDev([LIVE]).load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['live'])
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS)
    expect(sources()).toEqual(['live'])
  })

  it('a vendored boot sync is retried by probing only, and reconciles once models.dev answers live', async () => {
    const probe = modelsDev([VENDORED, VENDORED, LIVE])
    startLlmCatalogBootSync(deps(VENDORED, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['vendored'])
    // An ON provider gets nothing from a run that cannot decide.
    expect(enabledClaude()).toBe(0)

    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS * 3)
    // Two vendored probes reconciled nothing: still one vendored run.
    expect(probe.askedAt).toHaveLength(2)
    expect(sources()).toEqual(['vendored'])

    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS * 4)
    expect(probe.askedAt).toHaveLength(3)
    expect(sources()).toEqual(['vendored', 'live'])
    expect(enabledClaude()).toBe(eligibleClaude)

    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(probe.askedAt).toHaveLength(3)
    expect(sources()).toEqual(['vendored', 'live'])
  })

  it('an implausibly small live boot sync is retried like a vendored one', async () => {
    const probe = modelsDev([SMALL_LIVE, LIVE])
    startLlmCatalogBootSync(deps(SMALL_LIVE, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['live'])
    expect(enabledClaude()).toBe(0)

    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS * 3)
    expect(probe.askedAt).toHaveLength(2)
    expect(sources()).toEqual(['live', 'live'])
    expect(enabledClaude()).toBe(eligibleClaude)
  })

  it('backs off exponentially between probes, capped at one hour', async () => {
    const probe = modelsDev([VENDORED])
    startLlmCatalogBootSync(deps(VENDORED, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    const bootAt = Date.now()
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    const gaps = probe.askedAt.map((t, i) => t - (i === 0 ? bootAt : probe.askedAt[i - 1]))
    const expected = gaps.map((_, i) =>
      Math.min(
        LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS * 2 ** i,
        LLM_CATALOG_BOOT_SYNC_RETRY_MAX_DELAY_MS
      )
    )
    expect(gaps.length).toBeGreaterThan(8)
    // The boot tick's own work runs inside the first gap's clock, so it is
    // allowed to start a little later than the delay itself.
    expect(gaps.slice(1)).toEqual(expected.slice(1))
    expect(gaps.at(-1)).toBe(LLM_CATALOG_BOOT_SYNC_RETRY_MAX_DELAY_MS)
    expect(sources()).toEqual(['vendored'])
  })

  it('does not retry a boot sync another replica was already running', async () => {
    const other = await db.pool('other-replica').connect()
    expect((await other.query(CRON_LOCK)).rows).toEqual([{ acquired: true }])
    const probe = modelsDev([LIVE])
    startLlmCatalogBootSync(deps(VENDORED, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + 12 * HOUR)
    expect(sources()).toEqual([])
    expect(probe.askedAt).toEqual([])
  })

  it('stops retrying when a decidable probe finds another replica syncing', async () => {
    const probe = modelsDev([LIVE])
    startLlmCatalogBootSync(deps(VENDORED, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['vendored'])
    const other = await db.pool('other-replica').connect()
    expect((await other.query(CRON_LOCK)).rows).toEqual([{ acquired: true }])
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(probe.askedAt).toHaveLength(1)
    expect(sources()).toEqual(['vendored'])
  })

  it('a decidable interval tick cancels a pending probe', async () => {
    const probe = modelsDev([LIVE])
    let bootAnswer = VENDORED
    startLlmCatalogSyncCron(
      deps(() => bootAnswer(), probe.load),
      LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS / 2
    )
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['vendored'])
    bootAnswer = LIVE
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS / 2)
    expect(sources()).toEqual(['vendored', 'live'])
    // Past the moment the first probe was due: the live tick had cleared it.
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(probe.askedAt).toEqual([])
  })

  it('stop clears a pending probe', async () => {
    const probe = modelsDev([LIVE])
    startLlmCatalogBootSync(deps(VENDORED, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['vendored'])
    stopLlmCatalogSyncCron()
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(probe.askedAt).toEqual([])
    expect(sources()).toEqual(['vendored'])
  })

  it('an errored boot sync runs the whole tick again until a run commits, then decides', async () => {
    const probe = modelsDev([LIVE])
    let bootLoads = 0
    const failingTwice = async (): Promise<ModelsDevCatalogResult> => {
      bootLoads += 1
      if (bootLoads <= 2) throw new Error('database unavailable')
      return LIVE()
    }
    startLlmCatalogBootSync(deps(failingTwice, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual([])
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(bootLoads).toBe(2)
    expect(sources()).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(bootLoads).toBe(3)
    expect(sources()).toEqual(['live'])
    expect(enabledClaude()).toBe(eligibleClaude)
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(sources()).toEqual(['live'])
    expect(probe.askedAt).toEqual([])
  })

  it.each([2, 3])(
    'offline, %i failures before committing, then vendored: one vendored reconcile, then probes only',
    async failures => {
      const probe = modelsDev([VENDORED])
      let bootLoads = 0
      const blipsThenOffline = async (): Promise<ModelsDevCatalogResult> => {
        bootLoads += 1
        if (bootLoads <= failures) throw new Error('database unavailable')
        return VENDORED()
      }
      startLlmCatalogBootSync(deps(blipsThenOffline, probe.load))
      await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + 48 * HOUR)
      expect(sources()).toEqual(['vendored'])
      expect(bootLoads).toBe(failures + 1)
      expect(probe.askedAt.length).toBeGreaterThan(5)
    }
  )

  it('offline, a boot that failed before committing reconciles vendored once, then only probes', async () => {
    const probe = modelsDev([VENDORED])
    let bootLoads = 0
    const blipThenOffline = async (): Promise<ModelsDevCatalogResult> => {
      bootLoads += 1
      if (bootLoads === 1) throw new Error('database unavailable')
      return VENDORED()
    }
    startLlmCatalogBootSync(deps(blipThenOffline, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual([])
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(sources()).toEqual(['vendored'])
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(sources()).toEqual(['vendored'])
    expect(bootLoads).toBe(2)
    expect(probe.askedAt.length).toBeGreaterThan(5)
  })

  it('a decidable boot run whose only failure is the ConfigMap publish is not re-run; the publish retry repairs it', async () => {
    db.cluster.failNextWrites(1000)
    const probe = modelsDev([LIVE])
    startLlmCatalogBootSync(deps(LIVE, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + 12 * HOUR)
    expect(sources()).toEqual(['live'])
    expect(probe.askedAt).toEqual([])
    expect(db.cluster.data).toBeUndefined()
    // K8s recovers: the publish retry, not another run, writes the ConfigMap.
    db.cluster.clearPendingFailures()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(sources()).toEqual(['live'])
    expect(db.cluster.data).toEqual((await db.expectedConfigMap()).data)
  })

  it('an undecidable boot run whose publish failed is still probed again', async () => {
    // Every write fails: the writer retries a failed write itself, so failing
    // fewer writes than its attempts lets the publish succeed.
    db.cluster.failNextWrites(1000)
    const probe = modelsDev([LIVE])
    // A vendored run with an OFF provider inserts rows, so it has something to publish.
    startLlmCatalogBootSync(deps(VENDORED_WITH_OFF_PROVIDER, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    // The writer sleeps between its attempts, so the boot tick can end past the
    // jitter window; the probe is due one base delay after it ends, not after
    // the window.
    await advanceUntil(() => retry.isPending())
    expect(sources()).toEqual(['vendored'])
    expect(db.cluster.data).toBeUndefined()
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(probe.askedAt).toHaveLength(1)
    expect(sources()).toEqual(['vendored', 'live'])
  })

  it('a probe whose sync errors is retried with backoff', async () => {
    const probe = modelsDev([LIVE])
    const base = deps(VENDORED, probe.load)
    let probeSyncs = 0
    const flaky: LlmCatalogSyncCronDeps = {
      ...base,
      sync: async catalog => {
        if (catalog && (probeSyncs += 1) === 1) throw new Error('database unavailable')
        return base.sync(catalog)
      },
    }
    startLlmCatalogBootSync(flaky)
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(sources()).toEqual(['vendored'])
    await vi.advanceTimersByTimeAsync(2 * LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(sources()).toEqual(['vendored', 'live'])
    // The failed probe counts as a failure: the next one waits twice as long.
    expect(probe.askedAt).toHaveLength(2)
    expect(probe.askedAt[1] - probe.askedAt[0]).toBe(2 * LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
  })

  it('a probe in flight when an interval tick decides runs no sync', async () => {
    let answer!: (c: ModelsDevCatalogResult) => void
    const askedAt: number[] = []
    const load = () => {
      askedAt.push(Date.now())
      return new Promise<ModelsDevCatalogResult>(resolve => {
        answer = resolve
      })
    }
    let bootAnswer = VENDORED
    // The interval fires after the probe started and before it returns.
    const INTERVAL = LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS + 10_000
    startLlmCatalogSyncCron(
      deps(() => bootAnswer(), load),
      INTERVAL
    )
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    expect(sources()).toEqual(['vendored'])
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(askedAt).toHaveLength(1)
    bootAnswer = LIVE
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sources()).toEqual(['vendored', 'live'])
    answer(await LIVE())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sources()).toEqual(['vendored', 'live'])
    stopLlmCatalogSyncCron()
  })

  it('a probe that finds its own interval tick holding the lock keeps the chain going', async () => {
    let release!: (c: ModelsDevCatalogResult) => void
    let bootCalls = 0
    // The boot tick and every interval tick read vendored; the first interval
    // tick is still loading (and holding the cron lock) when the probe arrives.
    const boot = async () => {
      bootCalls += 1
      if (bootCalls !== 2) return VENDORED()
      return new Promise<ModelsDevCatalogResult>(resolve => {
        release = resolve
      })
    }
    const probe = modelsDev([LIVE])
    startLlmCatalogSyncCron(
      deps(boot, probe.load),
      LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS - 5_000
    )
    await vi.advanceTimersByTimeAsync(
      LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS
    )
    expect(probe.askedAt).toHaveLength(1)
    expect(sources()).toEqual(['vendored'])
    release(await VENDORED())
    await vi.advanceTimersByTimeAsync(2 * LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS)
    expect(probe.askedAt).toHaveLength(2)
    expect(sources()).toContain('live')
    stopLlmCatalogSyncCron()
  })

  it('a second start while the boot tick runs does not start another chain', async () => {
    let release!: (c: ModelsDevCatalogResult) => void
    const slow = () =>
      new Promise<ModelsDevCatalogResult>(resolve => {
        release = resolve
      })
    const probe = modelsDev([LIVE])
    startLlmCatalogBootSync(deps(slow, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    // A second chain would find the cron lock held by the first tick, end, and
    // leave the first chain's retry orphaned.
    startLlmCatalogBootSync(deps(LIVE, probe.load))
    await vi.advanceTimersByTimeAsync(LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
    release(await VENDORED())
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(sources()).toEqual(['vendored', 'live'])
    expect(probe.askedAt).toHaveLength(1)
  })

  it('a probe in flight at stop does not arm another', async () => {
    let answer!: (c: ModelsDevCatalogResult) => void
    const askedAt: number[] = []
    const load = () => {
      askedAt.push(Date.now())
      return new Promise<ModelsDevCatalogResult>(resolve => {
        answer = resolve
      })
    }
    startLlmCatalogBootSync(deps(VENDORED, load))
    await vi.advanceTimersByTimeAsync(
      LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS + LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS
    )
    expect(askedAt).toHaveLength(1)
    stopLlmCatalogSyncCron()
    answer(await VENDORED())
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(askedAt).toHaveLength(1)
    expect(sources()).toEqual(['vendored'])
  })
})

describe('LLM_CATALOG_BOOT_SYNC_ENABLED', () => {
  const ENV = 'LLM_CATALOG_BOOT_SYNC_ENABLED'
  afterEach(() => {
    delete process.env[ENV]
    vi.resetModules()
  })

  async function load(value?: string) {
    vi.resetModules()
    if (value === undefined) delete process.env[ENV]
    else process.env[ENV] = value
    const { config } = await import('../src/config.js')
    return config.llmCatalogBootSyncEnabled
  }

  it('is on by default', async () => {
    expect(await load(undefined)).toBe(true)
    expect(await load('')).toBe(true)
  })
  it('accepts exactly true and false', async () => {
    expect(await load('true')).toBe(true)
    expect(await load('false')).toBe(false)
  })
  it.each(['0', 'no', 'FALSE', 'off'])('refuses %j at boot', async value => {
    await expect(load(value)).rejects.toThrow(`${ENV} must be 'true' or 'false'`)
  })
})

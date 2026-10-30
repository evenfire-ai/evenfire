/**
 * The catalog sync publishes the allowlist ConfigMap by STATE: after its commit
 * it compares the CM with what Postgres projects now and writes on a difference.
 * Driven end to end with the real sync and the real writer; only Postgres (the
 * in-memory table model) and the apiserver (a ConfigMap fake with real
 * create/replace/resourceVersion semantics) are simulated.
 *
 * The served change is an ENABLED row whose image-input evidence the run
 * refreshes: the only thing a run can change in what runtime is served.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { stopLlmCatalogSyncCron } from '../src/services/llmCatalogSyncCron.js'
import { type FakeDb, makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { loadStub, trimSnapshot, withModalities } from './helpers/modelsDevFixtures.js'

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

const LOW_FLOOR = { minPlausibleLiveTotal: 1 }
const CAPTURED_AT = '2026-08-19T16:16:10.000Z'

const oldDiscovery: ImageInputCapability = {
  state: 'unknown',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-07-01T00:00:00.000Z',
  },
}

const CATALOG = withModalities(
  trimSnapshot({ anthropic: ['claude-opus-4-6', 'claude-opus-4-5'] }),
  {
    'claude-opus-4-6': ['text', 'image'],
    'claude-opus-4-5': ['text'],
  }
)

function seededDb(): FakeDb {
  return makeFakeDb([
    // Enabled with older discovery evidence: the first run refreshes it, which
    // changes the served `imageInput`; every later run leaves it as is.
    {
      provider: 'claude',
      model: 'claude-opus-4-6',
      source: 'discovery',
      enabled: true,
      image_input: oldDiscovery,
    },
    { provider: 'claude', model: 'claude-opus-4-5', source: 'discovery', enabled: false },
  ])
}

function runSync(db: FakeDb, publishRetry: AllowlistPublishRetry) {
  return syncDiscoveredModels(
    {
      materializer: db.materializer,
      publishRetry,
      loadCatalog: loadStub(CATALOG, 'live', CAPTURED_AT),
      ...LOW_FLOOR,
    },
    db.connector
  )
}

async function expectConfigMapMatchesDb(db: FakeDb): Promise<void> {
  const expected = await db.expectedConfigMap()
  expect(db.cluster.data).toEqual(expected.data)
  expect(db.cluster.annotations?.['clerum.io/content-hash']).toBe(expected.contentHash)
}

/** Publish the table as it stands before any run: the CM every test starts from. */
async function publishInitialState(db: FakeDb): Promise<void> {
  await db.materializer.materialize()
  db.materializer.materialize.mockClear()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('catalog sync publication by state', () => {
  it('K1: a run whose database already matches the ConfigMap performs 0 writes', async () => {
    const db = seededDb()
    const retry = new AllowlistPublishRetry()
    await runSync(db, retry)
    await expectConfigMapMatchesDb(db)
    const writesAfterFirst = db.cluster.writes

    const second = await runSync(db, retry)

    expect(second.materialized).toBe(false)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(2)
    expect(db.cluster.writes).toBe(writesAfterFirst)
    await expectConfigMapMatchesDb(db)
  })

  it('T-H5: run N fails to write; run N+1 with no inserts publishes and CM = build(DB)', async () => {
    const db = seededDb()
    await publishInitialState(db)
    const retry = new AllowlistPublishRetry()

    db.cluster.failNextWrites(3)
    await expect(runSync(db, retry)).rejects.toThrow(/apiserver unavailable/)
    // The run committed its change, and the CM does not show it.
    const served = await db.expectedConfigMap()
    expect(db.cluster.annotations?.['clerum.io/content-hash']).not.toBe(served.contentHash)

    const next = await runSync(db, retry)

    // Run N+1 changed nothing a counter could see …
    expect(next.added).toBe(0)
    expect(next.enabledImageInputChanged).toBe(0)
    // … and still repaired the CM.
    expect(next.materialized).toBe(true)
    await expectConfigMapMatchesDb(db)
    expect(retry.isPending()).toBe(false)
    retry.stop()
  })
})

describe('catalog sync publish retry', () => {
  it('T-H5b: with no later run, the backoff retry publishes and CM = build(DB)', async () => {
    vi.useFakeTimers()
    const db = seededDb()
    await publishInitialState(db)
    const retry = new AllowlistPublishRetry({ baseDelayMs: 1_000, maxDelayMs: 4_000 })

    db.cluster.failNextWrites(3)
    const settled = runSync(db, retry).catch(err => err)
    // The writer's own in-call backoff (100 ms + 200 ms), not the retry delay.
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toBeInstanceOf(Error)
    expect(retry.isPending()).toBe(true)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(1)

    // The first retry fails too (3 more write failures); the next one waits
    // twice as long.
    db.cluster.failNextWrites(3)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(2)
    expect(retry.isPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(3)

    expect(retry.isPending()).toBe(false)
    await expectConfigMapMatchesDb(db)
    // Settled: no further retries.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(3)
  })

  it('T-H5b: the backoff is capped', async () => {
    vi.useFakeTimers()
    const db = seededDb()
    await publishInitialState(db)
    const retry = new AllowlistPublishRetry({ baseDelayMs: 1_000, maxDelayMs: 2_000 })
    db.cluster.failNextWrites(3 * 4)
    const settled = runSync(db, retry).catch(err => err)
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toBeInstanceOf(Error)
    // Delays 1 s, 2 s, then capped at 2 s (not 4 s).
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(4)
    retry.stop()
  })

  it('T-H5b: a later successful publication of the same replica cancels the retry', async () => {
    vi.useFakeTimers()
    const db = seededDb()
    await publishInitialState(db)
    const retry = new AllowlistPublishRetry({ baseDelayMs: 1_000 })

    db.cluster.failNextWrites(3)
    const settled = runSync(db, retry).catch(err => err)
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toBeInstanceOf(Error)
    expect(retry.isPending()).toBe(true)

    // Another run publishes before the retry fires.
    await runSync(db, retry)
    expect(retry.isPending()).toBe(false)
    await expectConfigMapMatchesDb(db)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(2)
  })

  it('T-H5b: a success that STARTED before a later failure does not cancel that failure', () => {
    const retry = new AllowlistPublishRetry({ baseDelayMs: 1_000 })
    const db = seededDb()
    const earlier = retry.begin()
    const later = retry.begin()
    retry.failed(later, db.materializer)
    // This success may have read Postgres before the failed run committed.
    retry.succeeded(earlier)
    expect(retry.isPending()).toBe(true)
    retry.stop()
  })

  it('T-H5b: a retry that fails AFTER a later publication succeeded owes nothing', async () => {
    vi.useFakeTimers()
    const db = seededDb()
    let rejectRetry!: (err: Error) => void
    db.materializer.materializeIfChanged.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectRetry = reject))
    )
    const retry = new AllowlistPublishRetry({ baseDelayMs: 1_000 })
    retry.failed(retry.begin(), db.materializer)
    // The retry fires and stays in flight.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(1)

    // A sync that started after the retry publishes successfully.
    const later = retry.begin()
    retry.succeeded(later)
    expect(retry.isPending()).toBe(false)

    rejectRetry(new Error('apiserver unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(retry.isPending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(1)
    retry.stop()
  })

  it('T-H5b: stopping the cron clears a pending publish retry', async () => {
    vi.useFakeTimers()
    const db = seededDb()
    await publishInitialState(db)

    db.cluster.failNextWrites(3)
    // The process-wide retry the cron and the on-demand route share.
    const settled = syncDiscoveredModels(
      {
        materializer: db.materializer,
        loadCatalog: loadStub(CATALOG, 'live', CAPTURED_AT),
        ...LOW_FLOOR,
      },
      db.connector
    ).catch(err => err)
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(1)

    stopLlmCatalogSyncCron()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(db.materializer.materializeIfChanged).toHaveBeenCalledTimes(1)
  })
})

/**
 * LLM catalog discovery sync cron (spec 09 Fase 4).
 *
 * Periodically runs `syncDiscoveredModels()` — the SAME non-destructive
 * reconciliation the on-demand `POST /admin/llm-models/discovery/sync` endpoint
 * drives. No HTTP hop, no new auth: the tick calls the service directly. New
 * models land as `source='discovery'`, disabled unless the provider's policy
 * and the per-run caps allow enabling them on insert (see the header of
 * llmCatalogSync.ts); vanished models are only ever flagged `stale=true` (never
 * deleted, never disabled), and only when the §4.5 sanity guards agree the live
 * catalog is trustworthy.
 *
 * Cross-replica dedup: control-api runs multiple replicas, and 24h ticks across
 * them would otherwise pile up redundant runs. Each tick wraps its work in a
 * SESSION-scoped `pg_try_advisory_lock(hashtext('llm-catalog-sync-cron-v1'))`
 * on a dedicated client. If another replica already holds it, this tick is a
 * no-op. A session lock (unlike the xact lock inside syncDiscoveredModels) is
 * NOT auto-released on COMMIT, so it MUST be explicitly unlocked — a leaked lock
 * would wedge every future tick. The `finally` guarantees unlock + release.
 *
 * The service's own `pg_advisory_xact_lock` still runs and still serializes a
 * concurrent on-demand sync against this cron; the session lock here is an
 * ADDITIONAL guard that avoids queuing redundant cron ticks behind it.
 *
 * Scheduling follows workflowScheduleWorkerCron.ts: the first tick runs shortly
 * after start (random jitter up to LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS), then
 * every `intervalMs`. Both timers are unref()'d, start is not awaited by boot,
 * and errors are logged but NEVER thrown.
 *
 * Boot sync. The first tick IS the boot sync, so a replica with the cron on runs
 * exactly one sync at start. With the cron off, `startLlmCatalogBootSync` runs
 * that same first tick alone. Without seeded models a fresh installation has
 * nothing to serve until a sync can decide, so a boot sync whose catalog was
 * vendored or implausibly small is retried with exponential backoff (capped at
 * one hour), and so is one that failed before committing. A retry only PROBES
 * models.dev and reconciles once the catalog it got is live and plausible:
 * reconciling the vendored snapshot again would only repeat what the boot sync
 * already did. The exception is a chain that has not committed any run yet,
 * because every attempt so far failed before committing: it reconciled
 * nothing, so its retries run the whole tick on whatever catalog they load
 * until one commits. A run that committed but failed to publish
 * the ConfigMap is not retried here; the publish retry owns it. A boot sync
 * skipped because another replica holds the lock is not retried: that replica
 * is syncing.
 */
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { stopLlmAllowlistPublishRetry } from './llmAllowlistPublishRetry.js'
import {
  CatalogPublishAfterCommitError,
  type CatalogSyncResult,
  assessCatalog,
} from './llmCatalogSync.js'
import { type ModelsDevCatalogResult, loadModelsDevCatalog } from './modelsDevClient.js'

const log = rootLogger.child({ service: 'llm_catalog_sync_cron' })

// Session-scoped advisory lock key. `-cron-v1` distinguishes it from the
// service's own xact lock (`llm-catalog-sync-v1`) — they are different locks
// with different scopes and must not collide.
const CRON_LOCK_KEY_SQL = "hashtext('llm-catalog-sync-cron-v1')"

/**
 * Minimal client shape for the advisory-lock session. pg's PoolClient satisfies
 * it. `release` accepts pg's optional destroy argument: passing a truthy value
 * (an Error) DESTROYS the connection instead of returning it to the pool — the
 * only way to guarantee a SESSION advisory lock is freed when unlock itself fails.
 */
type LockClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
  release: (destroy?: Error | boolean) => void
}

/**
 * Injectable dependencies. `connector` defaults to production wiring; `sync` is
 * REQUIRED because the sync now needs a ConfigMap materializer (#654) and the
 * cron has no gateway of its own — `main.ts` owns that wiring and passes a
 * closure. A default here could only be a call the sync would reject.
 */
export interface LlmCatalogSyncCronDeps {
  connector?: { connect: () => Promise<LockClient> }
  /** Runs one sync; given a catalog, reconciles that one instead of loading its own. */
  sync: (catalog?: ModelsDevCatalogResult) => Promise<CatalogSyncResult>
  /** How a boot-sync retry probes models.dev (default: the real loader). */
  loadCatalog?: () => Promise<ModelsDevCatalogResult>
  /** Whether a probed catalog would let a run decide (default: the sync's own rule). */
  isDecidable?: (catalog: ModelsDevCatalogResult) => boolean
}

/** Outcome of one tick — returned for tests/observability, never thrown. */
export interface LlmCatalogSyncTickResult {
  skippedLock: boolean
  ran: boolean
  errored: boolean
  /** Set when the sync ran: whether its catalog let it decide (see CatalogSyncResult). */
  decidable?: boolean
  /** The run committed but its ConfigMap publish failed; the publish retry owns it. */
  publishFailed?: boolean
}

/**
 * Run one cron tick: acquire the session advisory lock, run the sync, release.
 * Never throws — a failure is logged and reported in the result. The lock is
 * released in `finally` whether the tick ran, skipped, or failed.
 */
export async function runLlmCatalogSyncTick(
  deps: LlmCatalogSyncCronDeps,
  catalog?: ModelsDevCatalogResult
): Promise<LlmCatalogSyncTickResult> {
  const connector = deps.connector ?? pool
  const sync = () => deps.sync(catalog)
  let lockClient: LockClient | undefined
  let locked = false
  try {
    lockClient = await connector.connect()
    const lockRes = await lockClient.query(
      `SELECT pg_try_advisory_lock(${CRON_LOCK_KEY_SQL}) AS acquired`
    )
    locked = (lockRes.rows[0] as { acquired?: boolean } | undefined)?.acquired === true
    if (!locked) {
      log.debug(
        { event: 'llm_catalog_sync_cron_skipped_lock' },
        'llm catalog sync tick skipped: advisory lock held by another replica'
      )
      return { skippedLock: true, ran: false, errored: false }
    }

    const result = await sync()
    log.info(
      {
        event: 'llm_catalog_sync_cron_tick',
        source: result.source,
        added: result.added,
        updated: result.updated,
        staled: result.staled,
      },
      `llm catalog sync tick complete (source=${result.source}, added=${result.added}, updated=${result.updated}, staled=${result.staled})`
    )
    return { skippedLock: false, ran: true, errored: false, decidable: result.decidable }
  } catch (err) {
    // A failed publish after COMMIT is not a failed run: the rows are in, and
    // the publish retry repairs the ConfigMap. Running the sync again for it
    // would only apply the auto-enable caps once more.
    if (err instanceof CatalogPublishAfterCommitError) {
      log.warn(
        { event: 'llm_catalog_sync_cron_publish_failed', decidable: err.decidable },
        'llm catalog sync tick committed; ConfigMap publish failed and is retried on its own'
      )
      return {
        skippedLock: false,
        ran: true,
        errored: false,
        decidable: err.decidable,
        publishFailed: true,
      }
    }
    log.error(
      {
        event: 'llm_catalog_sync_cron_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'llm catalog sync tick failed'
    )
    return { skippedLock: false, ran: false, errored: true }
  } finally {
    if (lockClient) {
      // SESSION lock → explicit unlock is mandatory; only unlock what we acquired.
      let destroyed = false
      if (locked) {
        try {
          await lockClient.query(`SELECT pg_advisory_unlock(${CRON_LOCK_KEY_SQL})`)
        } catch (unlockErr) {
          // A SESSION lock is NOT freed by returning the connection to the pool —
          // only by an explicit unlock or by CLOSING the session. Since the unlock
          // failed, DESTROY the connection (release(err) ends the session), which
          // guarantees the lock is released. A plain release() here would hand a
          // live connection still holding the lock back to the pool and wedge every
          // future tick — exactly the failure the module header promises to avoid.
          const asError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr))
          log.warn(
            {
              event: 'llm_catalog_sync_cron_unlock_failed',
              err: asError.message,
            },
            'pg_advisory_unlock failed; destroying the connection to release the session lock'
          )
          lockClient.release(asError)
          destroyed = true
        }
      }
      // Only return the connection to the pool when we did NOT destroy it above
      // (destroying already released it — a second release would double-release).
      if (!destroyed) lockClient.release()
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let firstRunHandle: ReturnType<typeof setTimeout> | null = null
let bootRetryHandle: ReturnType<typeof setTimeout> | null = null
let bootRetryFailures = 0
// The generation whose boot tick or retry probe is running: a second start
// must not begin another chain while it settles. A stop ends that schedule, so
// a later start is not held back by it.
let bootInFlight: number | null = null
// Interval ticks of this process still running. A boot probe that finds the
// sync lock taken by one of them has not met another replica, only itself.
let intervalTicksInFlight = 0
// Bumped by every start and stop, so a timer or a probe that belongs to an
// earlier schedule cannot act on the current one.
let generation = 0
// Set once any tick of the current schedule decided. A probe already in flight
// when that happened must not run another sync.
let bootDecided = false
// Whether a boot-chain tick has committed a run. Until one has, nothing was
// reconciled, so a retry after an error runs the whole tick on whatever
// catalog it loads, the vendored snapshot included; once one has, retries only
// act on a live catalog.
let bootReconciled = false

/**
 * Upper bound of the random delay before the first tick after start. Keeps the
 * replicas of one rollout from all contending for the advisory lock at the same
 * instant; the lock already makes a collision a harmless no-op.
 */
export const LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS = 5_000

export const LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS = 30_000
export const LLM_CATALOG_BOOT_SYNC_RETRY_MAX_DELAY_MS = 60 * 60 * 1000

function logUnhandled(err: unknown): void {
  log.error(
    {
      event: 'llm_catalog_sync_cron_unhandled',
      err: err instanceof Error ? err.message : String(err),
    },
    'unhandled error in llm catalog sync cron'
  )
}

function clearBootRetry(): void {
  if (bootRetryHandle) {
    clearTimeout(bootRetryHandle)
    bootRetryHandle = null
  }
  bootRetryFailures = 0
}

const decided = (tick: LlmCatalogSyncTickResult) => tick.ran && tick.decidable !== false

function markDecided(): void {
  bootDecided = true
  clearBootRetry()
}

const current = (gen: number) => gen === generation && !bootDecided

function scheduleBootRetry(
  deps: LlmCatalogSyncCronDeps,
  gen: number,
  reason: string,
  mode: 'probe' | 'full' = 'probe'
): void {
  if (!current(gen) || bootRetryHandle) return
  const delayMs = Math.min(
    LLM_CATALOG_BOOT_SYNC_RETRY_BASE_DELAY_MS * 2 ** bootRetryFailures,
    LLM_CATALOG_BOOT_SYNC_RETRY_MAX_DELAY_MS
  )
  bootRetryFailures += 1
  bootRetryHandle = setTimeout(() => {
    bootRetryHandle = null
    bootInFlight = gen
    void (mode === 'full' ? fullBootRetry(deps, gen) : probeAndSync(deps, gen))
      .catch(logUnhandled)
      .finally(() => {
        if (bootInFlight === gen) bootInFlight = null
      })
  }, delayMs)
  bootRetryHandle.unref()
  log.warn(
    {
      event: 'llm_catalog_boot_sync_retry_scheduled',
      reason,
      mode,
      delayMs,
      attempt: bootRetryFailures,
    },
    'llm catalog boot sync did not decide; probing models.dev again later'
  )
}

async function fullBootRetry(deps: LlmCatalogSyncCronDeps, gen: number): Promise<void> {
  if (!current(gen)) return
  afterBootTick(deps, gen, await runLlmCatalogSyncTick(deps))
}

async function probeAndSync(deps: LlmCatalogSyncCronDeps, gen: number): Promise<void> {
  if (!current(gen)) return
  const load = deps.loadCatalog ?? (() => loadModelsDevCatalog())
  const isDecidable = deps.isDecidable ?? (c => assessCatalog(c).decidable)
  let catalog: ModelsDevCatalogResult | null = null
  try {
    catalog = await load()
  } catch (err) {
    log.warn(
      {
        event: 'llm_catalog_boot_sync_probe_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'llm catalog boot sync probe failed'
    )
  }
  if (!current(gen)) return
  if (!catalog || !isDecidable(catalog)) {
    scheduleBootRetry(deps, gen, catalog ? 'undecidable_catalog' : 'probe_failed')
    return
  }
  const tick = await runLlmCatalogSyncTick(deps, catalog)
  afterBootTick(deps, gen, tick)
}

/**
 * Where the boot chain goes after one of its ticks. It ends when a tick
 * decided, or when another replica held the sync lock (that replica is
 * syncing); anything else, an error included, is retried.
 */
function afterBootTick(
  deps: LlmCatalogSyncCronDeps,
  gen: number,
  tick: LlmCatalogSyncTickResult
): void {
  if (gen !== generation) return
  if (tick.ran) bootReconciled = true
  if (decided(tick)) {
    markDecided()
    log.info({ event: 'llm_catalog_boot_sync_decided' }, 'llm catalog boot sync decided')
    return
  }
  if (bootDecided) return
  if (tick.skippedLock) {
    if (intervalTicksInFlight > 0) scheduleBootRetry(deps, gen, 'own_interval_tick_running')
    return
  }
  if (tick.errored) {
    const mode = bootReconciled ? 'probe' : 'full'
    scheduleBootRetry(deps, gen, 'errored', mode)
    return
  }
  scheduleBootRetry(deps, gen, 'undecidable_catalog')
}

function startSchedule(deps: LlmCatalogSyncCronDeps, intervalMs: number | null): void {
  if (intervalHandle || firstRunHandle || bootRetryHandle || bootInFlight === generation) return
  generation += 1
  const gen = generation
  bootRetryFailures = 0
  bootDecided = false
  bootReconciled = false

  // The interval's own runs never schedule a probe; a run that decided makes
  // the boot chain's remaining work pointless.
  const runInterval = (): void => {
    if (gen !== generation) return
    intervalTicksInFlight += 1
    void runLlmCatalogSyncTick(deps)
      .then(tick => {
        if (gen === generation && decided(tick)) markDecided()
      })
      .catch(logUnhandled)
      .finally(() => {
        intervalTicksInFlight -= 1
      })
  }

  // First tick shortly after start instead of one full interval later: rows
  // with no image-input evidence refuse images until a sync runs, and every
  // restart would otherwise push that first sync out by another interval.
  // Not awaited — boot never waits on models.dev.
  const firstDelay = Math.floor(Math.random() * LLM_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
  firstRunHandle = setTimeout(() => {
    firstRunHandle = null
    bootInFlight = gen
    void runLlmCatalogSyncTick(deps)
      .then(tick => afterBootTick(deps, gen, tick))
      .catch(logUnhandled)
      .finally(() => {
        if (bootInFlight === gen) bootInFlight = null
      })
    if (intervalMs !== null) {
      intervalHandle = setInterval(runInterval, intervalMs)
      intervalHandle.unref()
    }
  }, firstDelay)
  firstRunHandle.unref()
  if (intervalMs === null) {
    log.info(
      { event: 'llm_catalog_boot_sync_scheduled', firstRunInMs: firstDelay },
      'llm catalog boot sync scheduled'
    )
  } else {
    log.info(
      { event: 'llm_catalog_sync_cron_started', intervalMs, firstRunInMs: firstDelay },
      'llm catalog sync cron started'
    )
  }
}

/** The periodic cron; its first tick is the boot sync. */
export function startLlmCatalogSyncCron(deps: LlmCatalogSyncCronDeps, intervalMs: number): void {
  startSchedule(deps, intervalMs)
}

/** The boot sync alone, for a replica whose periodic cron is off. */
export function startLlmCatalogBootSync(deps: LlmCatalogSyncCronDeps): void {
  startSchedule(deps, null)
}

/**
 * Also stops the sync's pending ConfigMap publish retry: it belongs to the same
 * process lifecycle and must not fire against a pool that shutdown is closing.
 * Called on shutdown whether or not the cron was started, so a retry owed by an
 * on-demand sync is cleared too.
 */
export function stopLlmCatalogSyncCron(): void {
  generation += 1
  stopLlmAllowlistPublishRetry()
  clearBootRetry()
  if (firstRunHandle) {
    clearTimeout(firstRunHandle)
    firstRunHandle = null
  }
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

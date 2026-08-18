/**
 * LLM catalog discovery sync cron (spec 09 Fase 4).
 *
 * Periodically runs `syncDiscoveredModels()` — the SAME non-destructive
 * reconciliation the on-demand `POST /admin/llm-models/discovery/sync` endpoint
 * drives. No HTTP hop, no new auth: the tick calls the service directly. New
 * models land as `enabled=false, source='discovery'` (inert until an operator
 * enables them); vanished models are only ever flagged `stale=true` (never
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
 * Modeled on budgetReservationSweepCron.ts / workflowScheduleWorkerCron.ts:
 * setInterval + unref, errors logged but NEVER thrown.
 */
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import type { CatalogSyncResult } from './llmCatalogSync.js'
import { syncDiscoveredModels } from './llmCatalogSync.js'

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

/** Injectable dependencies (test seam). Both default to production wiring. */
export interface LlmCatalogSyncCronDeps {
  connector?: { connect: () => Promise<LockClient> }
  sync?: () => Promise<CatalogSyncResult>
}

/** Outcome of one tick — returned for tests/observability, never thrown. */
export interface LlmCatalogSyncTickResult {
  skippedLock: boolean
  ran: boolean
  errored: boolean
}

/**
 * Run one cron tick: acquire the session advisory lock, run the sync, release.
 * Never throws — a failure is logged and reported in the result. The lock is
 * released in `finally` whether the tick ran, skipped, or failed.
 */
export async function runLlmCatalogSyncTick(
  deps: LlmCatalogSyncCronDeps = {}
): Promise<LlmCatalogSyncTickResult> {
  const connector = deps.connector ?? pool
  const sync = deps.sync ?? syncDiscoveredModels
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
    return { skippedLock: false, ran: true, errored: false }
  } catch (err) {
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

export function startLlmCatalogSyncCron(deps: LlmCatalogSyncCronDeps, intervalMs: number): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    // runLlmCatalogSyncTick never rejects, but keep a defensive catch so an
    // unexpected throw can never crash the timer.
    void runLlmCatalogSyncTick(deps).catch(err => {
      log.error(
        {
          event: 'llm_catalog_sync_cron_unhandled',
          err: err instanceof Error ? err.message : String(err),
        },
        'unhandled error in llm catalog sync cron'
      )
    })
  }, intervalMs)
  intervalHandle.unref()
  log.info({ event: 'llm_catalog_sync_cron_started', intervalMs }, 'llm catalog sync cron started')
}

export function stopLlmCatalogSyncCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

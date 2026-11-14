/**
 * Catalog prune: the phase of a catalog sync run that disables enabled models
 * which the public catalog dropped long ago and that nobody uses.
 *
 * A row is a candidate when it is enabled, discovered from a catalog provider,
 * its `enabled` was decided by the catalog (`enabled_managed_by = 'catalog'`,
 * never an operator's decision), it is `stale`, and it has been stale for
 * longer than the grace (`stale_since`, kept by the table's trigger). Candidates
 * are taken oldest-stale first.
 *
 * "Nobody uses it" is `computeModelConsumers`: an explicit reference (Host,
 * grant `allowed_models` or prompt target, WorkflowRecipe) or an all-models
 * Host of the same provider. Two phases:
 *   1. a pre-filter over every candidate, without any lock, against Host and
 *      recipe LISTs taken once for the run. A candidate it sees used is skipped
 *      (the safe side; the next run looks again). This keeps candidates that
 *      will never be pruned from using up the run's locked examinations.
 *   2. for each candidate that looked unused, its own transaction holding the
 *      per-model-name advisory lock that Host writes, grant upserts and the
 *      operator's reduction gate take, with the consumers read again, live,
 *      under that lock. The UPDATE re-checks every candidate condition on the
 *      row (a sync, an operator PUT or another prune may have committed since
 *      the candidate query), the grace included, and the audit row is written
 *      only when that UPDATE reported the row.
 *
 * The run stops after `maxPerRun` disables, or after `2 · maxPerRun` locked
 * examinations (only reached when many candidates gain a consumer between the
 * phases).
 *
 * It never throws. A failed LIST or query aborts the run, keeping what it had
 * already pruned (each prune committed on its own). An escaping error would
 * read as "the sync failed before committing" to the boot sync, which would
 * reconcile again. Every run that got past the decidability check appends one
 * row to `llm_catalog_prune_runs`, aborted or not. A prune injected in place
 * of this one that throws past it gets one more row, written by the sync (see
 * `runPruneSafely` in llmCatalogSync.ts).
 *
 * Runs after the sync's COMMIT and outside its lock: the K8s LISTs here must
 * not hold the catalog sync lock.
 */
import type { Pool } from 'pg'
import { config } from '../config.js'
import {
  type DbClient,
  type DbTransactionClient,
  advisoryLockModelName,
  boundCarrierTransactionIdleTimeout,
  pool,
  withTransaction,
} from '../db.js'
import { safeErrorLogMessage } from '../http/errorHandler.js'
import { rootLogger } from '../observability/logger.js'
import { llmCatalogPruneRunsTotal, llmCatalogPrunedModelsTotal } from '../observability/metrics.js'
import { CATALOG_PROVIDERS, writeCatalogSyncAudit } from './llmAllowedModels.js'
import {
  type ConsumerGateway,
  type ModelConsumerSources,
  computeModelConsumers,
  consumerNamespacesFromConfig,
  memoizeConsumerSources,
  modelConsumerSourcesFromGateway,
  modelHasConsumers,
} from './llmModelConsumers.js'

const log = rootLogger.child({ service: 'llm_catalog_prune' })

/** A row the candidate query returned. */
export interface PruneCandidate {
  id: string
  provider: string
  model: string
}

/**
 * Interleaving points for tests that drive a race deterministically. Never set
 * in production. `beforeLock` runs between the pre-filter and the locked
 * transaction of a candidate; `beforeUpdate` and `beforeCommit` run inside that
 * transaction, with the model lock held (and, for `beforeCommit`, the row
 * already updated).
 */
export interface CatalogPruneHooks {
  beforeLock?: (candidate: PruneCandidate) => Promise<void>
  beforeUpdate?: (candidate: PruneCandidate) => Promise<void>
  beforeCommit?: (candidate: PruneCandidate) => Promise<void>
}

export interface CatalogPruneDeps {
  /**
   * Consumer sources reading grants on `db`. Called once with the pool for the
   * pre-filter (whose Host and recipe LISTs are then memoized for the run) and
   * once per locked candidate with its transaction.
   */
  consumerSources: (db: DbClient) => ModelConsumerSources
  /** Grace counted from `stale_since` (default from config). */
  graceMs?: number
  /** Most disables per run (default from config). */
  maxPerRun?: number
  /** Where the prune's queries and transactions run (default: the core pool). */
  txPool?: Pool
  hooks?: CatalogPruneHooks
}

/** What one prune run did. */
export interface CatalogPruneResult {
  /** The run could not decide (vendored or implausible catalog): nothing was read. */
  skipped: boolean
  candidates: number
  /** Candidates the pre-filter dropped because it saw a consumer. */
  prefiltered: number
  /** Candidates examined under the model lock. */
  examinedLocked: number
  pruned: number
  aborted: boolean
  /** A fixed code, never an error message (those can embed apiserver details). */
  abortReason: CatalogPruneAbortReason | null
}

export type CatalogPruneAbortReason =
  | 'candidates_query_failed'
  | 'prefilter_failed'
  | 'locked_phase_failed'
  /** An injected prune threw past its own guard (the sync converts it). */
  | 'prune_threw'

/** The sync run a prune follows. */
export interface CatalogPruneRun {
  /** Live and plausible: the only runs whose `stale` flags mean something. */
  decidable: boolean
  /** `ran_at` of the sync run (recorded with the prune's row). */
  syncRanAt: string
}

/** The prune as the sync calls it, after its COMMIT. */
export type CatalogPrune = (run: CatalogPruneRun) => Promise<CatalogPruneResult>

class PruneAbort extends Error {
  constructor(
    readonly reason: CatalogPruneAbortReason,
    readonly cause: unknown
  ) {
    super(reason)
  }
}

function graceParam(graceMs: number): number {
  return Math.max(0, graceMs)
}

async function listCandidates(db: DbClient, graceMs: number): Promise<PruneCandidate[]> {
  const res = await db.query(
    `SELECT id, provider, model
       FROM llm_allowed_models
      WHERE enabled
        AND source = 'discovery'
        AND enabled_managed_by = 'catalog'
        AND stale
        AND provider = ANY($1::text[])
        AND stale_since < NOW() - ($2::double precision * INTERVAL '1 millisecond')
      ORDER BY stale_since ASC, id ASC`,
    [CATALOG_PROVIDERS, graceParam(graceMs)]
  )
  return (res.rows as Record<string, unknown>[]).map(row => ({
    id: String(row.id),
    provider: String(row.provider),
    model: String(row.model),
  }))
}

type LockedOutcome = 'pruned' | 'in_use' | 'row_changed'

async function pruneLocked(
  db: DbTransactionClient,
  candidate: PruneCandidate,
  deps: { consumerSources: CatalogPruneDeps['consumerSources']; graceMs: number },
  hooks: CatalogPruneHooks
): Promise<LockedOutcome> {
  // Bound the idle-in-transaction tenancy first: the lock is held across live
  // K8s LISTs, during which the connection is idle in transaction.
  await boundCarrierTransactionIdleTimeout(db)
  await advisoryLockModelName(db, candidate.model)
  const consumers = await computeModelConsumers(
    candidate.provider,
    candidate.model,
    deps.consumerSources(db)
  )
  if (modelHasConsumers(consumers)) return 'in_use'
  await hooks.beforeUpdate?.(candidate)
  const res = await db.query(
    `UPDATE llm_allowed_models
        SET enabled = false, auto_disabled_at = NOW()
      WHERE id = $1
        AND provider = $2 AND model = $3
        AND source = 'discovery'
        AND enabled
        AND enabled_managed_by = 'catalog'
        AND stale
        AND stale_since < NOW() - ($4::double precision * INTERVAL '1 millisecond')`,
    [candidate.id, candidate.provider, candidate.model, graceParam(deps.graceMs)]
  )
  if (res.rowCount !== 1) return 'row_changed'
  await writeCatalogSyncAudit(db, {
    action: 'auto_disable',
    provider: candidate.provider,
    model: candidate.model,
  })
  await hooks.beforeCommit?.(candidate)
  return 'pruned'
}

/**
 * Append the run's row to `llm_catalog_prune_runs`. Best-effort: a failure is
 * logged and swallowed, because the prune (and the sync around it) never throws.
 */
export async function recordCatalogPruneRun(
  db: DbClient,
  run: CatalogPruneRun,
  result: CatalogPruneResult
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO llm_catalog_prune_runs
         (sync_ran_at, candidates, prefiltered, examined_locked, pruned, aborted, abort_reason)
       VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7)`,
      [
        run.syncRanAt,
        result.candidates,
        result.prefiltered,
        result.examinedLocked,
        result.pruned,
        result.aborted,
        result.abortReason,
      ]
    )
  } catch (err) {
    log.error(
      { event: 'llm_catalog_prune_run_record_failed', err: safeErrorLogMessage(err) },
      'llm catalog prune: could not record the run in llm_catalog_prune_runs'
    )
  }
}

export async function pruneStaleCatalogModels(
  run: CatalogPruneRun,
  deps: CatalogPruneDeps
): Promise<CatalogPruneResult> {
  const result: CatalogPruneResult = {
    skipped: false,
    candidates: 0,
    prefiltered: 0,
    examinedLocked: 0,
    pruned: 0,
    aborted: false,
    abortReason: null,
  }
  if (!run.decidable) {
    // A vendored or implausible run does not mark anything stale, so it has no
    // fresh evidence that a model is gone.
    result.skipped = true
    llmCatalogPruneRunsTotal.inc({ outcome: 'skipped' })
    return result
  }
  const graceMs = deps.graceMs ?? config.llmCatalogPruneStaleGraceMs
  const maxPerRun = deps.maxPerRun ?? config.llmCatalogPruneMaxPerRun
  const txPool = deps.txPool ?? (pool as unknown as Pool)
  const hooks = deps.hooks ?? {}

  try {
    let candidates: PruneCandidate[]
    try {
      candidates = await listCandidates(txPool, graceMs)
    } catch (err) {
      throw new PruneAbort('candidates_query_failed', err)
    }
    result.candidates = candidates.length

    const unused: PruneCandidate[] = []
    if (candidates.length > 0) {
      try {
        const memo = memoizeConsumerSources(deps.consumerSources(txPool))
        for (const candidate of candidates) {
          const consumers = await computeModelConsumers(candidate.provider, candidate.model, memo)
          if (modelHasConsumers(consumers)) result.prefiltered += 1
          else unused.push(candidate)
        }
      } catch (err) {
        throw new PruneAbort('prefilter_failed', err)
      }
    }

    for (const candidate of unused) {
      if (result.pruned >= maxPerRun || result.examinedLocked >= 2 * maxPerRun) break
      let outcome: LockedOutcome
      try {
        await hooks.beforeLock?.(candidate)
        result.examinedLocked += 1
        outcome = await withTransaction(
          db =>
            pruneLocked(db, candidate, { consumerSources: deps.consumerSources, graceMs }, hooks),
          txPool
        )
      } catch (err) {
        throw new PruneAbort('locked_phase_failed', err)
      }
      if (outcome === 'pruned') {
        result.pruned += 1
        llmCatalogPrunedModelsTotal.inc()
        log.info(
          {
            event: 'llm_catalog_prune_disabled',
            provider: candidate.provider,
            model: candidate.model,
          },
          'llm catalog prune: disabled a stale catalog model nobody uses'
        )
      }
    }
  } catch (err) {
    result.aborted = true
    result.abortReason = err instanceof PruneAbort ? err.reason : 'locked_phase_failed'
    log.error(
      {
        event: 'llm_catalog_prune_aborted',
        reason: result.abortReason,
        pruned: result.pruned,
        err: safeErrorLogMessage(err instanceof PruneAbort ? err.cause : err),
      },
      'llm catalog prune aborted; models already disabled stay disabled'
    )
  }

  await recordCatalogPruneRun(txPool, run, result)
  llmCatalogPruneRunsTotal.inc({ outcome: result.aborted ? 'aborted' : 'completed' })
  log.info(
    {
      event: 'llm_catalog_prune_run',
      candidates: result.candidates,
      prefiltered: result.prefiltered,
      examinedLocked: result.examinedLocked,
      pruned: result.pruned,
      aborted: result.aborted,
      maxPerRun,
    },
    'llm catalog prune run finished'
  )
  return result
}

/** The production prune: consumers from the gateway's live Host and recipe LISTs. */
export function catalogPruneFromGateway(
  gateway: ConsumerGateway,
  overrides: Omit<CatalogPruneDeps, 'consumerSources'> = {}
): CatalogPrune {
  const namespaces = consumerNamespacesFromConfig()
  return run =>
    pruneStaleCatalogModels(run, {
      ...overrides,
      consumerSources: db => modelConsumerSourcesFromGateway(gateway, namespaces, db),
    })
}

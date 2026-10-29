/**
 * Periodic purge of shared (`context`-scope) mcp-server OAuth grants that no
 * Context enables any more: the Context dropped the server from its allowlist,
 * or the Context is gone. The admin Context routes purge on their own writes;
 * this loop covers every writer they never see (the workflow-recipes
 * controller, kubectl, GitOps, garbage collection of recipe Contexts), a hook
 * that failed, and the rows that predate the hooks.
 *
 * The broker already refuses such a row on every read, because it re-reads the
 * allowlist. What the purge prevents is the row coming back to life without a
 * new consent when the server is enabled again, or a Context is recreated under
 * the same name.
 *
 * Safety rules, each one load-bearing:
 *   - The clock is Postgres' own `now()`, read before listing, so it is the same
 *     clock that stamps `updated_at`; only rows written before it are judged.
 *     A consent or refresh that lands after the snapshot survives until a later
 *     tick can see the allowlist it was written against.
 *   - The Contexts are listed with an explicit namespace, so a failed list
 *     throws instead of reading as "no Contexts" (the cluster-wide list swallows
 *     per-namespace errors). A failed or empty list aborts the tick without
 *     deleting: an apiserver answering `[]` must not wipe every shared grant.
 *   - A Context being deleted counts as gone, as it does for the broker.
 *
 * One replica (`strategy: Recreate`) and idempotent deletes: no advisory lock.
 */
import type { DbClient } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import {
  type DbTimestamp,
  type PurgedSharedGrant,
  deleteSharedGrantsForContextExcept,
  deleteSharedGrantsForMissingContexts,
} from '../oauth/store.js'
import { rootLogger } from '../observability/logger.js'
import { allowlistsOfLiveContexts } from './access/mcpInvocable.js'

export const sharedGrantSweepLogger = rootLogger.child({ service: 'oauth_shared_grant_sweep' })
const log = sharedGrantSweepLogger

export interface SharedGrantSweepDeps {
  gateway: Pick<K8sGateway, 'listResource'>
  db: DbClient
  /** Where the Context CRs live. */
  contextsNamespace: string
  /** What the grant rows are keyed by (the McpServers' namespace). */
  mcpServersNamespace: string
}

export interface SharedGrantSweepSummary {
  outcome: 'completed' | 'aborted' | 'skipped'
  /** Live Contexts the tick judged. */
  contexts: number
  purged: number
  /** Delete statements that failed (logged; the tick went on). */
  failed: number
}

let inFlight = false

/** One sweep tick. Never throws. */
export async function runSharedGrantSweep(
  deps: SharedGrantSweepDeps
): Promise<SharedGrantSweepSummary> {
  if (inFlight) {
    log.debug(
      { event: 'oauth_shared_grant_sweep_skipped' },
      'shared grant sweep skipped: previous tick still running'
    )
    return { outcome: 'skipped', contexts: 0, purged: 0, failed: 0 }
  }
  inFlight = true
  try {
    return await sweepOnce(deps)
  } finally {
    inFlight = false
  }
}

async function sweepOnce(deps: SharedGrantSweepDeps): Promise<SharedGrantSweepSummary> {
  const aborted = { outcome: 'aborted' as const, contexts: 0, purged: 0, failed: 0 }

  let tickStart: DbTimestamp
  let contexts: unknown[]
  try {
    // As text: a JS Date would drop the microseconds `updated_at` is compared at.
    const clock = await deps.db.query('SELECT now()::text AS tick_start')
    tickStart = (clock.rows[0] as { tick_start: string }).tick_start
    contexts = await deps.gateway.listResource('contexts', deps.contextsNamespace)
  } catch (err) {
    log.warn(
      { event: 'oauth_shared_grant_sweep_aborted', err },
      'shared grant sweep aborted before deleting: could not read the clock or the Contexts'
    )
    return aborted
  }
  if (!Array.isArray(contexts) || contexts.length === 0) {
    log.warn(
      { event: 'oauth_shared_grant_sweep_aborted', reason: 'no_contexts_listed' },
      'shared grant sweep aborted before deleting: the Context list came back empty'
    )
    return aborted
  }

  const live = allowlistsOfLiveContexts(contexts)
  let purged = 0
  let failed = 0
  const report = (rows: PurgedSharedGrant[]) => {
    purged += rows.length
    for (const row of rows) {
      log.warn(
        {
          event: 'oauth_shared_grant_purged',
          mcpServerName: row.mcpServerName,
          contextName: row.contextName,
          bootstrappedBy: row.bootstrappedBy,
          source: 'sweep',
        },
        'purged a shared OAuth grant no Context enables'
      )
    }
  }

  for (const [contextName, allowlist] of live) {
    try {
      report(
        await deleteSharedGrantsForContextExcept(deps.db, {
          namespace: deps.mcpServersNamespace,
          contextName,
          keep: [...allowlist],
          updatedBefore: tickStart,
        })
      )
    } catch (err) {
      failed += 1
      log.warn(
        { event: 'oauth_shared_grant_sweep_statement_failed', contextName, err },
        'shared grant sweep could not purge one Context; continuing'
      )
    }
  }
  try {
    report(
      await deleteSharedGrantsForMissingContexts(deps.db, {
        namespace: deps.mcpServersNamespace,
        existing: [...live.keys()],
        updatedBefore: tickStart,
      })
    )
  } catch (err) {
    failed += 1
    log.warn(
      { event: 'oauth_shared_grant_sweep_statement_failed', contextName: null, err },
      'shared grant sweep could not purge the grants of missing Contexts'
    )
  }

  log.info(
    { event: 'oauth_shared_grant_sweep_completed', contexts: live.size, purged, failed },
    'shared grant sweep completed'
  )
  return { outcome: 'completed', contexts: live.size, purged, failed }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startOauthSharedGrantSweepCron(
  deps: SharedGrantSweepDeps,
  intervalMs: number
): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    void runSharedGrantSweep(deps)
  }, intervalMs)
  intervalHandle.unref()
  log.info(
    { event: 'oauth_shared_grant_sweep_started', intervalMs },
    'shared grant sweep cron started'
  )
}

export function stopOauthSharedGrantSweepCron(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

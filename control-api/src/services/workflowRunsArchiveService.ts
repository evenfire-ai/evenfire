/**
 * Workflow-runs archive — DB-first reaper (replaces CRD-era WRC reaper).
 *
 * Source: STAGE-4 DB-first plan (serene-sauteeing-jellyfish.md, Fase 3).
 *
 * Responsibilities:
 *   1. Move terminal rows (Succeeded|Failed|Canceled) from `workflow_runs` to
 *      `workflow_runs_audit` after the row's recipe-defined
 *      `ttl_seconds_after_finished` window. New rows default to the explicit
 *      platform maximum of 30 days; the global grace window is only a fallback
 *      for older/null rows.
 *   2. Cascade-copy `workflow_run_steps` → `workflow_run_step_audit`.
 *   3. Delete the live row (CASCADE removes the step rows too).
 *   4. Best-effort delete of the child `WorkflowRecipe` K8s resource after the
 *      SQL commit succeeds. Failures here do NOT roll back the archive —
 *      orphaned child recipes can be garbage-collected by a separate sweep or
 *      by the TTL on the recipe itself.
 *
 * Concurrency:
 *   - A single cluster-wide `pg_try_advisory_lock(hashtext('workflow-runs-archive-v1'))`
 *     guards the whole sweep so multiple control-api replicas cannot double-work.
 *   - Per-batch `FOR UPDATE SKIP LOCKED` is defense-in-depth (the global lock
 *     already serializes sweeps, but SKIP LOCKED keeps us safe if an operator
 *     runs `archiveTerminalRuns()` manually from a REPL).
 *
 * Schema mapping (CRD-less runs → legacy CRD-era audit schema):
 *   - `run_namespace`, `run_name` are CRD-era fields. Post-CRD, we use
 *     `recipe_namespace` and `run_id::text` as substitutes so audit queries
 *     keep working even though the CRD no longer exists.
 *   - `idempotency_key` is NOT NULL in audit but nullable in workflow_runs →
 *     fall back to `run_id::text` so historical queries by key still resolve.
 *   - `snapshot_sha` is NOT NULL in audit but was only populated by the WRC
 *     reaper → use the sentinel `'db-first'` to mark DB-originated rows.
 */
import { pool } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { rootLogger } from '../observability/logger.js'
import {
  workflowRunsArchiveDurationSeconds,
  workflowRunsArchiveRunsTotal,
  workflowRunsArchivedTotal,
  workflowRunsChildDeleteTotal,
} from '../observability/metrics.js'

const ARCHIVE_LOCK_KEY_SQL = `hashtext('workflow-runs-archive-v1')`

export interface ArchiveOptions {
  /** Fallback grace window (ms) for older/null rows missing per-run TTL. */
  graceMs?: number
  /** Rows per transaction. */
  batchSize?: number
  /** Hard cap on number of batches per sweep (safety rail). */
  maxBatches?: number
}

const DEFAULT_GRACE_MS = 60 * 60 * 1000 // 1h
const DEFAULT_BATCH_SIZE = 500
const DEFAULT_MAX_BATCHES = 100

interface ArchivedChild {
  run_id: string
  child_recipe_name: string | null
  child_recipe_namespace: string | null
}

/**
 * Public entry point. Acquires the global advisory lock, loops batches until
 * drained, and deletes child recipes post-commit.
 *
 * Returns the total number of runs archived this sweep (0 if lock was busy).
 */
export async function archiveTerminalRuns(
  gateway: K8sGateway,
  opts: ArchiveOptions = {}
): Promise<number> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES

  const startHr = process.hrtime.bigint()
  const lockClient = await pool.connect()
  let locked = false
  let total = 0

  try {
    const lockRes = await lockClient.query(
      `SELECT pg_try_advisory_lock(${ARCHIVE_LOCK_KEY_SQL}) AS acquired`
    )
    locked = (lockRes.rows[0] as { acquired: boolean }).acquired === true
    if (!locked) {
      workflowRunsArchiveRunsTotal.inc({ result: 'skipped_lock' }, 1)
      rootLogger.info(
        { event: 'workflow_runs_archive_skipped_lock' },
        'workflow_runs archive skipped: advisory lock held by another replica'
      )
      return 0
    }

    const fallbackGraceSeconds = Math.ceil(graceMs / 1000)
    const childrenToDelete: ArchivedChild[] = []

    for (let i = 0; i < maxBatches; i++) {
      const batch = await archiveOneBatch(lockClient, fallbackGraceSeconds, batchSize)
      total += batch.length
      childrenToDelete.push(...batch)
      if (batch.length === 0) break
    }

    if (total > 0) workflowRunsArchivedTotal.inc(total)
    workflowRunsArchiveRunsTotal.inc({ result: 'ok' }, 1)
    rootLogger.info(
      { event: 'workflow_runs_archive_run', archived: total, fallbackGraceSeconds },
      'workflow_runs archive sweep complete'
    )

    // Best-effort child cleanup AFTER the SQL commit. Each delete is isolated:
    // a failure in one does not abort the rest.
    for (const child of childrenToDelete) {
      if (!child.child_recipe_name || !child.child_recipe_namespace) continue
      await deleteChildRecipe(gateway, child)
    }

    return total
  } catch (err) {
    workflowRunsArchiveRunsTotal.inc({ result: 'error' }, 1)
    rootLogger.error(
      {
        event: 'workflow_runs_archive_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'workflow_runs archive sweep failed'
    )
    throw err
  } finally {
    if (locked) {
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${ARCHIVE_LOCK_KEY_SQL})`)
      } catch (unlockErr) {
        // Release via client.release() below also drops session locks; this is
        // only a fast-path so the lock is free before the next poll cycle.
        rootLogger.warn(
          {
            event: 'workflow_runs_archive_unlock_failed',
            err: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
          },
          'pg_advisory_unlock failed; will be released on client release'
        )
      }
    }
    lockClient.release()
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9
    workflowRunsArchiveDurationSeconds.observe(durationSec)
  }
}

/**
 * One transactional batch: SELECT eligible rows → copy to audit → delete live.
 * Uses the caller's pooled client so the global advisory lock stays alive for
 * the whole sweep.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function archiveOneBatch(
  client: {
    query: (
      sql: string,
      params?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  },
  fallbackGraceSeconds: number,
  batchSize: number
): Promise<ArchivedChild[]> {
  await client.query('BEGIN')
  try {
    const selected = await client.query(
      `SELECT run_id, child_recipe_name, child_recipe_namespace
         FROM workflow_runs
        WHERE phase IN ('Succeeded','Failed','Canceled')
          AND completed_at IS NOT NULL
          AND completed_at < NOW() - (
            COALESCE(ttl_seconds_after_finished, $1)::int * interval '1 second'
          )
        ORDER BY completed_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [fallbackGraceSeconds, batchSize]
    )
    if ((selected.rowCount ?? 0) === 0) {
      await client.query('COMMIT')
      return []
    }

    const children = selected.rows as ArchivedChild[]
    const ids = children.map(r => r.run_id)

    // Copy runs → workflow_runs_audit. Field mapping documented at module top.
    await client.query(
      `INSERT INTO workflow_runs_audit (
       run_id, run_namespace, run_name, recipe_namespace, recipe_name,
         triggerer_team_id, usage_team_id, triggerer_user_id, triggerer_admin_user_id,
         triggerer_actor_type, triggerer_host_ref,
         trigger_source, idempotency_key, triggered_at, started_at,
         completed_at, duration_ms, final_phase, step_count,
         error_message, output_summary, snapshot_sha,
         template_ref, template_sha, reaped_at
       )
       SELECT
         wr.run_id,
         wr.recipe_namespace AS run_namespace,
         wr.run_id::text       AS run_name,
         wr.recipe_namespace,
         wr.recipe_name,
         wr.team_id,
         wr.usage_team_id,
         CASE
           WHEN wr.actor_type = 'user'
            AND EXISTS (SELECT 1 FROM users WHERE id = wr.actor_id)
           THEN wr.actor_id
           ELSE NULL
         END AS triggerer_user_id,
         CASE
           WHEN wr.actor_type = 'admin' THEN wr.actor_id
           ELSE NULL
         END AS triggerer_admin_user_id,
         wr.actor_type,
         NULL::text AS triggerer_host_ref,
         CASE
           WHEN wr.trigger_source IN ('schedule','autonomous') THEN wr.trigger_source
           ELSE 'onDemand'
         END AS trigger_source,
         COALESCE(wr.idempotency_key, wr.run_id::text),
         wr.created_at       AS triggered_at,
         wr.started_at,
         wr.completed_at,
         CASE
           WHEN wr.started_at IS NOT NULL AND wr.completed_at IS NOT NULL
           THEN (EXTRACT(EPOCH FROM (wr.completed_at - wr.started_at)) * 1000)::bigint
           ELSE NULL
         END AS duration_ms,
         wr.phase            AS final_phase,
         COALESCE(
           (SELECT COUNT(*)::int FROM workflow_run_steps WHERE run_id = wr.run_id),
           0
         )                   AS step_count,
         NULL::text          AS error_message,
         NULL::jsonb         AS output_summary,
         'db-first'          AS snapshot_sha,
         NULL::text          AS template_ref,
         NULL::text          AS template_sha,
         NOW()               AS reaped_at
       FROM workflow_runs wr
       WHERE wr.run_id = ANY($1::uuid[])
       ON CONFLICT (run_id) DO NOTHING`,
      [ids]
    )

    // Copy step rows. Non-terminal step phases are clamped to 'Canceled' to
    // satisfy the audit CHECK constraint (Succeeded|Failed|Skipped|Canceled).
    await client.query(
      `INSERT INTO workflow_run_step_audit (
         run_id, step_id, step_phase, started_at, completed_at, duration_ms,
         tools_called, output_files, approval_request_id, error_message
       )
       SELECT
         run_id,
         step_id,
         CASE
           WHEN phase IN ('Succeeded','Failed','Skipped','Canceled') THEN phase
           ELSE 'Canceled'
         END AS step_phase,
         started_at,
         completed_at,
         CASE
           WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
           THEN (EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::bigint
           ELSE NULL
         END AS duration_ms,
         CASE
           WHEN tools_called IS NULL THEN '{}'::text[]
           WHEN jsonb_typeof(tools_called) = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(tools_called))
           ELSE '{}'::text[]
         END AS tools_called,
         '{}'::text[] AS output_files,
         NULL::uuid   AS approval_request_id,
         error        AS error_message
       FROM workflow_run_steps
       WHERE run_id = ANY($1::uuid[])
       ON CONFLICT (run_id, step_id) DO NOTHING`,
      [ids]
    )

    // DELETE cascades to workflow_run_steps via FK ON DELETE CASCADE.
    await client.query(`DELETE FROM workflow_runs WHERE run_id = ANY($1::uuid[])`, [ids])

    await client.query('COMMIT')
    return children
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * Best-effort child recipe deletion. NotFound is treated as success because
 * the child may have been deleted independently (e.g. by a prior sweep that
 * committed the SQL but crashed before the K8s call).
 */
async function deleteChildRecipe(gateway: K8sGateway, child: ArchivedChild): Promise<void> {
  if (!child.child_recipe_name || !child.child_recipe_namespace) return
  try {
    await gateway.deleteResource(
      'workflowrecipes',
      child.child_recipe_name,
      child.child_recipe_namespace
    )
    workflowRunsChildDeleteTotal.inc({ result: 'ok' }, 1)
  } catch (err) {
    const status = extractK8sStatus(err)
    if (status === 404) {
      workflowRunsChildDeleteTotal.inc({ result: 'not_found' }, 1)
      return
    }
    workflowRunsChildDeleteTotal.inc({ result: 'error' }, 1)
    rootLogger.warn(
      {
        event: 'workflow_runs_archive_child_delete_failed',
        runId: child.run_id,
        child: `${child.child_recipe_namespace}/${child.child_recipe_name}`,
        err: err instanceof Error ? err.message : String(err),
      },
      'child WorkflowRecipe delete failed; will be retried on next sweep if row re-appears'
    )
  }
}

function extractK8sStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    response?: { statusCode?: number; status?: number }
    code?: number
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number')
    return maybe.response.statusCode
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return null
}

/** Test/ops helper: number of eligible rows without moving them. */
export async function countArchiveCandidates(graceMs = DEFAULT_GRACE_MS): Promise<number> {
  const fallbackGraceSeconds = Math.ceil(graceMs / 1000)
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM workflow_runs
      WHERE phase IN ('Succeeded','Failed','Canceled')
        AND completed_at IS NOT NULL
        AND completed_at < NOW() - (
          COALESCE(ttl_seconds_after_finished, $1)::int * interval '1 second'
        )`,
    [fallbackGraceSeconds]
  )
  return (result.rows[0] as { count: number }).count
}

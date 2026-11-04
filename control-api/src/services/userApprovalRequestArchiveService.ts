import { pool, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  approvalsArchiveDurationSeconds,
  approvalsArchiveRunsTotal,
  approvalsArchivedTotal,
} from '../observability/metrics.js'

/**
 * Archive terminal approval rows older than `olderThanDays` (default 180).
 *
 * Scope:
 *   - Only rows in terminal states (approved, denied, expired, cancelled,
 *     consumed) are eligible — pending rows are never archived.
 *   - "Terminal timestamp" is `COALESCE(decided_at, cancelled_at, requested_at)`:
 *     decided_at covers approve/deny/expired (via lazy expiry), cancelled_at
 *     covers cancelled, and requested_at is the fallback for legacy rows
 *     created before the audit columns existed.
 *
 * Process:
 *   - Runs in batches of `batchSize` (default 500) inside a transaction so
 *     insert+delete are atomic. On crash mid-batch, the whole batch rolls back
 *     and will be retried next run.
 *   - Loops until a batch returns 0 rows (drained).
 *
 * Returns the total number of rows archived.
 */
export async function archiveTerminalApprovals(
  olderThanDays = 180,
  batchSize = 500
): Promise<number> {
  const startHr = process.hrtime.bigint()
  let total = 0

  try {
    // Loop until we drain the eligible set. A single call could archive an
    // unbounded number of rows on first run after deploy; batching keeps
    // transaction size + lock footprint predictable.
    // Safety bound: 100 batches = 50k rows per cron run. Everything beyond
    // that waits until tomorrow to avoid holding locks for minutes.
    for (let i = 0; i < 100; i++) {
      const archived = await archiveOneBatch(olderThanDays, batchSize)
      total += archived
      if (archived === 0) break
    }

    if (total > 0) {
      approvalsArchivedTotal.inc(total)
    }
    approvalsArchiveRunsTotal.inc({ result: 'ok' }, 1)
    rootLogger.info(
      { event: 'approvals_archive_run', archived: total, olderThanDays },
      'archive sweep complete'
    )
    return total
  } catch (err) {
    approvalsArchiveRunsTotal.inc({ result: 'error' }, 1)
    rootLogger.error(
      {
        event: 'approvals_archive_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'archive sweep failed'
    )
    throw err
  } finally {
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9
    approvalsArchiveDurationSeconds.observe(durationSec)
  }
}

async function archiveOneBatch(olderThanDays: number, batchSize: number): Promise<number> {
  return withTransaction(async db => {
    // Select ids of archive-eligible rows FOR UPDATE so a concurrent
    // archive/cron cannot double-move the same rows.
    const selected = await db.query(
      `SELECT id FROM workflow_approval_requests
        WHERE status IN ('approved','denied','expired','cancelled','consumed')
          AND COALESCE(decided_at, cancelled_at, requested_at) < NOW() - ($1::int * interval '1 day')
        ORDER BY COALESCE(decided_at, cancelled_at, requested_at) ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [olderThanDays, batchSize]
    )

    if ((selected.rowCount ?? 0) === 0) return 0

    const ids = selected.rows.map(r => (r as { id: string }).id)

    // Copy into archive. Schema columns mirror workflow_approval_requests
    // plus archived_at (defaulted to NOW() in DDL). Use ON CONFLICT DO NOTHING
    // so a retry after partial failure is idempotent on PK collisions.
    await db.query(
      `INSERT INTO workflow_approval_requests_archive (
         id, recipe_namespace, recipe_name, requested_at, expires_at, status,
         target_user_id, target_team_id, payload, decision_maker, idempotency_key,
         correlation, payload_hash, decided_at, decided_by_user_id,
         cancelled_at, cancelled_by, client_ip, user_agent
       )
       SELECT id, recipe_namespace, recipe_name, requested_at, expires_at, status,
              target_user_id, target_team_id, payload, decision_maker, idempotency_key,
              correlation, payload_hash, decided_at, decided_by_user_id,
              cancelled_at, cancelled_by, client_ip, user_agent
         FROM workflow_approval_requests
        WHERE id = ANY($1::uuid[])
       ON CONFLICT (id) DO NOTHING`,
      [ids]
    )

    await db.query(
      `INSERT INTO workflow_approval_trigger_intents_archive (
         approval_request_id,
         trigger_namespace,
         trigger_name,
         trigger_caller_key,
         created_at
       )
       SELECT approval_request_id,
              trigger_namespace,
              trigger_name,
              trigger_caller_key,
              created_at
         FROM workflow_approval_trigger_intents
        WHERE approval_request_id = ANY($1::uuid[])
       ON CONFLICT (approval_request_id) DO NOTHING`,
      [ids]
    )

    await db.query(
      `INSERT INTO workflow_approval_trigger_run_intents_archive (
         approval_request_id,
         actor_type,
         actor_id,
         team_id,
         usage_team_id,
         trigger_source,
         idempotency_key,
         inputs,
         intermediate_parameters,
         output_overrides,
         max_duration_seconds,
         ttl_seconds_after_finished,
         idempotency_payload_hash,
         created_at
       )
       SELECT approval_request_id,
              actor_type,
              actor_id,
              team_id,
              usage_team_id,
              trigger_source,
              idempotency_key,
              inputs,
              intermediate_parameters,
              output_overrides,
              max_duration_seconds,
              ttl_seconds_after_finished,
              idempotency_payload_hash,
              created_at
         FROM workflow_approval_trigger_run_intents
        WHERE approval_request_id = ANY($1::uuid[])
       ON CONFLICT (approval_request_id) DO NOTHING`,
      [ids]
    )

    const deleted = await db.query(
      `DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])`,
      [ids]
    )

    return deleted.rowCount ?? 0
  })
}

/**
 * Test/ops helper: counts archive-eligible rows without moving them.
 */
export async function countArchiveCandidates(olderThanDays = 180): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM workflow_approval_requests
      WHERE status IN ('approved','denied','expired','cancelled','consumed')
        AND COALESCE(decided_at, cancelled_at, requested_at) < NOW() - ($1::int * interval '1 day')`,
    [olderThanDays]
  )
  return (result.rows[0] as { count: number }).count
}

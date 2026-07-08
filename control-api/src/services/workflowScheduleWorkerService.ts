/**
 * Workflow schedule worker — DB-backed scheduler (replaces K8s CronJobs).
 *
 * Source: STAGE-4 DB-first plan (serene-sauteeing-jellyfish.md, Fase 5).
 *
 * Responsibilities:
 *   1. Acquire a cluster-wide advisory lock on hashtext('wrc-schedule-worker-v1')
 *      so only ONE control-api replica fires schedules at a time.
 *   2. Drain matured rows from `workflow_schedules` (`enabled = true AND next_fire_at <= now()`),
 *      using `FOR UPDATE SKIP LOCKED` as defense-in-depth against manual re-entry.
 *   3. For each matured row:
 *        a. Insert a workflow_runs row via workflowRunService.createRun()
 *           with actor_type='scheduled' and a deterministic idempotency_key
 *           so double-firing the same window is a no-op.
 *        b. Advance `next_fire_at` using cron-parser to the next matching time
 *           AFTER the current next_fire_at (not now() — keeps cadence precise
 *           when the worker is a few hundred ms late).
 *        c. Stamp `last_fire_at = now()` and bump `updated_at = now()`.
 *   4. Commit the transaction.
 *
 * Why this replaces CronJobs (ADR-001 motivation):
 *   K8s CronJobs incur a Pod per fire (≈50MB RAM + container startup) just to
 *   issue a single HTTP POST. With this worker, firing N schedules/day costs
 *   zero kubelet/etcd ops — everything is a Postgres transaction.
 *
 * Idempotency:
 *   Each fire uses `idempotency_key = 'schedule/<schedule_id>/<next_fire_at ISO>'`.
 *   The unique index `idx_wr_idempotency (recipe_namespace, recipe_name, idempotency_key)`
 *   converts a double-fire (same schedule, same window) into a silent ON CONFLICT DO NOTHING.
 *   The existing workflow_runs row is returned and the schedule still advances.
 */
import { CronExpressionParser } from 'cron-parser'
import type { DbClient } from '../db.js'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  workflowScheduleWorkerDurationSeconds,
  workflowScheduleWorkerFiresTotal,
  workflowScheduleWorkerRunsTotal,
} from '../observability/metrics.js'
import { createRun } from './workflowRunService.js'

const SCHEDULE_WORKER_LOCK_KEY_SQL = `hashtext('wrc-schedule-worker-v1')`

export interface ScheduleWorkerOptions {
  /** Max rows drained per sweep (safety rail against runaway schedules). */
  batchSize?: number
}

const DEFAULT_BATCH_SIZE = 50

type TriggerAllowedActor = 'user' | 'autonomous' | 'scheduled'

interface ScheduleRow {
  schedule_id: string
  recipe_namespace: string
  recipe_name: string
  team_id: string | null
  cron_expression: string
  timezone: string
  next_fire_at: Date
  input_template: Record<string, unknown> | null
  /**
   * Denormalized copy of `spec.triggers.onDemand.allowedActors` written by the
   * WRC schedule sync. `null` = no restriction. When the list is non-empty and
   * does NOT include `'scheduled'`, the worker must refuse to fire (matches
   * the gate already enforced on the admin /trigger endpoint).
   */
  allowed_actors: TriggerAllowedActor[] | null
  /**
   * Denormalized copy of `spec.runRetention.maxRunDurationSeconds` written by
   * the WRC schedule sync. NULL means no timeout; any positive integer must be
   * copied onto the workflow_runs row so stuck-run enforcement can function.
   */
  max_duration_seconds: number | null
  /**
   * Denormalized copy of `spec.runRetention.ttlSecondsAfterFinished` written by
   * the WRC schedule sync. NULL means the archive cron's global grace applies.
   */
  ttl_seconds_after_finished: number | null
}

export interface ScheduleFireResult {
  scheduleId: string
  runId: string | null
  fired: boolean
  reason: 'ok' | 'error' | 'invalid_cron' | 'actor_not_allowed'
  error?: string
}

export interface ScheduleWorkerSweepResult {
  fired: number
  actorNotAllowed: number
  skippedLock: boolean
  errors: number
}

/**
 * Public entry point. Acquires the advisory lock, drains matured schedules,
 * and commits. Returns a small summary for logging/tests.
 */
export async function processMaturedSchedules(
  opts: ScheduleWorkerOptions = {}
): Promise<ScheduleWorkerSweepResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const startHr = process.hrtime.bigint()
  const lockClient = await pool.connect()
  let locked = false
  const summary: ScheduleWorkerSweepResult = {
    fired: 0,
    actorNotAllowed: 0,
    skippedLock: false,
    errors: 0,
  }

  try {
    const lockRes = await lockClient.query(
      `SELECT pg_try_advisory_lock(${SCHEDULE_WORKER_LOCK_KEY_SQL}) AS acquired`
    )
    locked = (lockRes.rows[0] as { acquired: boolean }).acquired === true
    if (!locked) {
      summary.skippedLock = true
      workflowScheduleWorkerRunsTotal.inc({ result: 'skipped_lock' }, 1)
      rootLogger.debug(
        { event: 'workflow_schedule_worker_skipped_lock' },
        'schedule worker skipped: advisory lock held by another replica'
      )
      return summary
    }

    const results = await fireOneBatch(lockClient, batchSize)
    for (const r of results) {
      if (r.fired) {
        summary.fired += 1
        workflowScheduleWorkerFiresTotal.inc({ result: 'ok' }, 1)
      } else if (r.reason === 'actor_not_allowed') {
        // Policy-driven skip — expected when `allowedActors` excludes
        // 'scheduled'. Don't inflate the error counter; emit a distinct label
        // so dashboards can surface silenced schedules.
        summary.actorNotAllowed += 1
        workflowScheduleWorkerFiresTotal.inc({ result: 'actor_not_allowed' }, 1)
      } else {
        summary.errors += 1
        workflowScheduleWorkerFiresTotal.inc({ result: 'error' }, 1)
      }
    }

    workflowScheduleWorkerRunsTotal.inc({ result: 'ok' }, 1)
    if (summary.fired > 0 || summary.errors > 0) {
      rootLogger.info(
        {
          event: 'workflow_schedule_worker_run',
          fired: summary.fired,
          errors: summary.errors,
        },
        'schedule worker sweep complete'
      )
    }
    return summary
  } catch (err) {
    workflowScheduleWorkerRunsTotal.inc({ result: 'error' }, 1)
    rootLogger.error(
      {
        event: 'workflow_schedule_worker_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'schedule worker sweep failed'
    )
    throw err
  } finally {
    if (locked) {
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${SCHEDULE_WORKER_LOCK_KEY_SQL})`)
      } catch (unlockErr) {
        rootLogger.warn(
          {
            event: 'workflow_schedule_worker_unlock_failed',
            err: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
          },
          'pg_advisory_unlock failed; will be released on client release'
        )
      }
    }
    lockClient.release()
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9
    workflowScheduleWorkerDurationSeconds.observe(durationSec)
  }
}

/**
 * Drain and fire a single batch of matured schedules inside ONE transaction so
 * `FOR UPDATE SKIP LOCKED` actually holds row-level locks for the duration of
 * the batch (in autocommit mode the locks would be released immediately after
 * the SELECT, defeating the concurrency guard). `fireOneSchedule` never throws
 * — malformed cron expressions or insert errors surface as
 * `{fired:false, reason:'invalid_cron'|'error'}` — so committing at the end is
 * safe. A catastrophic DB error (lost connection, deadlock on COMMIT) triggers
 * a best-effort ROLLBACK before re-raising.
 */
async function fireOneBatch(client: DbClient, batchSize: number): Promise<ScheduleFireResult[]> {
  await client.query('BEGIN')
  try {
    const selected = await client.query(
      `SELECT schedule_id, recipe_namespace, recipe_name, team_id,
              cron_expression, timezone, next_fire_at, input_template,
              allowed_actors, max_duration_seconds, ttl_seconds_after_finished
         FROM workflow_schedules
        WHERE enabled = TRUE
          AND next_fire_at <= now()
        ORDER BY next_fire_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize]
    )

    if ((selected.rowCount ?? 0) === 0) {
      await client.query('COMMIT')
      return []
    }

    const rows = selected.rows as ScheduleRow[]
    const results: ScheduleFireResult[] = []
    for (const row of rows) {
      results.push(await fireOneSchedule(client, row))
    }
    await client.query('COMMIT')
    return results
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* swallow — connection likely already broken */
    }
    throw err
  }
}

/**
 * Fire a single schedule: insert workflow_runs row + advance next_fire_at.
 * Must run with the caller holding the row lock from the enclosing SELECT.
 */
async function fireOneSchedule(client: DbClient, row: ScheduleRow): Promise<ScheduleFireResult> {
  // Compute next_fire_at FIRST so a cron parse failure doesn't create a run.
  const currentFire =
    row.next_fire_at instanceof Date ? row.next_fire_at : new Date(row.next_fire_at)

  let nextFire: Date
  try {
    nextFire = computeNextFire(row.cron_expression, row.timezone, currentFire)
  } catch (err) {
    // Disable the schedule so it stops clogging the poll loop until an operator
    // fixes the cron expression. next_fire_at stays as-is for visibility.
    await client.query(
      `UPDATE workflow_schedules
         SET enabled = FALSE, updated_at = now()
       WHERE schedule_id = $1`,
      [row.schedule_id]
    )
    rootLogger.error(
      {
        event: 'workflow_schedule_worker_invalid_cron',
        scheduleId: row.schedule_id,
        recipe: `${row.recipe_namespace}/${row.recipe_name}`,
        cron: row.cron_expression,
        err: err instanceof Error ? err.message : String(err),
      },
      'schedule disabled: invalid cron expression'
    )
    return {
      scheduleId: row.schedule_id,
      runId: null,
      fired: false,
      reason: 'invalid_cron',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Enforce the denormalized actor allow-list before spending any INSERT work.
  // A non-empty list that excludes 'scheduled' means the operator explicitly
  // scoped triggers to interactive / autonomous actors; firing anyway would
  // bypass the same gate the admin /trigger endpoint enforces. Advance
  // next_fire_at so the schedule doesn't re-queue the same window forever —
  // the CRD author can remove the restriction to resume without an operator
  // having to unstick the row.
  if (
    Array.isArray(row.allowed_actors) &&
    row.allowed_actors.length > 0 &&
    !row.allowed_actors.includes('scheduled')
  ) {
    await client.query(
      `UPDATE workflow_schedules
         SET next_fire_at = $1,
             updated_at   = now()
       WHERE schedule_id = $2`,
      [nextFire, row.schedule_id]
    )
    rootLogger.warn(
      {
        event: 'workflow_schedule_worker_actor_not_allowed',
        scheduleId: row.schedule_id,
        recipe: `${row.recipe_namespace}/${row.recipe_name}`,
        allowedActors: row.allowed_actors,
      },
      'schedule skipped: allowedActors does not permit scheduled triggers'
    )
    return {
      scheduleId: row.schedule_id,
      runId: null,
      fired: false,
      reason: 'actor_not_allowed',
    }
  }

  const idempotencyKey = `schedule/${row.schedule_id}/${currentFire.toISOString()}`

  try {
    const { row: runRow } = await createRun(
      {
        recipe_namespace: row.recipe_namespace,
        recipe_name: row.recipe_name,
        actor_type: 'scheduled',
        team_id: row.team_id ?? null,
        usage_team_id: row.team_id ?? null,
        actor_id: null,
        idempotency_key: idempotencyKey,
        trigger_source: 'schedule',
        inputs: row.input_template ?? null,
        max_duration_seconds: row.max_duration_seconds,
        ttl_seconds_after_finished: row.ttl_seconds_after_finished,
      },
      client
    )

    await client.query(
      `UPDATE workflow_schedules
         SET next_fire_at = $1,
             last_fire_at = now(),
             updated_at   = now()
       WHERE schedule_id = $2`,
      [nextFire, row.schedule_id]
    )

    return {
      scheduleId: row.schedule_id,
      runId: runRow.run_id,
      fired: true,
      reason: 'ok',
    }
  } catch (err) {
    // Preserve the current window for retry. Advancing here would silently
    // drop one scheduled execution whenever createRun() fails transiently.
    rootLogger.error(
      {
        event: 'workflow_schedule_worker_fire_failed',
        scheduleId: row.schedule_id,
        recipe: `${row.recipe_namespace}/${row.recipe_name}`,
        err: err instanceof Error ? err.message : String(err),
      },
      'schedule fire failed; keeping next_fire_at unchanged for retry'
    )
    return {
      scheduleId: row.schedule_id,
      runId: null,
      fired: false,
      reason: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Compute the next fire time AFTER `from`. Exported for unit-test precision —
 * the worker tests assert the cadence math rather than re-parsing cron strings.
 */
export function computeNextFire(cronExpression: string, timezone: string, from: Date): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone || 'UTC',
  })
  return interval.next().toDate()
}

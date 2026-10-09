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
 *        0. Apply the policy gates in order: `allowed_actors`, then
 *           `concurrency_policy` (see "Concurrency policy" below). A gated tick
 *           advances `next_fire_at` without creating a run.
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
 *
 * Concurrency policy (`workflow_schedules.concurrency_policy`, mirrored by the
 * WRC from `spec.triggers.schedule.concurrencyPolicy`; CRD default `Forbid`):
 *   • Forbid: a matured tick is skipped while a LIVE non-terminal run of the
 *     same recipe exists, whatever its trigger source. Live means
 *       - `Pending` created less than FORBID_PENDING_ACTIVE_BOUND_SECONDS ago, or
 *       - `Running` started less than
 *         min(max_duration_seconds ?? cap, cap) + FORBID_RUNNING_GRACE_SECONDS
 *         ago, with cap = FORBID_RUNNING_MAX_DURATION_CAP_SECONDS.
 *     Nothing terminalises a `Pending` row whose child CR never got created,
 *     and the WRC only reaps `Running` rows that carry max_duration_seconds, so
 *     without these bounds one stuck row would block the schedule forever.
 *     Past the bound the row no longer blocks (a liveness escape hatch: a stuck
 *     but unreaped run can then overlap one new run).
 *     The skip is recorded (result reason `concurrency_forbidden`, metric
 *     label, info log with the blocking run id and age) and `next_fire_at`
 *     advances to the first window after max(next_fire_at, now), so skipped
 *     windows are dropped, never replayed as a burst. After
 *     FORBID_SUSTAINED_SKIP_THRESHOLD consecutive skips of one schedule a warn
 *     log and a counter fire once per streak (in-memory, see
 *     `forbiddenSkipStreaks`). A NULL / unknown policy is treated as Forbid.
 *   • Allow: no check; runs may overlap (the pre-existing behaviour).
 *   • Replace: NOT implemented. It behaves exactly like Allow.
 *   Consistency: the active-run check and the run INSERT execute on the same
 *   client inside the batch transaction, while this session holds the
 *   cluster-wide advisory lock and the schedule row is locked FOR UPDATE, so
 *   two replicas cannot both pass the check for one schedule. Other trigger
 *   paths (on-demand, autonomous) do not take this lock: a run they commit
 *   after the check is not seen. Forbid gates scheduled fires only.
 */
import { CronExpressionParser } from 'cron-parser'
import type { DbClient } from '../db.js'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  workflowScheduleWorkerConcurrencyForbiddenSustainedTotal,
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

/** Mirrors `spec.triggers.schedule.concurrencyPolicy`; CHECK-constrained in the DB. */
type ScheduleConcurrencyPolicy = 'Forbid' | 'Replace' | 'Allow'

/**
 * A `Pending` run blocks a Forbid schedule only while it is younger than this.
 * The WRC claims Pending rows on NOTIFY and re-polls orphans every
 * `WRC_RUN_POLL_MS` (30 s default, workflow-recipes/src/config.ts), reclaiming
 * rows idle for 1 min (dbRunProcessor FIND_ORPHAN_RUNS). 15 min is ~30 poll
 * cycles, far beyond a healthy claim, yet lets a five-minute schedule
 * recover within three windows when createChildRecipe keeps failing and
 * nothing ever moves the row out of Pending.
 */
export const FORBID_PENDING_ACTIVE_BOUND_SECONDS = 15 * 60

/**
 * Ceiling on a `Running` run's own max_duration_seconds, and the value used
 * when it is NULL. Equals the WRC's hard limit on
 * `spec.runRetention.maxRunDurationSeconds` (workflow-recipes/src/config.ts
 * DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS, enforced in workflowLimits.ts;
 * the env override can only lower it). The CRD default (604800) is above it,
 * hence the clamp.
 */
export const FORBID_RUNNING_MAX_DURATION_CAP_SECONDS = 24 * 60 * 60

/**
 * Slack after a `Running` run's deadline before it stops blocking. The WRC
 * reaper (checkStuckRuns) runs every WRC_RUN_POLL_MS and only fails runs owned
 * by its own instance, so a run whose owner died must first be reclaimed by
 * the 1-min orphan sweep. 5 min = 10 poll cycles covers that handover.
 */
export const FORBID_RUNNING_GRACE_SECONDS = 5 * 60

/** Consecutive Forbid skips of one schedule before a warn log + counter fire. */
export const FORBID_SUSTAINED_SKIP_THRESHOLD = 6

/** A live non-terminal run (see the CHECK on `workflow_runs.phase`). */
interface ActiveRecipeRun {
  run_id: string
  phase: 'Pending' | 'Running'
  created_at: Date
  started_at: Date | null
}

/**
 * Consecutive Forbid skips per schedule_id, for the sustained-skip warning.
 * In-memory and per replica by design: the count restarts when the advisory
 * lock moves to another replica or the process restarts, so a warning can be
 * delayed by up to FORBID_SUSTAINED_SKIP_THRESHOLD ticks after a failover,
 * never duplicated. `expectedFireAt` is the next_fire_at this replica wrote
 * with its last skip; if the row arrives with any other slot (another replica
 * fired or skipped it, or the batch rolled back) the streak restarts at 1.
 * Only a fire deletes an entry; a schedule skipped and then deleted, disabled
 * or actor-gated keeps its entry until restart. The map is therefore bounded
 * by the number of schedules.
 */
const forbiddenSkipStreaks = new Map<string, { count: number; expectedFireAt: string }>()

/** Test-only: forget every streak so cases do not leak into each other. */
export function resetConcurrencyForbiddenStreaksForTests(): void {
  forbiddenSkipStreaks.clear()
}

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
  /**
   * Denormalized copy of `spec.triggers.schedule.concurrencyPolicy` written by
   * the WRC schedule sync (column default 'Forbid'). NULL / unknown values are
   * treated as 'Forbid', the CRD default.
   */
  concurrency_policy: ScheduleConcurrencyPolicy | null
}

export interface ScheduleFireResult {
  scheduleId: string
  runId: string | null
  fired: boolean
  reason: 'ok' | 'error' | 'invalid_cron' | 'actor_not_allowed' | 'concurrency_forbidden'
  /** Set when `reason === 'concurrency_forbidden'`: the run that blocked the tick. */
  activeRunId?: string
  error?: string
}

export interface ScheduleWorkerSweepResult {
  fired: number
  actorNotAllowed: number
  /** Ticks skipped because `concurrency_policy = 'Forbid'` and a live run existed. */
  concurrencyForbidden: number
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
    concurrencyForbidden: 0,
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
      } else if (r.reason === 'concurrency_forbidden') {
        // Policy-driven skip — expected under `Forbid` while a run is live.
        // Not an error; a distinct label keeps it visible on dashboards.
        summary.concurrencyForbidden += 1
        workflowScheduleWorkerFiresTotal.inc({ result: 'concurrency_forbidden' }, 1)
      } else {
        summary.errors += 1
        workflowScheduleWorkerFiresTotal.inc({ result: 'error' }, 1)
      }
    }

    workflowScheduleWorkerRunsTotal.inc({ result: 'ok' }, 1)
    // Skip-only sweeps are logged too: a schedule silenced by a policy gate
    // must not look like an idle worker.
    if (
      summary.fired > 0 ||
      summary.errors > 0 ||
      summary.actorNotAllowed > 0 ||
      summary.concurrencyForbidden > 0
    ) {
      rootLogger.info(
        {
          event: 'workflow_schedule_worker_run',
          fired: summary.fired,
          errors: summary.errors,
          actorNotAllowed: summary.actorNotAllowed,
          concurrencyForbidden: summary.concurrencyForbidden,
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
 * the SELECT, defeating the concurrency guard). `fireOneSchedule` surfaces
 * malformed cron expressions and insert errors as
 * `{fired:false, reason:'invalid_cron'|'error'}`, so committing at the end is
 * safe. Exceptions: the concurrency-policy active-run lookup and the Forbid
 * skip's own `UPDATE workflow_schedules` propagate their errors, so the batch
 * rolls back and no run is created without the check. A DB-level `createRun`
 * failure aborts the transaction (the final COMMIT becomes a ROLLBACK), and
 * the next Forbid lookup in the batch throws "current transaction is aborted",
 * so the sweep surfaces as an error. A catastrophic DB error (lost connection, deadlock on
 * COMMIT) also triggers a best-effort ROLLBACK before re-raising.
 */
async function fireOneBatch(client: DbClient, batchSize: number): Promise<ScheduleFireResult[]> {
  await client.query('BEGIN')
  try {
    const selected = await client.query(
      `SELECT schedule_id, recipe_namespace, recipe_name, team_id,
              cron_expression, timezone, next_fire_at, input_template,
              allowed_actors, max_duration_seconds, ttl_seconds_after_finished,
              concurrency_policy
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
 * Gate order: cron parse → allowed_actors → concurrency_policy → createRun.
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

  // concurrencyPolicy gate. Runs on the batch client inside the transaction
  // that holds the advisory lock and the schedule row lock, so the check and
  // the createRun() below are consistent across control-api replicas. Only
  // Forbid checks; Allow and the unimplemented Replace fire unconditionally.
  if (resolveConcurrencyPolicy(row.concurrency_policy) === 'Forbid') {
    const activeRun = await findActiveRunForRecipe(client, row.recipe_namespace, row.recipe_name)
    if (activeRun) {
      return skipForbiddenTick(client, row, currentFire, activeRun)
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
    forbiddenSkipStreaks.delete(row.schedule_id)

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

function resolveConcurrencyPolicy(value: unknown): ScheduleConcurrencyPolicy {
  return value === 'Allow' || value === 'Replace' ? value : 'Forbid'
}

/**
 * Oldest LIVE non-terminal run of the recipe, or null. Scheduled and on-demand
 * runs are both stamped with the recipe's own (namespace, name); the run-scoped
 * child CR lives in `child_recipe_name`, so this matches every run of the
 * recipe regardless of trigger source. "Live" applies the stale-run bounds
 * documented in the header (Pending by age, Running by deadline + grace). A
 * query error propagates so the batch rolls back and no run is created
 * without the check (fail closed). Exported for the real-Postgres lane
 * (`services.workflowScheduleForbid.realPostgres.integration.test.ts`).
 */
export async function findActiveRunForRecipe(
  client: DbClient,
  recipeNamespace: string,
  recipeName: string
): Promise<ActiveRecipeRun | null> {
  const result = await client.query(
    `SELECT run_id, phase, created_at, started_at
       FROM workflow_runs
      WHERE recipe_namespace = $1
        AND recipe_name = $2
        AND (
              (phase = 'Pending'
                AND created_at > now() - make_interval(secs => $3))
           OR (phase = 'Running'
                AND COALESCE(started_at, created_at) > now() - make_interval(secs => LEAST(COALESCE(max_duration_seconds, $4), $4) + $5))
            )
      ORDER BY created_at ASC
      LIMIT 1`,
    [
      recipeNamespace,
      recipeName,
      FORBID_PENDING_ACTIVE_BOUND_SECONDS,
      FORBID_RUNNING_MAX_DURATION_CAP_SECONDS,
      FORBID_RUNNING_GRACE_SECONDS,
    ]
  )
  return (result.rows[0] as ActiveRecipeRun | undefined) ?? null
}

/**
 * Record a Forbid skip: advance to the first window after max(current slot,
 * now) so a backlog accumulated while the run was live is dropped, never
 * replayed; log the blocking run and its age; track the consecutive-skip
 * streak and warn once when it reaches FORBID_SUSTAINED_SKIP_THRESHOLD.
 */
async function skipForbiddenTick(
  client: DbClient,
  row: ScheduleRow,
  currentFire: Date,
  activeRun: ActiveRecipeRun
): Promise<ScheduleFireResult> {
  const now = Date.now()
  const skipNextFire = computeNextFire(
    row.cron_expression,
    row.timezone,
    new Date(Math.max(currentFire.getTime(), now))
  )
  await client.query(
    `UPDATE workflow_schedules
       SET next_fire_at = $1,
           updated_at   = now()
     WHERE schedule_id = $2`,
    [skipNextFire, row.schedule_id]
  )

  const previous = forbiddenSkipStreaks.get(row.schedule_id)
  const consecutiveSkips =
    previous && previous.expectedFireAt === currentFire.toISOString() ? previous.count + 1 : 1
  forbiddenSkipStreaks.set(row.schedule_id, {
    count: consecutiveSkips,
    expectedFireAt: skipNextFire.toISOString(),
  })

  const activeSince = new Date(activeRun.started_at ?? activeRun.created_at)
  const fields = {
    scheduleId: row.schedule_id,
    recipe: `${row.recipe_namespace}/${row.recipe_name}`,
    skippedFireAt: currentFire.toISOString(),
    nextFireAt: skipNextFire.toISOString(),
    activeRunId: activeRun.run_id,
    activeRunPhase: activeRun.phase,
    activeRunAgeSeconds: Math.max(0, Math.floor((now - activeSince.getTime()) / 1000)),
    consecutiveSkips,
  }
  rootLogger.info(
    { event: 'workflow_schedule_worker_concurrency_forbidden', ...fields },
    'schedule tick skipped: concurrencyPolicy Forbid and a run of this recipe is still active'
  )
  if (consecutiveSkips === FORBID_SUSTAINED_SKIP_THRESHOLD) {
    workflowScheduleWorkerConcurrencyForbiddenSustainedTotal.inc(1)
    rootLogger.warn(
      { event: 'workflow_schedule_worker_concurrency_forbidden_sustained', ...fields },
      'schedule has skipped consecutive ticks under concurrencyPolicy Forbid; check the blocking run'
    )
  }

  return {
    scheduleId: row.schedule_id,
    runId: null,
    fired: false,
    reason: 'concurrency_forbidden',
    activeRunId: activeRun.run_id,
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

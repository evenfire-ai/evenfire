/**
 * Scheduling handler — DB-backed schedule registration.
 *
 * Fase 5 (serene-sauteeing-jellyfish.md) replaced K8s CronJobs with a
 * Postgres-backed worker living inside `control-api`. The WRC's job is now
 * limited to keeping `workflow_schedules` in sync with the recipe's
 * `spec.scheduling` — it never emits a CronJob, Pod, or HTTP trigger.
 *
 * Responsibilities:
 *   1. On reconcile with `spec.scheduling` present → UPSERT a row into
 *      `workflow_schedules` keyed on (recipe_namespace, recipe_name).
 *   2. On reconcile WITHOUT scheduling → DELETE the row (idempotent).
 *   3. On recipe delete → DELETE the row (idempotent).
 *
 * Invariants:
 *   • `next_fire_at` is only reset when `cron_expression` or `timezone`
 *     changed, OR when re-enabling after `suspend` (the stored value is
 *     likely stale after a long suspend window). Otherwise we preserve
 *     whatever the worker has already advanced it to.
 *   • `enabled = NOT suspend` so the worker's `enabled = TRUE` filter keeps
 *     suspended schedules dormant without deleting the row.
 *   • All UPDATEs explicitly set `updated_at = now()` — the codebase does not
 *     use auto-update triggers (see control-api db.ts convention).
 */
import { CronExpressionParser } from 'cron-parser'
import type { Pool } from 'pg'
import type { SchedulingSpec } from './types'

export const WORKFLOW_TEAM_ID_LABEL = 'clerum.io/workflow-team-id'
export const MAX_TTL_SECONDS_AFTER_FINISHED = 30 * 24 * 60 * 60

/** Actor types that may trigger a run. Mirrors the check constraint on `workflow_runs.actor_type`. */
export type TriggerAllowedActor = 'user' | 'autonomous' | 'scheduled'

export interface SchedulingRecipe {
  metadata: { name: string; namespace: string; uid: string; labels?: Record<string, string> }
  spec: {
    scheduling?: SchedulingSpec
    /**
     * Optional actor allow-list mirrored from `spec.triggers.onDemand.allowedActors`.
     * Denormalized into `workflow_schedules.allowed_actors` so the DB-backed
     * schedule worker can gate scheduled fires consistently with the on-demand
     * admin endpoint — otherwise a recipe with `allowedActors: ['user']` would
     * silently keep firing on schedule while blocking the same-authority API
     * path, which is the bug this field closes (Phase 7 review finding).
     *
     * `undefined` / `null` = no allow-list (any actor may fire).
     */
    allowedActors?: TriggerAllowedActor[] | null
    /**
     * Optional retention configuration mirrored from `spec.runRetention`.
     * The schedule worker stamps these values onto each `workflow_runs` row
     * so active-run timeout and post-finish archive windows follow the recipe
     * contract.
     */
    runRetention?: {
      maxRunDurationSeconds?: number | null
      ttlSecondsAfterFinished?: number | null
    } | null
  }
}

export type SchedulingAction =
  | 'created'
  | 'updated'
  | 'suspended'
  | 'resumed'
  | 'skipped'
  | 'deleted'

/** Public result shape — `batchApi.*Action` wording preserved for log parity. */
export interface SchedulingResult {
  action: SchedulingAction
}

/**
 * Reconcile `workflow_schedules` for a single recipe. Idempotent — safe to
 * call on every WRC reconcile tick.
 *
 * Returns a small summary describing the mutation that occurred so the caller
 * can emit the historical `log.info(\`Scheduling: ${action}\`)` line.
 */
export async function reconcileScheduling(
  pool: Pool,
  recipe: SchedulingRecipe
): Promise<SchedulingResult> {
  const sched = recipe.spec.scheduling
  const ns = recipe.metadata.namespace
  const name = recipe.metadata.name

  // No scheduling requested → ensure no row lingers. Idempotent DELETE.
  if (!sched) {
    const deleted = await pool.query(
      `DELETE FROM workflow_schedules
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [ns, name]
    )
    return { action: (deleted.rowCount ?? 0) > 0 ? 'deleted' : 'skipped' }
  }

  const timezone = sched.timezone ?? 'UTC'
  const wantSuspend = sched.suspend ?? false
  const enabled = !wantSuspend
  const teamId = requiredScheduleTeamId(recipe.metadata.labels, `${ns}/${name}`)
  // `undefined` (CRD field absent) → SQL NULL (no restriction). An explicit
  // empty array is also normalized to NULL: an operator writing `[]` almost
  // certainly meant "no gating", not "deny every actor" (matches the
  // getOnDemandAllowedActors() semantics in control-api/routes/admin/workflows).
  const allowedActors =
    Array.isArray(recipe.spec.allowedActors) && recipe.spec.allowedActors.length > 0
      ? JSON.stringify(recipe.spec.allowedActors)
      : null
  const maxDurationSeconds =
    typeof recipe.spec.runRetention?.maxRunDurationSeconds === 'number' &&
    Number.isInteger(recipe.spec.runRetention.maxRunDurationSeconds) &&
    recipe.spec.runRetention.maxRunDurationSeconds > 0
      ? recipe.spec.runRetention.maxRunDurationSeconds
      : null
  const ttlSecondsAfterFinished = resolveTtlSecondsAfterFinished(
    recipe.spec.runRetention?.ttlSecondsAfterFinished ?? null
  )

  // Fetch current row so we can emit semantic actions (created/updated/…) and
  // decide whether to reset next_fire_at. One SELECT + one UPSERT per tick.
  const existing = await pool.query<{
    cron_expression: string
    timezone: string
    enabled: boolean
    team_id: string | null
    allowed_actors: TriggerAllowedActor[] | null
    max_duration_seconds: number | null
    ttl_seconds_after_finished: number | null
  }>(
    `SELECT cron_expression, timezone, enabled, team_id::text AS team_id,
            allowed_actors, max_duration_seconds, ttl_seconds_after_finished
       FROM workflow_schedules
      WHERE recipe_namespace = $1 AND recipe_name = $2`,
    [ns, name]
  )

  const initialNextFire = computeNextFire(sched.cron, timezone, new Date())
  const prev = existing.rows[0]

  if (!prev) {
    await pool.query(
      `INSERT INTO workflow_schedules
         (recipe_namespace, recipe_name, team_id, cron_expression, timezone,
          next_fire_at, enabled, allowed_actors, max_duration_seconds,
          ttl_seconds_after_finished, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now(), now())`,
      [
        ns,
        name,
        teamId,
        sched.cron,
        timezone,
        initialNextFire,
        enabled,
        allowedActors,
        maxDurationSeconds,
        ttlSecondsAfterFinished,
      ]
    )
    return { action: 'created' }
  }

  const cronChanged = prev.cron_expression !== sched.cron || prev.timezone !== timezone
  const resuming = prev.enabled === false && enabled === true
  const suspending = prev.enabled === true && enabled === false
  const teamChanged = prev.team_id !== teamId
  const actorsChanged = !sameActorList(prev.allowed_actors, recipe.spec.allowedActors ?? null)
  const durationChanged = prev.max_duration_seconds !== maxDurationSeconds
  const ttlChanged = prev.ttl_seconds_after_finished !== ttlSecondsAfterFinished

  // Reset next_fire_at only when the schedule itself shifted or we're waking
  // a suspended schedule — the worker's advancement of next_fire_at is the
  // authoritative value while the schedule is live and unchanged.
  if (cronChanged || resuming) {
    await pool.query(
      `UPDATE workflow_schedules
         SET cron_expression = $1,
             timezone = $2,
             enabled = $3,
             next_fire_at = $4,
             team_id = $5,
             allowed_actors = $6::jsonb,
             max_duration_seconds = $7,
             ttl_seconds_after_finished = $8,
             updated_at = now()
       WHERE recipe_namespace = $9 AND recipe_name = $10`,
      [
        sched.cron,
        timezone,
        enabled,
        initialNextFire,
        teamId,
        allowedActors,
        maxDurationSeconds,
        ttlSecondsAfterFinished,
        ns,
        name,
      ]
    )
  } else if (
    suspending ||
    prev.enabled !== enabled ||
    teamChanged ||
    actorsChanged ||
    durationChanged ||
    ttlChanged
  ) {
    await pool.query(
      `UPDATE workflow_schedules
         SET enabled = $1,
             team_id = $2,
             allowed_actors = $3::jsonb,
             max_duration_seconds = $4,
             ttl_seconds_after_finished = $5,
             updated_at = now()
       WHERE recipe_namespace = $6 AND recipe_name = $7`,
      [enabled, teamId, allowedActors, maxDurationSeconds, ttlSecondsAfterFinished, ns, name]
    )
  } else {
    return { action: 'skipped' }
  }

  if (suspending) return { action: 'suspended' }
  if (resuming) return { action: 'resumed' }
  return { action: 'updated' }
}

/**
 * Delete the schedule row for a recipe. Called from the reconciler's delete
 * path — matches the semantics of the old `batchApi.deleteNamespacedCronJob`.
 * Idempotent.
 */
export async function deleteScheduling(
  pool: Pool,
  recipeNamespace: string,
  recipeName: string
): Promise<void> {
  await pool.query(
    `DELETE FROM workflow_schedules
      WHERE recipe_namespace = $1 AND recipe_name = $2`,
    [recipeNamespace, recipeName]
  )
}

/**
 * Compute the next fire time after `from`. Exported for tests — the
 * control-api worker owns the advancement loop, but the reconciler must seed
 * `next_fire_at` on INSERT with a real cron-aware value (otherwise a weekly
 * job would fire immediately on creation).
 */
export function computeNextFire(cronExpression: string, timezone: string, from: Date): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone || 'UTC',
  })
  return interval.next().toDate()
}

/**
 * Order-insensitive equality on two optional actor allow-lists. An empty list
 * is normalized to null (see `allowedActors` handling above) so we only compare
 * null vs null, null vs non-empty, or two non-empty sets.
 */
function sameActorList(a: TriggerAllowedActor[] | null, b: TriggerAllowedActor[] | null): boolean {
  const normA = Array.isArray(a) && a.length > 0 ? [...a].sort() : null
  const normB = Array.isArray(b) && b.length > 0 ? [...b].sort() : null
  if (normA === null && normB === null) return true
  if (normA === null || normB === null) return false
  if (normA.length !== normB.length) return false
  return normA.every((v, i) => v === normB[i])
}

function resolveTtlSecondsAfterFinished(value: number | null | undefined): number {
  if (value === undefined || value === null) return MAX_TTL_SECONDS_AFTER_FINISHED
  if (Number.isInteger(value) && value >= 0 && value <= MAX_TTL_SECONDS_AFTER_FINISHED) {
    return value
  }
  return MAX_TTL_SECONDS_AFTER_FINISHED
}

function requiredScheduleTeamId(
  labels: Record<string, string> | undefined,
  recipeRef: string
): string {
  const teamId = labels?.[WORKFLOW_TEAM_ID_LABEL]?.trim() ?? ''
  if (!teamId) {
    throw new Error(`${recipeRef} scheduled WorkflowRecipe requires ${WORKFLOW_TEAM_ID_LABEL}`)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) {
    throw new Error(`${recipeRef} has invalid ${WORKFLOW_TEAM_ID_LABEL}`)
  }
  return teamId
}

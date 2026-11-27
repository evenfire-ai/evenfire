/**
 * Ceiling on a workflow run's duration, in seconds. Equals the WRC's hard
 * limit on `spec.runRetention.maxRunDurationSeconds`
 * (workflow-recipes/src/config.ts DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS,
 * enforced in workflowLimits.ts; the env override can only lower it). The CRD
 * default (604800) is above it, so readers clamp a stored value to this cap.
 *
 * Every `INSERT INTO workflow_runs` stores it when the recipe gives no
 * duration, and the schedule worker's Forbid lookup uses it as the bound of a
 * `Running` or `AuthorizationPaused` run.
 */
export const WORKFLOW_RUN_MAX_DURATION_CAP_SECONDS = 24 * 60 * 60

/**
 * The `max_duration_seconds` a new workflow_runs row stores: the recipe's
 * value when it gives one, otherwise the cap, so no new run is unbounded.
 * A value above the cap is stored as given; readers clamp it.
 */
export function storedMaxRunDurationSeconds(value: number | null | undefined): number {
  return value ?? WORKFLOW_RUN_MAX_DURATION_CAP_SECONDS
}

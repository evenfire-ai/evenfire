/**
 * Token-budget types (Phase P1). Mirrors the control-api
 * `POST /api/v1/internal/budgets/check` contract.
 *
 * Kept free of any `queue`/`agent` imports so `queue/types.ts` can import
 * `BudgetVerdict` (to persist it on a Task for the P2 per-task brake) without a
 * circular dependency.
 */

/** Source dimension reported to control-api. Same union as `UsageContext.source_kind`. */
export type BudgetSourceKind =
  | 'channel'
  | 'desktop'
  | 'workflow'
  | 'cron'
  | 'unknown'
  | 'plugin_workload_sdk'

/**
 * Request body for `POST /api/v1/internal/budgets/check`. Identity fields that
 * mcp-host cannot resolve (team/user UUIDs on channel tasks) are sent absent —
 * control-api resolves them via `context_ref`.
 */
export interface BudgetCheckRequest {
  host_ref: string
  context_ref: string | null
  team_id?: string | null
  user_id?: string | null
  provider: string
  model: string
  llm_secret_name?: string | null
  source_kind: BudgetSourceKind
  recipe_name?: string | null
  cron_job_id?: string | null
  /**
   * P2b (§5.4) — stable task correlation. control-api attaches any danger-zone
   * reservation it creates to this `task_ref` so mcp-host can release it early
   * on task termination (instead of waiting for the reservation TTL).
   */
  task_ref?: string | null
}

/**
 * Active price of one `(provider, model)`, per 1,000,000 tokens. Returned so the
 * P2 per-task cost brake can convert tokens→currency locally without a network
 * round-trip.
 */
export interface BudgetPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  currency: string
}

/**
 * Parsed verdict from the budget check. `maxTaskTokens`/`maxTaskCost`/`price`
 * feed the P2 per-task emergency brake; P1 only persists them on the Task.
 */
export interface BudgetVerdict {
  allowed: boolean
  reason?: string
  maxTaskTokens?: number | null
  maxTaskCost?: number | null
  price?: BudgetPrice | null
  /**
   * P2b (§5.4) — ids of the danger-zone reservations control-api created for
   * this check. Empty/absent when no budget was in the danger zone (the common,
   * far-from-limit case → nothing to release). Non-empty means mcp-host should
   * release the reservation early when the task reaches a terminal state.
   */
  reservationIds?: string[]
  /**
   * Informational (does NOT affect allow/deny). The `(provider, model)` pairs
   * with usage in the current period but no active price — cost budgets
   * sub-count these as $0. mcp-host logs them for ops visibility so a missing
   * price row is caught before it silently understates spend. Mirrors the
   * control-api `UnpricedModel` shape.
   */
  unpriced?: { provider: string; model: string }[]
}

/**
 * Request body for `POST /api/v1/internal/budgets/release` (P2b §5.4). At least
 * one of the two correlation keys must be present. Releasing by `task_ref`
 * drops ALL reservations for that task in one call. Idempotent on control-api.
 *
 * `host_ref` is REQUIRED by control-api: it binds the release to the caller's
 * JWT `claims.hostRefs[0]` and scopes the drop to reservations whose stored
 * `host_ref` matches. It MUST be the SAME `host_ref` sent on the matching
 * `/check` for this task (otherwise the reservation is not found and nothing is
 * released — a benign no-op given the fail-open/TTL semantics).
 */
export interface BudgetReleaseRequest {
  host_ref: string
  reservationId?: string | null
  task_ref?: string | null
}

/** Parsed result of a release call. `released` = number of reservations dropped. */
export interface BudgetReleaseResult {
  released: number
}

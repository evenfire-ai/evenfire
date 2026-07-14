/**
 * P1 budget-check evaluation (.specs/feat-token-budgets §3.1, §3.2, §3.3, §4.1).
 *
 * This is the read-only enforcement core called once per task by mcp-host via
 * `POST /api/v1/internal/budgets/check`. It REUSES the P0c primitives:
 *   - `scopeMatches`        (dimensions.ts §3.1) — does a request match a scope
 *   - `computeBudgetSpent`  (spend.ts §3.2)      — period-aligned spent/remaining
 *   - `listBudgets`/types   (definitions.ts)     — budget definitions
 * It does NOT reimplement spend computation or scope matching.
 *
 * Responsibilities unique to the check:
 *   1. Resolve a missing `team_id` from `context_ref` using the SAME earliest-
 *      bound-wins DISTINCT ON that `usageRollupCron.ts` uses, so channel tasks
 *      (which never carry a team UUID) are scoped to the same canonical team the
 *      rollups attribute their usage to.
 *   2. Cache enabled budget DEFINITIONS in-memory with a short TTL — they change
 *      slowly, so we avoid the SELECT on every check.
 *   3. Decide allow/deny (§3.3, "most restrictive wins"), compute the per-task
 *      brake (MIN of max_task_amount per unit), and return the active price of
 *      this (provider, model) so mcp-host's cost brake needs no network.
 *
 * SECURITY: every DB query here is parameterized. Scope matching is in-memory
 * over the allowlisted dimensions (dimensions.ts). The route guards this with
 * `requireMcpHostJwt` (same as /internal/usage/llm/events) — never weaken it.
 */
import { z } from 'zod'
import { type DbClient, pool } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import { type TokenBudget, listBudgets, toNumber } from './definitions.js'
import { type BudgetScopeDimension, scopeMatches } from './dimensions.js'
import {
  type ReservationConnector,
  releaseReservation,
  reserveInDangerZone,
} from './reservations.js'
import { type UnpricedModel, computeBudgetSpent } from './spend.js'

const log = rootLogger.child({ service: 'budget_check' })

const nullableStr = z.string().nullish()

/**
 * Request shape (§4.1). `host_ref`, `provider`, `model`, `source_kind` are
 * always known to mcp-host; identity dimensions may be absent and are resolved
 * server-side. `.strict()` rejects unknown keys.
 */
export const budgetCheckRequestSchema = z
  .object({
    // `.trim()` so a whitespace-only host_ref 400s instead of normalizing to
    // null: null would skip the /check claim-binding equality and store a
    // NULL-host reservation the deny-path cleanup can't release (matches the
    // /release schema, keeps the reserve/cleanup host_ref provably identical).
    host_ref: z.string().trim().min(1, 'host_ref is required'),
    context_ref: z.string().nullable(),
    team_id: nullableStr,
    user_id: nullableStr,
    provider: z.string().min(1, 'provider is required'),
    model: z.string().min(1, 'model is required'),
    llm_secret_name: nullableStr,
    source_kind: z.enum(['channel', 'desktop', 'workflow', 'cron', 'unknown']),
    recipe_name: nullableStr,
    cron_job_id: nullableStr,
    // Correlation id for the anti-race danger-zone reservation (§5.4). mcp-host
    // sends it so it can release reservations early on task completion; absent →
    // the reservation still happens but is only freed by its TTL. Optional for
    // backward-compat with P1 callers.
    task_ref: nullableStr,
  })
  .strict()

export type BudgetCheckRequest = z.infer<typeof budgetCheckRequestSchema>

export type BudgetCheckPrice = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  currency: string
}

export type BudgetCheckMatched = {
  id: string
  name: string
  unit: string
  remaining: number
  limit: number
  enforcement: string
}

export type BudgetCheckResult = {
  allowed: boolean
  reason?: string
  maxTaskTokens?: number | null
  maxTaskCost?: number | null
  price?: BudgetCheckPrice | null
  matched?: BudgetCheckMatched[]
  // Distinct (provider, model) pairs whose in-period usage a matched `cost`
  // budget could not price (no active `llm_model_prices` row), so they counted
  // as $0 and the budget SUB-COUNTS their spend. Surfaced (NOT denied) so
  // mcp-host can log it and the UI can flag it; empty when everything was priced
  // (or no cost budget matched). Deduped across all matched budgets.
  unpriced?: UnpricedModel[]
  // Ids of danger-zone reservations created by this check (§5.4). mcp-host holds
  // these (or the request's `task_ref`) to release early via /internal/budgets/
  // release on task completion. Empty when no budget was in the danger zone.
  reservationIds?: string[]
}

// ── Definitions cache (§4.1 step 2) ─────────────────────────────────────────
// Budget definitions change slowly (admin edits), so caching the enabled set
// for a few seconds removes a SELECT from the hot per-task path. The cache holds
// ALL enabled budgets; per-request scope filtering happens in memory afterwards.
// Stale window is bounded by TTL; an admin toggling a budget sees it enforced
// within at most TTL_MS. This is intentionally short to keep enforcement fresh.
const DEFINITIONS_TTL_MS = 5000
let definitionsCache: { budgets: TokenBudget[]; expiresAt: number } | null = null

/** Test-only: drop the module-level cache so cases don't bleed into each other. */
export function __resetBudgetCheckCache(): void {
  definitionsCache = null
}

async function getEnabledBudgetsCached(db: DbClient): Promise<TokenBudget[]> {
  const now = Date.now()
  if (definitionsCache && definitionsCache.expiresAt > now) {
    return definitionsCache.budgets
  }
  const enabled = (await listBudgets(db)).filter(b => b.enabled)
  definitionsCache = { budgets: enabled, expiresAt: now + DEFINITIONS_TTL_MS }
  return enabled
}

/**
 * Resolve the canonical team for a context using the IDENTICAL DISTINCT ON that
 * `usageRollupCron.ts` applies (earliest-bound wins, team_id breaks ties). A
 * context shared across teams collapses to exactly one team, matching how the
 * rollups attribute its usage — otherwise the check would scope to a different
 * team than the spend it reads.
 */
async function resolveTeamForContext(contextRef: string, db: DbClient): Promise<string | null> {
  const result = await db.query(
    `SELECT tc.team_id::text AS team_id
       FROM (
         SELECT DISTINCT ON (context_id) context_id, team_id
           FROM team_contexts
          ORDER BY context_id, created_at ASC, team_id ASC
       ) tc
      WHERE tc.context_id = $1
      LIMIT 1`,
    [contextRef]
  )
  const row = result.rows[0] as { team_id?: unknown } | undefined
  const teamId = row?.team_id
  return typeof teamId === 'string' && teamId.length > 0 ? teamId : null
}

/** Active price for (provider, model), per 1M tokens, or null if unpriced. */
async function getActivePrice(
  provider: string,
  model: string,
  db: DbClient
): Promise<BudgetCheckPrice | null> {
  const result = await db.query(
    `SELECT input_token_price, output_token_price,
            cache_read_token_price, cache_write_token_price, currency
       FROM llm_model_prices
      WHERE provider = $1 AND model = $2 AND enabled
      LIMIT 1`,
    [provider, model]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    input: toNumber(row.input_token_price),
    output: toNumber(row.output_token_price),
    cacheRead: toNumber(row.cache_read_token_price),
    cacheWrite: toNumber(row.cache_write_token_price),
    currency: String(row.currency),
  }
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Evaluate the budget check for one task (§4.1). Returns a decision, the
 * per-task brake, the active price, and the matched-budget debug list.
 *
 * Error handling for a single budget's spend computation (spec §8 — a
 * recoverable error must NOT become a silent bypass of a `block` budget):
 *   - `block` budget that fails to compute  → DENY (allowed=false,
 *     reason='budget_eval_error'). We cannot prove the task is under the cap, so
 *     the conservative, non-bypass choice is to deny rather than wave it through.
 *   - `warn`  budget that fails to compute   → log + skip. Warn never denies and
 *     never contributes to the brake (its remaining is unknown).
 *   - A failing budget NEVER throws out of here: one bad budget must not 500 the
 *     whole check. (The cross-service fail-open of §0.2 lives in mcp-host, for
 *     when control-api is unreachable; this path is control-api responding.)
 */
export async function evaluateBudgetCheck(
  req: BudgetCheckRequest,
  db: DbClient = pool,
  connector: ReservationConnector = pool
): Promise<BudgetCheckResult> {
  // 1. Resolve identity — team_id binding (SECURITY, §4.1).
  //
  // The body's `team_id` is caller-controlled and the mcp-host access JWT does
  // NOT carry a team claim, so the route's claim-binding cannot bind it. A valid
  // token could therefore pass ANOTHER tenant's `team_id` and both (a) leak that
  // tenant's budget headroom in `matched[]` and (b) reserve against it. To close
  // that spoof source-agnostically: whenever a `context_ref` is present, derive
  // the canonical team SERVER-SIDE from the context (`resolveTeamForContext` is
  // 1:1 by DISTINCT ON) and use THAT for scope matching — the body value is never
  // trusted when the context can canonicalize it.
  //
  // OVERRIDE (not 403) when body team_id disagrees with the resolved team: this
  // is both the safe and the CORRECT choice. The usage rollups attribute this
  // context's spend to the resolved team, so matching on any other team_id would
  // read the wrong spend — the resolved team is the only value whose enforcement
  // is correct. For a legitimate context-bound task body team_id == resolved (or
  // is absent), so override is a no-op and never breaks a legit task; a 403 would
  // instead risk denying a benign stale-body task. The disagreement is logged for
  // audit so spoof attempts stay visible.
  //
  // RESIDUAL: when there is no `context_ref` (workflow/cron may carry a team_id
  // with no context) or the context has no `team_contexts` binding yet (resolves
  // null), the team cannot be canonicalized, so the body `team_id` is used as
  // today. Robustly binding that (and `user_id`/other dimensions) would require a
  // `workflow_runs`-style run binding, which needs `run_id` added to the /check
  // contract (mcp-host → control-api) — out of scope here.
  //
  // NOTE: `context_ref` itself is caller-supplied and NOT claim-bound (only
  // `host_ref`/`recipe_name` are, in the route). So this canonicalization is
  // only as strong as the provided `context_ref`: a caller that knows another
  // tenant's `context_ref` can still target that team. This is strictly harder
  // than the vector we close here (writing an arbitrary `team_id` UUID with no
  // context) and is pre-existing; binding `context_ref` is a separate follow-up.
  let teamId = normalize(req.team_id)
  const contextRef = normalize(req.context_ref)
  if (contextRef) {
    let resolvedTeam: string | null = null
    try {
      resolvedTeam = await resolveTeamForContext(contextRef, db)
    } catch (err) {
      // Identity resolution failure must not crash the check: fall through with
      // the body/absent team_id. A team-scoped budget then matches only if the
      // (untrusted) body team_id happens to match; global budgets still enforce.
      log.warn({ err, contextRef }, 'budget_check_team_resolution_failed')
    }
    if (resolvedTeam) {
      if (teamId && teamId !== resolvedTeam) {
        // Body team_id contradicts the context's canonical team: a spoof attempt
        // or a stale/inconsistent caller. Override with the resolved team (never
        // trust the body, never break the task) and record it for audit.
        log.warn(
          {
            contextRef,
            bodyTeamId: teamId,
            resolvedTeamId: resolvedTeam,
            hostRef: normalize(req.host_ref),
            sourceKind: req.source_kind,
          },
          'budget_check_team_binding_override'
        )
      }
      teamId = resolvedTeam
    }
  }

  const dimensions: Partial<Record<BudgetScopeDimension, string | null>> = {
    host_ref: normalize(req.host_ref),
    context_ref: contextRef,
    team_id: teamId,
    user_id: normalize(req.user_id),
    provider: normalize(req.provider),
    model: normalize(req.model),
    llm_secret_name: normalize(req.llm_secret_name),
    source_kind: req.source_kind,
    recipe_name: normalize(req.recipe_name),
    cron_job_id: normalize(req.cron_job_id),
  }

  // 2. Load enabled budgets (cached) and 3. filter to the ones that match.
  const enabled = await getEnabledBudgetsCached(db)
  const matching = enabled.filter(b => scopeMatches(b.scope, dimensions))

  const taskRef = normalize(req.task_ref)

  let allowed = true
  let reason: string | undefined
  let maxTaskTokens: number | null = null
  let maxTaskCost: number | null = null
  const matched: BudgetCheckMatched[] = []
  const reservationIds: string[] = []
  // Deduped across matched budgets: two cost budgets can each surface the same
  // unpriced (provider, model). Keyed by a NUL-joined pair (NUL can't occur in
  // provider/model), so distinct pairs never collide.
  const unpricedByKey = new Map<string, UnpricedModel>()

  for (const budget of matching) {
    let spent: number
    let remaining: number
    try {
      const spend = await computeBudgetSpent(budget, db)
      spent = spend.spent
      remaining = spend.remaining
      if (spend.unpriced.length > 0) {
        for (const u of spend.unpriced) {
          unpricedByKey.set(`${u.provider}\u0000${u.model}`, u)
        }
        // Surface the under-count so it is visible in control-api logs even
        // when mcp-host does not forward it. NOT a deny — see §3.3 / product
        // decision: unpriced is surfaced + prevented, never enforced here.
        log.warn(
          {
            budgetId: budget.id,
            name: budget.name,
            unit: budget.unit,
            unpriced: spend.unpriced,
          },
          'budget_unpriced_usage'
        )
      }
    } catch (err) {
      log.error(
        { err, budgetId: budget.id, enforcement: budget.enforcement },
        'budget_check_spend_error'
      )
      if (budget.enforcement === 'block') {
        // Anti-bypass: an unevaluable block budget denies rather than allows.
        allowed = false
        if (!reason) reason = 'budget_eval_error'
      }
      // warn budgets that error are skipped entirely (never deny, no brake).
      continue
    }

    matched.push({
      id: budget.id,
      name: budget.name,
      unit: budget.unit,
      remaining,
      limit: budget.limit_amount,
      enforcement: budget.enforcement,
    })

    // 6. Per-task brake: MIN of max_task_amount across matching budgets, by unit.
    // Only `block` budgets impose a brake — the brake aborts the task (P2), which
    // is enforcement, and a `warn` budget must never enforce (observation only).
    if (budget.enforcement === 'block' && budget.max_task_amount != null) {
      if (budget.unit === 'tokens') {
        maxTaskTokens =
          maxTaskTokens == null
            ? budget.max_task_amount
            : Math.min(maxTaskTokens, budget.max_task_amount)
      } else {
        maxTaskCost =
          maxTaskCost == null
            ? budget.max_task_amount
            : Math.min(maxTaskCost, budget.max_task_amount)
      }
    }

    // 5. Decision (§3.3) + danger-zone anti-race reservation (§5.4).
    if (budget.enforcement === 'block') {
      // Danger zone = "one more task could blow the limit": remaining is already
      // below a single task's cap. Only then do we pay for the lock+reservation;
      // outside it the pull decision is identical to P1 (zero overhead).
      const inDangerZone = budget.max_task_amount != null && remaining < budget.max_task_amount

      // Skip the reservation once the request is already denied by an earlier
      // budget — the task will not run, so a reservation here would only leak
      // until TTL. Any reservations created before this deny are released after
      // the loop (see the cleanup below).
      if (inDangerZone && allowed) {
        try {
          const r = await reserveInDangerZone(
            {
              budgetId: budget.id,
              limit: budget.limit_amount,
              spent,
              minStart: budget.min_start_amount,
              // non-null because inDangerZone required max_task_amount != null
              estAmount: budget.max_task_amount as number,
              taskRef,
              // Persist the caller's host binding so an early release can only
              // free this host's own reservations (§5.4). Already normalized
              // above and bound to claims.hostRefs[0] by the route's claim-binding.
              hostRef: dimensions.host_ref ?? null,
            },
            connector
          )
          if (r.decision === 'deny') {
            // effective_remaining (incl. concurrent pending) < min_start → the
            // second of two simultaneous tasks loses the race.
            allowed = false
            reason = 'budget_exceeded'
          } else {
            reservationIds.push(r.reservationId)
          }
        } catch (err) {
          // Fail-open of the reservation REFINEMENT only (spec §8): a recoverable
          // reservation/lock error degrades to the P1 pull decision — never a
          // silent bypass (it still denies what P1 denies) and never stricter
          // than P1 (no pending added). The reservation is a reinforcement; its
          // failure must not be harsher than P1.
          log.error({ err, budgetId: budget.id }, 'budget_check_reservation_error')
          if (remaining < budget.min_start_amount) {
            allowed = false
            reason = 'budget_exceeded'
          }
        }
      } else if (remaining < budget.min_start_amount) {
        // Safe zone (or no per-task cap): pure P1 pull decision, no reservation.
        allowed = false
        // A real exceed is the most actionable reason; let it win over an
        // earlier eval-error code.
        reason = 'budget_exceeded'
      }
    } else if (remaining < budget.min_start_amount) {
      // warn never denies — emit the observation-mode signal (§3.3).
      log.warn(
        {
          budgetId: budget.id,
          name: budget.name,
          unit: budget.unit,
          spent,
          remaining,
          minStart: budget.min_start_amount,
          limit: budget.limit_amount,
        },
        'budget_would_block'
      )
    }
  }

  // 7. Active price for THIS (provider, model) so mcp-host converts tokens→$
  // for the per-task cost brake without a network call.
  let price: BudgetCheckPrice | null = null
  try {
    price = await getActivePrice(dimensions.provider ?? '', dimensions.model ?? '', db)
  } catch (err) {
    // Price lookup is advisory (brake input). A failure must not deny or 500;
    // the cost brake simply stays disabled for this task.
    log.warn(
      { err, provider: dimensions.provider, model: dimensions.model },
      'budget_check_price_error'
    )
  }

  // If the overall decision is deny, the task will not run, so any reservation an
  // earlier (allowing) budget created in this same check is spurious — release it
  // here rather than leaving it to leak until TTL. This makes control-api
  // self-cleaning and robust to a lost mcp-host release / a non-P2b client.
  if (!allowed && reservationIds.length > 0) {
    for (const id of reservationIds) {
      try {
        // Scope the cleanup to the same host the reservation was created under
        // (releaseReservation requires hostRef). These ids were just returned by
        // reserveInDangerZone with this exact host_ref, so the DELETE matches.
        await releaseReservation({ reservationId: id, hostRef: dimensions.host_ref ?? '' }, db)
      } catch (err) {
        log.warn({ err, reservationId: id }, 'budget_check_reservation_cleanup_error')
      }
    }
    reservationIds.length = 0
  }

  const unpriced = Array.from(unpricedByKey.values())

  return { allowed, reason, maxTaskTokens, maxTaskCost, price, matched, unpriced, reservationIds }
}

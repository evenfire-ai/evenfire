/**
 * Budget spend computation (.specs/feat-token-budgets §3.2) — THE CORE of the
 * token-budgets feature, reused by the P1 budget-check.
 *
 * `spent` = the sum of all consumption falling in a budget's `scope`, from the
 * start of the current calendar period, expressed in the budget's `unit`. It is
 * derived on demand from the pre-aggregated usage rollups — there is no
 * materialized counter that could drift.
 *
 * Two disjoint rollup tiers are stitched by bucket (§3.2):
 *   - `usage_daily`  for  periodStart <= bucket < startOfToday  (whole past days)
 *   - `usage_5min`   for  bucket >= startOfToday                (today, freshest)
 *
 * `periodStart`/`startOfToday` are computed inside Postgres in the budget's
 * timezone:  date_trunc(period, now() AT TIME ZONE tz) AT TIME ZONE tz.
 * For a `daily` budget periodStart == startOfToday, so the daily-tier range is
 * empty and everything comes from `usage_5min`.
 *
 * unit='tokens': sum input+output+cache_read+cache_write (no price JOIN).
 * unit='cost':   LEFT JOIN llm_model_prices on the active (provider, model) row;
 *                amount = (in*inP + out*outP + cr*crP + cw*cwP) / 1e6. A model
 *                with no active price contributes 0 and is surfaced as unpriced.
 *
 * SECURITY: the scope WHERE is built by `buildScopeSql`, which only emits
 * allowlisted column identifiers and binds every scope value as a parameter.
 */
import { type DbClient, pool } from '../../db.js'
import { type BudgetPeriod, type BudgetUnit, type TokenBudget, toNumber } from './definitions.js'
import { type BudgetScope, buildScopeSql } from './dimensions.js'

export type UnpricedModel = { provider: string; model: string }

export type BudgetSpend = {
  spent: number
  remaining: number
  /** Distinct (provider, model) pairs with usage in-period/scope but no active price (cost only). */
  unpriced: UnpricedModel[]
}

const PERIOD_TRUNC: Record<BudgetPeriod, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
}

type SpendArgs = {
  scope: BudgetScope | null | undefined
  period: BudgetPeriod
  timezone: string
  unit: BudgetUnit
  limit_amount: number
}

/**
 * Period-aligned `spent` (and `remaining = limit_amount - spent`) for a budget.
 * Accepts either a full `TokenBudget` or just the spend-relevant fields so the
 * P1 check can call it cheaply.
 */
export async function computeBudgetSpent(
  budget: TokenBudget | SpendArgs,
  db: DbClient = pool
): Promise<BudgetSpend> {
  const period = budget.period
  const truncField = PERIOD_TRUNC[period]
  const tz = budget.timezone
  // $1 = date_trunc period field, $2 = timezone; scope params start at $3.
  const scope = buildScopeSql(budget.scope, 3)
  const params: unknown[] = [truncField, tz, ...scope.params]

  const boundsCte = `
    WITH bounds AS (
      SELECT
        date_trunc($1, now() AT TIME ZONE $2) AT TIME ZONE $2 AS period_start,
        date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS start_of_today
    )`

  if (budget.unit === 'tokens') {
    // No price JOIN: a tokens budget works even with no price table at all.
    const sql = `${boundsCte}
      SELECT COALESCE(SUM(amt), 0) AS spent
      FROM (
        SELECT (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS amt
          FROM usage_daily, bounds
         WHERE bucket >= bounds.period_start AND bucket < bounds.start_of_today${scope.sql}
        UNION ALL
        SELECT (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS amt
          FROM usage_5min, bounds
         WHERE bucket >= bounds.start_of_today${scope.sql}
      ) u`
    const result = await db.query(sql, params)
    const row = result.rows[0] as Record<string, unknown> | undefined
    const spent = toNumber(row?.spent)
    return { spent, remaining: budget.limit_amount - spent, unpriced: [] }
  }

  // unit === 'cost': aggregate per (provider, model), then LEFT JOIN the active
  // price. Doing it grouped lets us both sum cost and surface unpriced pairs in
  // a single round trip.
  const sql = `${boundsCte},
    rollup AS (
      SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        FROM usage_daily, bounds
       WHERE bucket >= bounds.period_start AND bucket < bounds.start_of_today${scope.sql}
      UNION ALL
      SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        FROM usage_5min, bounds
       WHERE bucket >= bounds.start_of_today${scope.sql}
    ),
    agg AS (
      SELECT provider, model,
             SUM(input_tokens)      AS input_tokens,
             SUM(output_tokens)     AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_write_tokens) AS cache_write_tokens
        FROM rollup
       GROUP BY provider, model
    )
    SELECT
      a.provider,
      a.model,
      (p.id IS NOT NULL) AS priced,
      (a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens) AS tokens,
      (a.input_tokens      * COALESCE(p.input_token_price, 0)
     + a.output_tokens     * COALESCE(p.output_token_price, 0)
     + a.cache_read_tokens * COALESCE(p.cache_read_token_price, 0)
     + a.cache_write_tokens * COALESCE(p.cache_write_token_price, 0)) / 1e6 AS amount
    FROM agg a
    LEFT JOIN llm_model_prices p
      ON p.provider = a.provider AND p.model = a.model AND p.enabled`

  const result = await db.query(sql, params)
  let spent = 0
  const unpriced: UnpricedModel[] = []
  for (const raw of result.rows as Record<string, unknown>[]) {
    spent += toNumber(raw.amount)
    const priced = raw.priced === true || raw.priced === 't'
    const tokens = toNumber(raw.tokens)
    if (!priced && tokens > 0) {
      unpriced.push({ provider: String(raw.provider), model: String(raw.model) })
    }
  }
  return { spent, remaining: budget.limit_amount - spent, unpriced }
}

export type BudgetWithSpend = TokenBudget & BudgetSpend

/** Attach computed spend to a budget for the admin list/detail surface. */
export async function withSpend(
  budget: TokenBudget,
  db: DbClient = pool
): Promise<BudgetWithSpend> {
  const spend = await computeBudgetSpent(budget, db)
  return { ...budget, ...spend }
}

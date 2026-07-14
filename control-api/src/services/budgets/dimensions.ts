/**
 * Shared scope vocabulary for token budgets (.specs/feat-token-budgets §2.2, §3.1).
 *
 * A budget `scope` is a JSONB object mirroring usageReader's `UsageFilters`
 * shape (`Partial<Record<dimension, string[]>>`): keys are ANDed, values within
 * a key are ORed, `{}` matches everything (global). This module is the single
 * source of truth for which dimensions are allowed, the zod schema that rejects
 * arbitrary keys (anti-injection), the SQL WHERE builder used by spend
 * computation, and the in-memory matcher reused by the P1 budget-check.
 *
 * SECURITY: every dimension here is a column on the usage rollup tables
 * (`usage_5min` / `usage_daily`). The WHERE builder only ever emits identifiers
 * from this fixed allowlist; scope values are always bound parameters. Scope
 * keys never become SQL identifiers without passing the allowlist.
 */
import { z } from 'zod'

/**
 * Allowed scope dimensions. Each is a real column on the usage rollup tables.
 * Superset of usageReader's group-by set with the budget-relevant additions
 * (`context_ref`, `cron_job_id`) and without the request-only `sender` /
 * `channel_type` dimensions, which budgets do not target.
 */
export const BUDGET_SCOPE_DIMENSIONS = [
  'host_ref',
  'context_ref',
  'team_id',
  'user_id',
  'provider',
  'model',
  'llm_secret_name',
  'source_kind',
  'recipe_name',
  'cron_job_id',
] as const

export type BudgetScopeDimension = (typeof BUDGET_SCOPE_DIMENSIONS)[number]

const ALLOWED_DIMENSIONS: ReadonlySet<string> = new Set(BUDGET_SCOPE_DIMENSIONS)

export function isAllowedDimension(value: unknown): value is BudgetScopeDimension {
  return typeof value === 'string' && ALLOWED_DIMENSIONS.has(value)
}

export type BudgetScope = Partial<Record<BudgetScopeDimension, string[]>>

const valuesSchema = z
  .array(z.string().min(1, 'must be non-empty').max(400))
  .min(1, 'must contain at least one value')

/**
 * Strict object schema: only the allowed dimensions are accepted as keys, each
 * mapping to a non-empty `string[]`. `.strict()` rejects any unknown key with a
 * 400 instead of silently dropping it — this is the anti-injection guard.
 */
export const budgetScopeSchema = z
  .object({
    host_ref: valuesSchema.optional(),
    context_ref: valuesSchema.optional(),
    team_id: valuesSchema.optional(),
    user_id: valuesSchema.optional(),
    provider: valuesSchema.optional(),
    model: valuesSchema.optional(),
    llm_secret_name: valuesSchema.optional(),
    source_kind: valuesSchema.optional(),
    recipe_name: valuesSchema.optional(),
    cron_job_id: valuesSchema.optional(),
  })
  .strict()

/**
 * Build the scope WHERE fragment for a rollup query. Keys are ANDed, values
 * ORed (`col IN ($n, ...)`). Only allowlisted dimensions reach the SQL as
 * identifiers; values are bound parameters starting at `startIndex`.
 *
 * Defensive against scope rows that predate a schema change: any key not in the
 * allowlist, or an empty/non-array value, is skipped rather than emitted.
 */
export function buildScopeSql(
  scope: BudgetScope | null | undefined,
  startIndex: number
): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  let idx = startIndex
  if (scope && typeof scope === 'object') {
    for (const key of Object.keys(scope)) {
      if (!isAllowedDimension(key)) continue
      const values = scope[key]
      if (!Array.isArray(values) || values.length === 0) continue
      const placeholders: string[] = []
      for (const v of values) {
        if (typeof v !== 'string') continue
        params.push(v)
        placeholders.push(`$${idx++}`)
      }
      if (placeholders.length === 0) continue
      // `key` is an allowlisted column identifier (validated above).
      clauses.push(`${key} IN (${placeholders.join(', ')})`)
    }
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params }
}

/**
 * In-memory matcher (§3.1): does a request's dimension values fall within a
 * budget's scope? For each scope key, the request's value for that dimension
 * must be present in `scope[key]`. Keys AND, values OR. `{}` matches all.
 *
 * Not invoked at runtime in P0c (observation mode); provided ready for the P1
 * budget-check. A null/absent request value never matches a constrained key.
 */
export function scopeMatches(
  scope: BudgetScope | null | undefined,
  request: Partial<Record<BudgetScopeDimension, string | null | undefined>>
): boolean {
  if (!scope || typeof scope !== 'object') return true
  for (const key of Object.keys(scope)) {
    if (!isAllowedDimension(key)) continue
    const allowed = scope[key]
    if (!Array.isArray(allowed) || allowed.length === 0) continue
    const actual = request[key]
    if (typeof actual !== 'string' || !allowed.includes(actual)) return false
  }
  return true
}

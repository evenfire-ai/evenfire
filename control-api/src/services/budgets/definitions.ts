/**
 * Service layer for `token_budgets` — budget policy definitions that cap LLM
 * consumption per dimension (.specs/feat-token-budgets §2.2, §4.2).
 *
 * Amounts are NUMERIC for precision; pg returns NUMERIC as strings, so the row
 * mapper coerces them to numbers for the API surface. `scope` is JSONB whose
 * shape is validated by `budgetScopeSchema` (anti-injection: keys ∈ a fixed
 * dimension allowlist). `unit='cost'` requires a `currency`; this is enforced
 * by zod on create and by the DB CHECK constraint on partial update (surfaced
 * as `BudgetValidationError` → 400).
 */
import { z } from 'zod'
import type { DbClient } from '../../db.js'
import { pool } from '../../db.js'
import { type BudgetScope, budgetScopeSchema } from './dimensions.js'

export type BudgetUnit = 'cost' | 'tokens'
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly'
export type BudgetEnforcement = 'block' | 'warn'

export type TokenBudget = {
  id: string
  name: string
  enabled: boolean
  scope: BudgetScope
  unit: BudgetUnit
  currency: string | null
  limit_amount: number
  period: BudgetPeriod
  timezone: string
  min_start_amount: number
  max_task_amount: number | null
  enforcement: BudgetEnforcement
  created_at: string
  updated_at: string
}

/** Thrown for cross-field / shape problems that should surface as 400. */
export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetValidationError'
  }
}

/** A scoped (provider, model) target that has no active price. provider is null
 *  when the scope pins a model without pinning a provider (any provider). */
export type UnpricedScopeTarget = { provider: string | null; model: string }

/**
 * Thrown when a cost budget pins one or more models (`scope.model`) that have no
 * active `llm_model_prices` row, so the budget would silently under-count them.
 * Surfaced as 400 `unpriced_models` by the admin route (prevention (a), §6.1).
 */
export class BudgetUnpricedModelsError extends Error {
  constructor(public readonly models: UnpricedScopeTarget[]) {
    super(
      'cost budget pins models with no active price; add prices in LLM prices before creating a cost budget for these models'
    )
    this.name = 'BudgetUnpricedModelsError'
  }
}

const PG_CHECK_VIOLATION = '23514'
const PG_NOT_NULL_VIOLATION = '23502'

function isCheckOrNotNullViolation(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || '')
  return code === PG_CHECK_VIOLATION || code === PG_NOT_NULL_VIOLATION
}

function isValidTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown IANA zone — catch and reject so an
    // invalid timezone never reaches Postgres `AT TIME ZONE` at compute time.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const amount = z.number({ message: 'must be a number' }).finite('must be finite')
const positiveAmount = amount.positive('must be > 0')
const nonNegativeAmount = amount.min(0, 'must be >= 0')

// v1 budgets are pinned to UTC. The usage rollups truncate `bucket` in the
// Postgres session timezone (effectively UTC), so a non-UTC budget window would
// mis-stitch usage_daily (UTC-day grain) against tz-local period bounds and
// double-count the current day (spec §3.2, open question §9.1). The `timezone`
// column is kept for a future tz-aware rollup; until then only 'UTC' is accepted.
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: 'must be a valid IANA timezone' })
  .refine(tz => tz === 'UTC', {
    message: 'only "UTC" is supported in this version',
  })

export const createBudgetSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(200),
    enabled: z.boolean().default(true),
    scope: budgetScopeSchema.default({}),
    unit: z.enum(['cost', 'tokens']).default('cost'),
    currency: z.string().trim().min(1).max(16).nullish(),
    limit_amount: positiveAmount,
    period: z.enum(['daily', 'weekly', 'monthly']),
    timezone: timezoneSchema.default('UTC'),
    min_start_amount: nonNegativeAmount.default(0),
    max_task_amount: positiveAmount.nullish(),
    enforcement: z.enum(['block', 'warn']).default('block'),
  })
  .strict()
  .refine(
    obj => obj.unit !== 'cost' || (typeof obj.currency === 'string' && obj.currency.length > 0),
    {
      message: "currency is required when unit is 'cost'",
      path: ['currency'],
    }
  )

// Update: every field optional, reject an empty body, `.strict()` to keep
// typos out. The unit/currency invariant is enforced by the DB CHECK on the
// merged row (mapped to BudgetValidationError) since a partial PUT may only
// touch one of the two fields.
export const updateBudgetSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    scope: budgetScopeSchema,
    unit: z.enum(['cost', 'tokens']),
    currency: z.string().trim().min(1).max(16).nullable(),
    limit_amount: positiveAmount,
    period: z.enum(['daily', 'weekly', 'monthly']),
    timezone: timezoneSchema,
    min_start_amount: nonNegativeAmount,
    max_task_amount: positiveAmount.nullable(),
    enforcement: z.enum(['block', 'warn']),
  })
  .partial()
  .strict()
  .refine(obj => Object.keys(obj).length > 0, { message: 'no fields to update' })

export const toggleBudgetSchema = z.object({ enabled: z.boolean() }).strict()

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>

// Coerce a pg NUMERIC (returned as string) / number / bigint to a JS number.
// Shared with spend.ts.
export function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof raw === 'bigint') return Number(raw)
  return 0
}

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  return toNumber(raw)
}

function toIso(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? raw : d.toISOString()
  }
  return String(raw)
}

function toScope(raw: unknown): BudgetScope {
  // pg returns jsonb as an already-parsed object; tolerate a string just in case.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as BudgetScope
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as BudgetScope
    } catch {
      // fall through
    }
  }
  return {}
}

export function rowToBudget(row: Record<string, unknown>): TokenBudget {
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    scope: toScope(row.scope),
    unit: row.unit === 'tokens' ? 'tokens' : 'cost',
    currency: row.currency === null || row.currency === undefined ? null : String(row.currency),
    limit_amount: toNumber(row.limit_amount),
    period: String(row.period) as BudgetPeriod,
    timezone: String(row.timezone),
    min_start_amount: toNumber(row.min_start_amount),
    max_task_amount: toNumberOrNull(row.max_task_amount),
    enforcement: row.enforcement === 'warn' ? 'warn' : 'block',
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }
}

const BUDGET_COLUMNS = `
  id, name, enabled, scope, unit, currency,
  limit_amount, period, timezone, min_start_amount,
  max_task_amount, enforcement, created_at, updated_at
`

export async function listBudgets(db: DbClient = pool): Promise<TokenBudget[]> {
  const result = await db.query(
    `SELECT ${BUDGET_COLUMNS} FROM token_budgets ORDER BY name ASC, created_at ASC`
  )
  return (result.rows as Record<string, unknown>[]).map(rowToBudget)
}

export async function getBudget(id: string, db: DbClient = pool): Promise<TokenBudget | null> {
  const result = await db.query(
    `SELECT ${BUDGET_COLUMNS} FROM token_budgets WHERE id = $1 LIMIT 1`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? rowToBudget(row) : null
}

/**
 * Prevention (a) (§6.1): a cost budget that PINS `scope.model` must not target a
 * model with no active price, or it would count that model's usage as $0 and
 * silently under-enforce. Returns the list of pinned targets that lack an active
 * `llm_model_prices` row:
 *   - scope pins `provider` too → check each (provider × model) pair.
 *   - scope pins only `model`   → require SOME active price for that model
 *     (any provider); a target is only unpriced if NO provider prices it.
 * A scope that does not pin `model` returns [] (no determinable model — that case
 * is covered by runtime surfacing, not this guard).
 */
export async function findUnpricedScopedModels(
  scope: BudgetScope | null | undefined,
  db: DbClient = pool
): Promise<UnpricedScopeTarget[]> {
  const models = scope?.model
  if (!Array.isArray(models) || models.length === 0) return []
  const providers = scope?.provider
  const missing: UnpricedScopeTarget[] = []

  if (Array.isArray(providers) && providers.length > 0) {
    const result = await db.query(
      `SELECT provider, model
         FROM llm_model_prices
        WHERE enabled AND provider = ANY($1::text[]) AND model = ANY($2::text[])`,
      [providers, models]
    )
    const present = new Set(
      (result.rows as Record<string, unknown>[]).map(
        r => `${String(r.provider)}\u0000${String(r.model)}`
      )
    )
    for (const provider of providers) {
      for (const model of models) {
        if (!present.has(`${provider}\u0000${model}`)) missing.push({ provider, model })
      }
    }
    return missing
  }

  const result = await db.query(
    `SELECT DISTINCT model FROM llm_model_prices WHERE enabled AND model = ANY($1::text[])`,
    [models]
  )
  const present = new Set((result.rows as Record<string, unknown>[]).map(r => String(r.model)))
  for (const model of models) {
    if (!present.has(model)) missing.push({ provider: null, model })
  }
  return missing
}

/** A budget reference for the "price in use" guard surface (id + name only). */
export type BudgetRef = { id: string; name: string }

/**
 * Prevention (b) (§6.1): cost budgets whose scope PINS this (provider, model) —
 * used to block deleting/disabling the price they depend on. A budget matches
 * when its scope pins `model` and either does not pin `provider` (any provider)
 * or pins this exact `provider`. Uses the jsonb `?` containment operator over
 * the scope arrays; `$1`/`$2` are the only substitutions (node-postgres does not
 * treat `?` as a placeholder).
 */
export async function findCostBudgetsPinningModel(
  provider: string,
  model: string,
  db: DbClient = pool
): Promise<BudgetRef[]> {
  const result = await db.query(
    `SELECT id::text AS id, name
       FROM token_budgets
      WHERE unit = 'cost'
        AND scope -> 'model' ? $2
        AND (NOT (scope ? 'provider') OR scope -> 'provider' ? $1)
      ORDER BY name ASC, created_at ASC`,
    [provider, model]
  )
  return (result.rows as Record<string, unknown>[]).map(r => ({
    id: String(r.id),
    name: String(r.name),
  }))
}

export async function createBudget(
  input: CreateBudgetInput,
  db: DbClient = pool
): Promise<TokenBudget> {
  const currency = input.currency ?? null
  if (input.unit === 'cost') {
    const unpriced = await findUnpricedScopedModels(input.scope, db)
    if (unpriced.length > 0) throw new BudgetUnpricedModelsError(unpriced)
  }
  try {
    const result = await db.query(
      `INSERT INTO token_budgets
         (name, enabled, scope, unit, currency, limit_amount, period, timezone,
          min_start_amount, max_task_amount, enforcement)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${BUDGET_COLUMNS}`,
      [
        input.name,
        input.enabled,
        JSON.stringify(input.scope ?? {}),
        input.unit,
        currency,
        input.limit_amount,
        input.period,
        input.timezone,
        input.min_start_amount,
        input.max_task_amount ?? null,
        input.enforcement,
      ]
    )
    return rowToBudget(result.rows[0] as Record<string, unknown>)
  } catch (error) {
    if (isCheckOrNotNullViolation(error)) {
      throw new BudgetValidationError(
        'budget violates a constraint (check unit/currency and amounts)'
      )
    }
    throw error
  }
}

export async function updateBudget(
  id: string,
  input: UpdateBudgetInput,
  db: DbClient = pool
): Promise<TokenBudget | null> {
  // Prevention (a) on edit: re-validate pinned-model pricing whenever the update
  // touches `unit` or `scope`, using the MERGED effective row (a PUT may pin a
  // model while leaving unit='cost' untouched, or flip unit to 'cost' over an
  // existing model scope). The existing row is read only when the merged unit or
  // scope can't be decided from the payload alone, to avoid an extra query on the
  // common path. A missing budget falls through — the UPDATE below 404s cleanly
  // rather than raising a spurious 400.
  // An explicit non-cost unit (e.g. flip to 'tokens') can never fail the pricing
  // guard, so skip it — and the extra getBudget read — entirely.
  const skipPricingGuard = input.unit !== undefined && input.unit !== 'cost'
  if (!skipPricingGuard && (input.unit !== undefined || input.scope !== undefined)) {
    let effectiveUnit = input.unit
    let effectiveScope = input.scope
    const scopePinsModel =
      input.scope !== undefined && Array.isArray(input.scope.model) && input.scope.model.length > 0
    const needExisting = input.scope === undefined || (input.unit === undefined && scopePinsModel)
    if (needExisting) {
      const existing = await getBudget(id, db)
      if (existing) {
        effectiveUnit = effectiveUnit ?? existing.unit
        effectiveScope = effectiveScope ?? existing.scope
      }
    }
    if (effectiveUnit === 'cost' && effectiveScope) {
      const unpriced = await findUnpricedScopedModels(effectiveScope, db)
      if (unpriced.length > 0) throw new BudgetUnpricedModelsError(unpriced)
    }
  }

  // Build the SET list from whichever fields were provided. Keys come from the
  // zod-validated `.strict()` schema — never raw request input — so this is a
  // fixed allowlist of column names, not caller-controlled SQL.
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1

  const push = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column} = $${idx}${cast}`)
    params.push(value)
    idx++
  }

  if (input.name !== undefined) push('name', input.name)
  if (input.enabled !== undefined) push('enabled', input.enabled)
  if (input.scope !== undefined) push('scope', JSON.stringify(input.scope), '::jsonb')
  if (input.unit !== undefined) push('unit', input.unit)
  if (input.currency !== undefined) push('currency', input.currency)
  if (input.limit_amount !== undefined) push('limit_amount', input.limit_amount)
  if (input.period !== undefined) push('period', input.period)
  if (input.timezone !== undefined) push('timezone', input.timezone)
  if (input.min_start_amount !== undefined) push('min_start_amount', input.min_start_amount)
  if (input.max_task_amount !== undefined) push('max_task_amount', input.max_task_amount)
  if (input.enforcement !== undefined) push('enforcement', input.enforcement)

  if (sets.length === 0) return getBudget(id, db)

  sets.push(`updated_at = NOW()`)
  params.push(id)

  try {
    const result = await db.query(
      `UPDATE token_budgets
          SET ${sets.join(', ')}
        WHERE id = $${idx}
      RETURNING ${BUDGET_COLUMNS}`,
      params
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row ? rowToBudget(row) : null
  } catch (error) {
    if (isCheckOrNotNullViolation(error)) {
      throw new BudgetValidationError(
        'budget violates a constraint (check unit/currency and amounts)'
      )
    }
    throw error
  }
}

export async function setBudgetEnabled(
  id: string,
  enabled: boolean,
  db: DbClient = pool
): Promise<TokenBudget | null> {
  const result = await db.query(
    `UPDATE token_budgets SET enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING ${BUDGET_COLUMNS}`,
    [enabled, id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? rowToBudget(row) : null
}

export async function deleteBudget(id: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query(`DELETE FROM token_budgets WHERE id = $1`, [id])
  return (result.rowCount ?? 0) > 0
}

/**
 * Service layer for `llm_model_prices` — per-model LLM pricing that backs
 * cost-unit token budgets (see .specs/feat-token-budgets §2.1, §6.1).
 *
 * Prices are stored per 1,000,000 tokens as NUMERIC for monetary precision;
 * pg returns NUMERIC as strings, so the row mapper coerces them to numbers for
 * the API surface. v1 = current price only: one `enabled` row per
 * (provider, model), enforced by the partial unique index
 * `idx_llm_model_prices_active`. A unique violation surfaces as
 * `LlmPriceConflictError` so routes can answer 409.
 */
import { z } from 'zod'
import type { DbClient } from '../db.js'
import { pool } from '../db.js'

export type LlmModelPrice = {
  id: string
  provider: string
  model: string
  input_token_price: number
  output_token_price: number
  cache_read_token_price: number
  cache_write_token_price: number
  currency: string
  effective_from: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export type UnpricedModel = {
  provider: string
  model: string
}

/** Thrown when an insert/update collides with the active (provider, model) unique index. */
export class LlmPriceConflictError extends Error {
  constructor(message = 'an enabled price for this provider/model already exists') {
    super(message)
    this.name = 'LlmPriceConflictError'
  }
}

const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    String((error as { code?: unknown }).code || '') === PG_UNIQUE_VIOLATION
  )
}

const priceField = z
  .number({ message: 'must be a number' })
  .finite('must be finite')
  .min(0, 'must be >= 0')

export const createLlmPriceSchema = z.object({
  provider: z.string().trim().min(1, 'provider is required').max(200),
  model: z.string().trim().min(1, 'model is required').max(400),
  input_token_price: priceField,
  output_token_price: priceField,
  cache_read_token_price: priceField.default(0),
  cache_write_token_price: priceField.default(0),
  currency: z.string().trim().min(1).max(16).default('USD'),
  enabled: z.boolean().default(true),
})

// Update: every field optional, but reject an empty body so PUT always changes
// something. `.strict()` keeps unknown keys out (no silent typos).
export const updateLlmPriceSchema = z
  .object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(400),
    input_token_price: priceField,
    output_token_price: priceField,
    cache_read_token_price: priceField,
    cache_write_token_price: priceField,
    currency: z.string().trim().min(1).max(16),
    enabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine(obj => Object.keys(obj).length > 0, { message: 'no fields to update' })

export type CreateLlmPriceInput = z.infer<typeof createLlmPriceSchema>
export type UpdateLlmPriceInput = z.infer<typeof updateLlmPriceSchema>

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof raw === 'bigint') return Number(raw)
  return 0
}

function toIso(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? raw : d.toISOString()
  }
  return String(raw)
}

function rowToPrice(row: Record<string, unknown>): LlmModelPrice {
  return {
    id: String(row.id),
    provider: String(row.provider),
    model: String(row.model),
    input_token_price: toNumber(row.input_token_price),
    output_token_price: toNumber(row.output_token_price),
    cache_read_token_price: toNumber(row.cache_read_token_price),
    cache_write_token_price: toNumber(row.cache_write_token_price),
    currency: String(row.currency),
    effective_from: toIso(row.effective_from),
    enabled: Boolean(row.enabled),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }
}

const PRICE_COLUMNS = `
  id, provider, model,
  input_token_price, output_token_price,
  cache_read_token_price, cache_write_token_price,
  currency, effective_from, enabled, created_at, updated_at
`

export async function listLlmPrices(db: DbClient = pool): Promise<LlmModelPrice[]> {
  const result = await db.query(
    `SELECT ${PRICE_COLUMNS}
       FROM llm_model_prices
      ORDER BY provider ASC, model ASC, enabled DESC, effective_from DESC`
  )
  return (result.rows as Record<string, unknown>[]).map(rowToPrice)
}

export async function getLlmPrice(id: string, db: DbClient = pool): Promise<LlmModelPrice | null> {
  const result = await db.query(
    `SELECT ${PRICE_COLUMNS} FROM llm_model_prices WHERE id = $1 LIMIT 1`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? rowToPrice(row) : null
}

export async function createLlmPrice(
  input: CreateLlmPriceInput,
  db: DbClient = pool
): Promise<LlmModelPrice> {
  try {
    const result = await db.query(
      `INSERT INTO llm_model_prices
         (provider, model, input_token_price, output_token_price,
          cache_read_token_price, cache_write_token_price, currency, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PRICE_COLUMNS}`,
      [
        input.provider,
        input.model,
        input.input_token_price,
        input.output_token_price,
        input.cache_read_token_price,
        input.cache_write_token_price,
        input.currency,
        input.enabled,
      ]
    )
    return rowToPrice(result.rows[0] as Record<string, unknown>)
  } catch (error) {
    if (isUniqueViolation(error)) throw new LlmPriceConflictError()
    throw error
  }
}

export async function updateLlmPrice(
  id: string,
  input: UpdateLlmPriceInput,
  db: DbClient = pool
): Promise<LlmModelPrice | null> {
  // Build the SET list dynamically from whichever fields were provided. Keys
  // come from the zod-validated, `.strict()` schema — never raw request input —
  // so this is a fixed allowlist of column names, not caller-controlled SQL.
  const columnByField: Record<keyof UpdateLlmPriceInput, string> = {
    provider: 'provider',
    model: 'model',
    input_token_price: 'input_token_price',
    output_token_price: 'output_token_price',
    cache_read_token_price: 'cache_read_token_price',
    cache_write_token_price: 'cache_write_token_price',
    currency: 'currency',
    enabled: 'enabled',
  }
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  for (const [field, column] of Object.entries(columnByField) as [
    keyof UpdateLlmPriceInput,
    string,
  ][]) {
    const value = input[field]
    if (value === undefined) continue
    sets.push(`${column} = $${idx++}`)
    params.push(value)
  }
  if (sets.length === 0) return getLlmPrice(id, db)

  sets.push(`updated_at = NOW()`)
  params.push(id)

  try {
    const result = await db.query(
      `UPDATE llm_model_prices
          SET ${sets.join(', ')}
        WHERE id = $${idx}
      RETURNING ${PRICE_COLUMNS}`,
      params
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row ? rowToPrice(row) : null
  } catch (error) {
    if (isUniqueViolation(error)) throw new LlmPriceConflictError()
    throw error
  }
}

export async function deleteLlmPrice(id: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query(`DELETE FROM llm_model_prices WHERE id = $1`, [id])
  return (result.rowCount ?? 0) > 0
}

/**
 * Distinct (provider, model) pairs that appear in usage but have no `enabled`
 * price row — feeds the "unpriced surfacing" of §6.1 so the admin knows which
 * models a cost-unit budget would currently under-count.
 *
 * Usage models are read from the rollup tables: `usage_daily` (infinite
 * retention) covers all historical models and `usage_5min` catches any model
 * seen only today. An anti-join against the active price index excludes priced
 * pairs.
 */
export async function listUnpricedModels(db: DbClient = pool): Promise<UnpricedModel[]> {
  const result = await db.query(
    `WITH used AS (
       SELECT DISTINCT provider, model FROM usage_daily
       UNION
       SELECT DISTINCT provider, model FROM usage_5min
     )
     SELECT u.provider, u.model
       FROM used u
      WHERE u.provider IS NOT NULL
        AND u.model IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM llm_model_prices p
           WHERE p.enabled
             AND p.provider = u.provider
             AND p.model = u.model
        )
      ORDER BY u.provider ASC, u.model ASC`
  )
  return (result.rows as Record<string, unknown>[]).map(row => ({
    provider: String(row.provider),
    model: String(row.model),
  }))
}

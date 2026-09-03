/**
 * Service layer for `llm_allowed_models` — the operator-declared allowlist of
 * usable (provider, model) pairs (spec v2 §3-R3). This is the source of truth
 * that:
 *   - control-api enforces on write (Host spec validation, promptBridge grants),
 *   - is materialized to the `clerum-llm-allowed-models` ConfigMap in the
 *     `mcp-host` namespace for the runtime consumers (mcp-host, WRC).
 *
 * Semantics are fail-closed: a model is usable only if a row exists AND
 * `enabled = true`. A provider with no enabled rows is unusable.
 *
 * Every mutation appends a row to `llm_allowed_models_audit` (who/what/when),
 * mirroring the *_audit precedent in the repo. The (provider, model) unique
 * index surfaces as `LlmAllowedModelConflictError` so routes can answer 409.
 */
import { z } from 'zod'
import type { DbClient } from '../db.js'
import { pool } from '../db.js'

/** Catalog provenance (spec 09 §2.2). 'manual' = operator/seed; 'discovery' =
 *  auto-discovered (F2). The admin API only ever creates 'manual' rows. */
export type LlmAllowedModelSource = 'manual' | 'discovery'

export type LlmAllowedModel = {
  id: string
  provider: string
  model: string
  vendor: string | null
  display_name: string | null
  context_window_tokens: number | null
  enabled: boolean
  // Catalog lifecycle (F1, spec 09 §2.2). Additive, read-only through the admin
  // surface — discovery (F2) is the only writer of `discovery`/`*_at`/`stale`.
  source: LlmAllowedModelSource
  discovered_at: string | null
  last_seen_at: string | null
  stale: boolean
  created_at: string
  updated_at: string
}

/** A single enabled model entry as materialized into the ConfigMap contract. */
export type AllowedModelEntry = {
  model: string
  displayName?: string
  contextWindowTokens?: number
  vendor?: string
}

/** Thrown when an insert/update collides with the (provider, model) unique index. */
export class LlmAllowedModelConflictError extends Error {
  constructor(message = 'a row for this provider/model already exists') {
    super(message)
    this.name = 'LlmAllowedModelConflictError'
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

// Operator-declared context window. Guard the range so a typo cannot poison the
// context-window denominator (a 0 or negative would break compaction math; an
// absurd value would mask real limits). 20M covers every shipping model with
// margin (Gemini's 2M is today's largest).
export const MAX_CONTEXT_WINDOW_TOKENS = 20_000_000

const contextWindowField = z
  .number({ message: 'must be a number' })
  .int('must be an integer')
  .min(1, 'must be >= 1')
  .max(MAX_CONTEXT_WINDOW_TOKENS, `must be <= ${MAX_CONTEXT_WINDOW_TOKENS}`)

// `provider` becomes a Kubernetes ConfigMap `data` key in the materializer, so
// it MUST be a valid K8s key AND must never be an Object.prototype key
// (`__proto__`/`constructor`/`prototype`) that could poison the grouping map or
// jam every subsequent ConfigMap write (fail-open at the runtime boundary). The
// regex requires a leading/trailing alphanumeric (rejects `__proto__`), and the
// refine rejects the remaining reserved words. `model` is NOT so constrained —
// it is only ever an array value (model ids can contain `.`, `/`, `-`).
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
const providerField = z
  .string()
  .trim()
  .min(1, 'provider is required')
  .max(200)
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
    'provider must be alphanumeric with optional dot/dash/underscore separators'
  )
  .refine(v => !RESERVED_OBJECT_KEYS.has(v), { message: 'provider name is reserved' })

export const createLlmAllowedModelSchema = z.object({
  provider: providerField,
  model: z.string().trim().min(1, 'model is required').max(400),
  vendor: z.string().trim().min(1).max(200).optional(),
  display_name: z.string().trim().min(1).max(400).optional(),
  context_window_tokens: contextWindowField.optional(),
  enabled: z.boolean().default(true),
})

// Update: every field optional, but reject an empty body so PUT always changes
// something. `.strict()` keeps unknown keys out (no silent typos). vendor,
// display_name and context_window_tokens accept null to explicitly clear them.
export const updateLlmAllowedModelSchema = z
  .object({
    provider: providerField,
    model: z.string().trim().min(1).max(400),
    vendor: z.string().trim().min(1).max(200).nullable(),
    display_name: z.string().trim().min(1).max(400).nullable(),
    context_window_tokens: contextWindowField.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine(obj => Object.keys(obj).length > 0, { message: 'no fields to update' })

export type CreateLlmAllowedModelInput = z.infer<typeof createLlmAllowedModelSchema>
export type UpdateLlmAllowedModelInput = z.infer<typeof updateLlmAllowedModelSchema>

export type LlmAllowedModelAuditAction = 'create' | 'update' | 'disable' | 'delete'

function toIso(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? raw : d.toISOString()
  }
  return String(raw)
}

function toNullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  if (typeof raw === 'bigint') return Number(raw)
  return null
}

function toNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  return String(raw)
}

function toNullableIso(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  return toIso(raw)
}

function rowToModel(row: Record<string, unknown>): LlmAllowedModel {
  return {
    id: String(row.id),
    provider: String(row.provider),
    model: String(row.model),
    vendor: toNullableString(row.vendor),
    display_name: toNullableString(row.display_name),
    context_window_tokens: toNullableNumber(row.context_window_tokens),
    enabled: Boolean(row.enabled),
    // Defensive default: any non-'discovery' value (incl. NULL/legacy) reads as
    // 'manual', matching the column DEFAULT and the CHECK constraint.
    source: row.source === 'discovery' ? 'discovery' : 'manual',
    discovered_at: toNullableIso(row.discovered_at),
    last_seen_at: toNullableIso(row.last_seen_at),
    stale: Boolean(row.stale),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }
}

const MODEL_COLUMNS = `
  id, provider, model, vendor, display_name,
  context_window_tokens, enabled, source, discovered_at, last_seen_at, stale,
  created_at, updated_at
`

async function writeAudit(
  db: DbClient,
  entry: {
    actor: string
    action: LlmAllowedModelAuditAction
    provider: string
    model: string
    detail?: unknown
  }
): Promise<void> {
  await db.query(
    `INSERT INTO llm_allowed_models_audit (actor, action, provider, model, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.actor,
      entry.action,
      entry.provider,
      entry.model,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ]
  )
}

/** All rows (enabled + disabled) so UI pickers can flag disabled entries. */
export async function listAllowedModels(db: DbClient = pool): Promise<LlmAllowedModel[]> {
  const result = await db.query(
    `SELECT ${MODEL_COLUMNS}
       FROM llm_allowed_models
      ORDER BY provider ASC, model ASC`
  )
  return (result.rows as Record<string, unknown>[]).map(rowToModel)
}

/**
 * Stale AND enabled rows — models the Fase 4 sync flagged as vanished from the
 * external catalog (`stale=true`) while leaving `enabled` intact, so they still
 * ship in the runtime allowlist ConfigMap and keep working. The operator-
 * attention feed (Fase 5) is the sole consumer: it enumerates these and reports
 * the ones still referenced as `stale_model_referenced` — an ACTIONABLE item
 * whose remedy is the impact-gated PUT that disables the model.
 *
 * The `AND enabled` filter is load-bearing for that contract. A `stale` model
 * that is ALREADY disabled but still referenced (a dangling reference left after
 * a force-disable) is NOT actionable through this feed — its suggested action
 * ("disable it") is already done — so surfacing it would make the feed never
 * converge to zero after the very action it asked for. That "disabled + still
 * referenced" state is a distinct, diagnostic-only concern (a future
 * `dangling_reference` kind, designed separately); it is not lost here — it stays
 * derivable via `computeModelImpact`. Deterministic ordering keeps the feed
 * stable across calls.
 */
export async function listStaleAllowedModels(db: DbClient = pool): Promise<LlmAllowedModel[]> {
  const result = await db.query(
    `SELECT ${MODEL_COLUMNS}
       FROM llm_allowed_models
      WHERE stale AND enabled
      ORDER BY provider ASC, model ASC`
  )
  return (result.rows as Record<string, unknown>[]).map(rowToModel)
}

export async function getAllowedModel(
  id: string,
  db: DbClient = pool
): Promise<LlmAllowedModel | null> {
  const result = await db.query(
    `SELECT ${MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 LIMIT 1`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? rowToModel(row) : null
}

export async function createAllowedModel(
  input: CreateLlmAllowedModelInput,
  actor: string,
  db: DbClient = pool
): Promise<LlmAllowedModel> {
  try {
    const result = await db.query(
      `INSERT INTO llm_allowed_models
         (provider, model, vendor, display_name, context_window_tokens, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MODEL_COLUMNS}`,
      [
        input.provider,
        input.model,
        input.vendor ?? null,
        input.display_name ?? null,
        input.context_window_tokens ?? null,
        input.enabled,
      ]
    )
    const created = rowToModel(result.rows[0] as Record<string, unknown>)
    await writeAudit(db, {
      actor,
      action: 'create',
      provider: created.provider,
      model: created.model,
      detail: input,
    })
    return created
  } catch (error) {
    if (isUniqueViolation(error)) throw new LlmAllowedModelConflictError()
    throw error
  }
}

export async function updateAllowedModel(
  id: string,
  input: UpdateLlmAllowedModelInput,
  actor: string,
  db: DbClient = pool
): Promise<LlmAllowedModel | null> {
  // Read the existing row first: we need its (provider, model) for the audit
  // row and its `enabled` to classify a disable vs a plain update.
  const existing = await getAllowedModel(id, db)
  if (!existing) return null

  // Build the SET list dynamically from whichever fields were provided. Keys
  // come from the zod-validated, `.strict()` schema — never raw request input —
  // so this is a fixed allowlist of column names, not caller-controlled SQL.
  const columnByField: Record<keyof UpdateLlmAllowedModelInput, string> = {
    provider: 'provider',
    model: 'model',
    vendor: 'vendor',
    display_name: 'display_name',
    context_window_tokens: 'context_window_tokens',
    enabled: 'enabled',
  }
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  for (const [field, column] of Object.entries(columnByField) as [
    keyof UpdateLlmAllowedModelInput,
    string,
  ][]) {
    const value = input[field]
    if (value === undefined) continue
    sets.push(`${column} = $${idx++}`)
    params.push(value)
  }
  if (sets.length === 0) return existing

  sets.push(`updated_at = NOW()`)
  params.push(id)

  let updated: LlmAllowedModel | null
  try {
    const result = await db.query(
      `UPDATE llm_allowed_models
          SET ${sets.join(', ')}
        WHERE id = $${idx}
      RETURNING ${MODEL_COLUMNS}`,
      params
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    updated = row ? rowToModel(row) : null
  } catch (error) {
    if (isUniqueViolation(error)) throw new LlmAllowedModelConflictError()
    throw error
  }
  if (!updated) return null

  const action: LlmAllowedModelAuditAction =
    input.enabled === false && existing.enabled ? 'disable' : 'update'
  await writeAudit(db, {
    actor,
    action,
    provider: updated.provider,
    model: updated.model,
    detail: input,
  })
  return updated
}

export async function deleteAllowedModel(
  id: string,
  actor: string,
  db: DbClient = pool
): Promise<boolean> {
  // Read the (provider, model) first so the audit row records what was removed;
  // a missing row is a no-op (route 404s).
  const existing = await getAllowedModel(id, db)
  if (!existing) return false
  const result = await db.query(`DELETE FROM llm_allowed_models WHERE id = $1`, [id])
  const deleted = (result.rowCount ?? 0) > 0
  if (deleted) {
    await writeAudit(db, {
      actor,
      action: 'delete',
      provider: existing.provider,
      model: existing.model,
      detail: { id },
    })
  }
  return deleted
}

/**
 * True when (provider, model) exists AND is enabled — the fail-closed gate used
 * by Host spec validation and the promptBridge grant cross-check.
 */
export async function isModelAllowed(
  provider: string,
  model: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM llm_allowed_models
      WHERE provider = $1 AND model = $2 AND enabled
      LIMIT 1`,
    [provider, model]
  )
  return result.rows.length > 0
}

/** Enabled model names for one provider (for the grant allowedModels check). */
export async function listEnabledModelNamesForProvider(
  provider: string,
  db: DbClient = pool
): Promise<string[]> {
  const result = await db.query(
    `SELECT model FROM llm_allowed_models
      WHERE provider = $1 AND enabled
      ORDER BY model ASC`,
    [provider]
  )
  return (result.rows as Record<string, unknown>[]).map(row => String(row.model))
}

/**
 * Full allowlist state for one `(provider, model)`: `{ enabled, stale }`, or
 * `null` when no row exists. Fase 6 (soft quarantine of `stale` models) reads
 * this on the operator write path so the gate can WARN — never block — when an
 * `enabled` but `stale` model (vanished from the external catalog, Fase 4) is
 * assigned to something NEW. `isModelAllowed` stays the boolean fail-closed gate
 * (unchanged callers, unchanged semantics); this is strictly additive.
 */
export async function getModelAllowlistState(
  provider: string,
  model: string,
  db: DbClient = pool
): Promise<{ enabled: boolean; stale: boolean } | null> {
  const result = await db.query(
    `SELECT enabled, stale FROM llm_allowed_models
      WHERE provider = $1 AND model = $2
      LIMIT 1`,
    [provider, model]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return { enabled: Boolean(row.enabled), stale: Boolean(row.stale) }
}

/**
 * Enabled model names for one provider WITH their `stale` flag (Fase 6 grant
 * gate). Same `enabled`-only filter as `listEnabledModelNamesForProvider`; adds
 * `stale` so the grant write gate can warn on a NEW assignment of an enabled-but-
 * stale model without a second round-trip. A `stale` model is still `enabled`, so
 * it still appears here — quarantine is a warning, not a de-listing (R3.7).
 */
export async function listEnabledModelsWithStaleForProvider(
  provider: string,
  db: DbClient = pool
): Promise<Array<{ model: string; stale: boolean }>> {
  const result = await db.query(
    `SELECT model, stale FROM llm_allowed_models
      WHERE provider = $1 AND enabled
      ORDER BY model ASC`,
    [provider]
  )
  return (result.rows as Record<string, unknown>[]).map(row => ({
    model: String(row.model),
    stale: Boolean(row.stale),
  }))
}

/**
 * Enabled rows grouped by provider, shaped for the ConfigMap materializer.
 * Only providers with at least one enabled row appear. Deterministic ordering
 * (provider then model) keeps the materialized content hash stable.
 */
export async function listEnabledGroupedByProvider(
  db: DbClient = pool
): Promise<Record<string, AllowedModelEntry[]>> {
  const result = await db.query(
    `SELECT provider, model, vendor, display_name, context_window_tokens
       FROM llm_allowed_models
      WHERE enabled
        AND NOT (provider = 'codex-subscription' AND stale)
      ORDER BY provider ASC, model ASC`
  )
  // Null-prototype map so a stray/legacy `provider` value equal to an
  // Object.prototype key (`__proto__`/`constructor`/`prototype`) can never
  // resolve to an inherited member and break the `??=` grouping. New rows are
  // already rejected at write time (providerField), but seed/legacy data reads
  // through here too.
  const grouped: Record<string, AllowedModelEntry[]> = Object.create(null)
  for (const raw of result.rows as Record<string, unknown>[]) {
    const provider = String(raw.provider)
    const entry: AllowedModelEntry = { model: String(raw.model) }
    const displayName = toNullableString(raw.display_name)
    if (displayName) entry.displayName = displayName
    const contextWindow = toNullableNumber(raw.context_window_tokens)
    if (contextWindow !== null) entry.contextWindowTokens = contextWindow
    const vendor = toNullableString(raw.vendor)
    if (vendor) entry.vendor = vendor
    ;(grouped[provider] ??= []).push(entry)
  }
  return grouped
}

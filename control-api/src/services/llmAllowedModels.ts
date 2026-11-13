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
import {
  type ImageInputCapability,
  normalizeImageInputCapability,
  parseImageInputCapability,
} from '@clerum/llm-providers'
import type { DbClient, DbTransactionClient } from '../db.js'
import { pool } from '../db.js'
import { PROVIDER_KEY_MAP } from './modelsDevClient.js'

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
  /**
   * When the catalog sync's prune turned this row off for having no consumers;
   * null otherwise. Cleared when the row is re-enabled, renamed, or an operator
   * PUT takes authority over `enabled` (changing it or sending `pinEnabled`), so
   * a non-null value always means "off because of the catalog, still the
   * catalog's to turn back on".
   */
  auto_disabled_at: string | null
  /**
   * Model-level image-input capability + evidence (#654). ALWAYS normalized
   * through the shared contract: a NULL/malformed stored value reads as
   * `{ state: 'unknown' }`, never as affirmative support.
   */
  image_input: ImageInputCapability
  created_at: string
  updated_at: string
}

/** A single enabled model entry as materialized into the ConfigMap contract. */
export type AllowedModelEntry = {
  model: string
  displayName?: string
  contextWindowTokens?: number
  vendor?: string
  /**
   * Capability metadata for the runtime guard (#654). OMITTED when the row has
   * no stored metadata — consumers must treat absence as `{ state: 'unknown' }`
   * (the shared `normalizeImageInputCapability` does exactly that), which keeps
   * the ConfigMap byte-identical for allowlists that predate the field.
   */
  imageInput?: ImageInputCapability
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

// Image-input capability (#654). Shape validity is owned by the SHARED contract
// (`parseImageInputCapability`), not by a second zod transcription: strict keys,
// the state enum, ISO-8601 UTC dates, and the rule that a supported/unsupported
// claim must carry evidence (plus `validUntil` when discovery-sourced) are all
// enforced there, so admin writes and runtime reads cannot drift apart.
//
// `.refine` narrows the unknown input to the parsed shape; a valid input is
// already key-complete and type-checked, so no transform is needed. The field is
// `.nullable()` on the UPDATE schema (null = explicit clear) and `.optional()`
// on both (absent = leave as-is / no evidence).
const IMAGE_INPUT_HINT =
  'image_input must be { state: "supported" | "unsupported" | "unknown", evidence?: ' +
  '{ source: "curated" | "discovery", reference: <public https URL or evidence:<id>>, ' +
  'checkedAt: <ISO-8601 UTC timestamp>, validUntil?: <later ISO-8601 UTC timestamp> } }. ' +
  'A supported/unsupported state requires evidence, and a discovery-sourced ' +
  'supported/unsupported state requires validUntil.'

const imageInputField = z
  .unknown()
  .refine((value): value is ImageInputCapability => parseImageInputCapability(value) !== null, {
    message: IMAGE_INPUT_HINT,
  })

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
  image_input: imageInputField.optional(),
  enabled: z.boolean().default(true),
})

// Update: every field optional, but reject an empty body so PUT always changes
// something. `.strict()` keeps unknown keys out (no silent typos). vendor,
// display_name and context_window_tokens accept null to explicitly clear them.
//
// `pinEnabled` is not a column: it makes the operator the authority over
// `enabled` even when the value sent equals the stored one (keeping a stale
// model on, or keeping a pruned one off). It is only accepted together with
// `enabled`, so a pin always fixes a value the operator chose, never one the
// catalog sync wrote between the page load and the click.
export const updateLlmAllowedModelSchema = z
  .object({
    provider: providerField,
    model: z.string().trim().min(1).max(400),
    vendor: z.string().trim().min(1).max(200).nullable(),
    display_name: z.string().trim().min(1).max(400).nullable(),
    context_window_tokens: contextWindowField.nullable(),
    image_input: imageInputField.nullable(),
    enabled: z.boolean(),
    pinEnabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine(obj => Object.keys(obj).length > 0, { message: 'no fields to update' })
  .refine(obj => obj.pinEnabled === undefined || obj.enabled !== undefined, {
    message: 'pinEnabled requires enabled',
    path: ['pinEnabled'],
  })

export type CreateLlmAllowedModelInput = z.infer<typeof createLlmAllowedModelSchema>
export type UpdateLlmAllowedModelInput = z.infer<typeof updateLlmAllowedModelSchema>

export type LlmAllowedModelAuditAction =
  | 'create'
  | 'update'
  | 'disable'
  | 'delete'
  | 'auto_disable'
  | 'auto_enable'
  | 'attention_ack'
  | 'attention_unack'

/**
 * Canonical storage form for the capability column. `unknown` WITHOUT evidence
 * is "no evidence", which the column already represents as NULL: the admin API
 * always reads a row back normalized (a legacy row reads as `{ state: 'unknown' }`),
 * so an unchanged round-trip must not turn into a stored value and change the
 * materialized ConfigMap. Anything validated by `imageInputField` is stored
 * verbatim as canonical JSON text for the `jsonb` column.
 */
function imageInputToColumn(value: ImageInputCapability | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value.state === 'unknown' && value.evidence === undefined) return null
  return JSON.stringify(value)
}

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
    auto_disabled_at: toNullableIso(row.auto_disabled_at),
    // NULL / malformed / legacy → `{ state: 'unknown' }` (never affirmative).
    image_input: normalizeImageInputCapability(row.image_input),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }
}

const MODEL_COLUMNS = `
  id, provider, model, vendor, display_name,
  context_window_tokens, enabled, source, discovered_at, last_seen_at, stale,
  auto_disabled_at, image_input, created_at, updated_at
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

/** The audit actor of every `enabled` change the catalog sync makes on its own. */
export const CATALOG_SYNC_AUDIT_ACTOR = 'system:catalog-sync'

/**
 * Audit row for an `enabled` change the catalog sync decided (the prune turning
 * a model off, or the sync turning a pruned one back on). Written in the same
 * transaction as the change, and only when the change's UPDATE reported the row,
 * so a run that lost a race leaves no trace of something it did not do.
 */
export async function writeCatalogSyncAudit(
  db: DbClient,
  entry: { action: 'auto_disable' | 'auto_enable'; provider: string; model: string }
): Promise<void> {
  await writeAudit(db, { actor: CATALOG_SYNC_AUDIT_ACTOR, ...entry })
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
 * Providers fed by the public models.dev catalog. The subscription providers
 * keep their own catalogs and their own `stale` semantics, so catalog-only
 * rules (deprecation, the all-models Host consumer) are scoped to these.
 */
export const CATALOG_PROVIDERS: readonly string[] = Object.keys(PROVIDER_KEY_MAP)

/**
 * An enabled row the attention feed has to look at: it is `stale` (any
 * provider), or the catalog calls it deprecated (catalog providers only). The
 * feed decides from its consumers and acknowledgements whether it becomes an
 * item. Disabled rows never reach the feed: the action every item suggests,
 * disabling the model, is already done for them.
 */
export interface AttentionCandidateRow {
  provider: string
  model: string
  display_name: string | null
  stale: boolean
  deprecated: boolean
  /** Episode counters kept by the 0140 trigger; `integer`, so node-pg returns numbers. */
  stale_episode: number
  deprecated_episode: number
  /** Raw `attention_ack` jsonb; the feed parses it defensively. */
  attention_ack: unknown
}

// A non-integer here means the column type drifted (a `bigint` comes back as a
// string, a timestamp as a Date): every acknowledgement would silently stop
// matching, so the feed fails instead of hiding the drift.
function episodeCounter(raw: unknown, column: string): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw
  throw new Error(`llm_allowed_models.${column} is not an integer counter`)
}

export async function listAttentionCandidates(
  db: DbClient = pool
): Promise<AttentionCandidateRow[]> {
  const result = await db.query(
    `SELECT provider, model, display_name, stale,
            (catalog_status = 'deprecated' AND provider = ANY($1::text[])) IS TRUE AS deprecated,
            stale_episode, deprecated_episode, attention_ack
       FROM llm_allowed_models
      WHERE enabled
        AND (stale OR (catalog_status = 'deprecated' AND provider = ANY($1::text[])))
      ORDER BY provider ASC, model ASC`,
    [CATALOG_PROVIDERS]
  )
  return (result.rows as Record<string, unknown>[]).map(row => ({
    provider: String(row.provider),
    model: String(row.model),
    display_name: toNullableString(row.display_name),
    stale: row.stale === true,
    deprecated: row.deprecated === true,
    stale_episode: episodeCounter(row.stale_episode, 'stale_episode'),
    deprecated_episode: episodeCounter(row.deprecated_episode, 'deprecated_episode'),
    attention_ack: row.attention_ack ?? null,
  }))
}

/**
 * The attention kinds an operator can acknowledge, each with the episode
 * counter its acknowledgement is bound to. Closed on purpose: the column name
 * is interpolated into SQL, so it only ever comes from this map.
 */
export const ATTENTION_ACK_EPISODE_COLUMN = {
  stale_model_referenced: 'stale_episode',
  deprecated_model_enabled: 'deprecated_episode',
} as const

export type AckableAttentionKind = keyof typeof ATTENTION_ACK_EPISODE_COLUMN

const ACKABLE_KINDS = Object.keys(ATTENTION_ACK_EPISODE_COLUMN) as [
  AckableAttentionKind,
  ...AckableAttentionKind[],
]

// Bounds: a key is `host:<ns>/<name>`, `grant:<uuid>` or `recipe:<ns>/<name>`
// (namespace ≤ 63, name ≤ 253), and one model is never referenced by more
// consumers than an admin can review.
export const MAX_ATTENTION_CONSUMER_KEYS = 2_000
const MAX_ATTENTION_CONSUMER_KEY_LENGTH = 400
// int4 upper bound: the episode columns are `integer`.
const MAX_EPISODE = 2_147_483_647

const attentionPairShape = {
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(400),
  kind: z.enum(ACKABLE_KINDS),
}

export const attentionAckSchema = z
  .object({
    ...attentionPairShape,
    episode: z.number().int().min(0).max(MAX_EPISODE),
    consumerKeys: z
      .array(z.string().min(1).max(MAX_ATTENTION_CONSUMER_KEY_LENGTH))
      .max(MAX_ATTENTION_CONSUMER_KEYS),
  })
  .strict()

export const attentionUnackSchema = z.object(attentionPairShape).strict()

export type AttentionAckInput = z.infer<typeof attentionAckSchema>
export type AttentionUnackInput = z.infer<typeof attentionUnackSchema>

/** One stored acknowledgement, as kept under its kind in `attention_ack`. */
export interface AttentionAckEntry {
  episode: number
  consumerKeys: string[]
  at: string
  by: string
}

/**
 * Record that the operator reviewed an attention item. Stores the consumer keys
 * the CLIENT saw, not the current consumers: one that appeared between the feed
 * and the click must reopen the item, not be accepted unseen. Returns null when
 * the row is gone, disabled, or in another episode (the caller answers 409).
 */
export async function acknowledgeAttention(
  input: AttentionAckInput,
  actor: string,
  db: DbTransactionClient
): Promise<AttentionAckEntry | null> {
  const column = ATTENTION_ACK_EPISODE_COLUMN[input.kind]
  const entry: AttentionAckEntry = {
    episode: input.episode,
    consumerKeys: [...new Set(input.consumerKeys)].sort(),
    at: new Date().toISOString(),
    by: actor,
  }
  const result = await db.query(
    `UPDATE llm_allowed_models
        SET attention_ack = jsonb_set(coalesce(attention_ack, '{}'::jsonb), ARRAY[$3::text], $4::jsonb)
      WHERE provider = $1 AND model = $2 AND enabled
        AND ${column} = $5::int`,
    [input.provider, input.model, input.kind, JSON.stringify(entry), input.episode]
  )
  if (result.rowCount !== 1) return null
  await writeAudit(db, {
    actor,
    action: 'attention_ack',
    provider: input.provider,
    model: input.model,
    detail: { kind: input.kind, episode: entry.episode, consumerKeys: entry.consumerKeys },
  })
  return entry
}

/**
 * Drop an acknowledgement so its item is pending again. Idempotent: nothing to
 * drop is not an error. Returns whether an entry was removed (and audited).
 */
export async function unacknowledgeAttention(
  input: AttentionUnackInput,
  actor: string,
  db: DbTransactionClient
): Promise<boolean> {
  const result = await db.query(
    `UPDATE llm_allowed_models
        SET attention_ack = attention_ack - $3::text
      WHERE provider = $1 AND model = $2 AND attention_ack ? $3::text`,
    [input.provider, input.model, input.kind]
  )
  if (result.rowCount !== 1) return false
  await writeAudit(db, {
    actor,
    action: 'attention_unack',
    provider: input.provider,
    model: input.model,
    detail: { kind: input.kind },
  })
  return true
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
         (provider, model, vendor, display_name, context_window_tokens, image_input, enabled)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING ${MODEL_COLUMNS}`,
      [
        input.provider,
        input.model,
        input.vendor ?? null,
        input.display_name ?? null,
        input.context_window_tokens ?? null,
        imageInputToColumn(input.image_input),
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

type ModelPair = { provider: string; model: string }

// The pair is recorded in the same transaction as the DELETE or rename that
// removed it: committed apart, a catalog sync landing between both statements
// (or a crash) would leave the pair free to be re-inserted enabled.
async function dismissCatalogPair(db: DbTransactionClient, pair: ModelPair): Promise<void> {
  await db.query(
    `INSERT INTO llm_catalog_dismissed (provider, model)
     VALUES ($1, $2)
     ON CONFLICT (provider, model) DO NOTHING`,
    [pair.provider, pair.model]
  )
}

// Requires a transaction: the rename decision and the tombstone of the old pair
// must come from the row as locked here, not from a read a concurrent rename
// can overtake.
export async function updateAllowedModel(
  id: string,
  input: UpdateLlmAllowedModelInput,
  actor: string,
  db: DbTransactionClient
): Promise<LlmAllowedModel | null> {
  // Its (provider, model) feeds the rename decision and the audit row, and its
  // `enabled` classifies a disable vs a plain update.
  const lockedResult = await db.query(
    `SELECT ${MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 FOR UPDATE`,
    [id]
  )
  const lockedRow = lockedResult.rows[0] as Record<string, unknown> | undefined
  if (!lockedRow) return null
  const existing = rowToModel(lockedRow)

  // Build the SET list dynamically from whichever fields were provided. Keys
  // come from the zod-validated, `.strict()` schema — never raw request input —
  // so this is a fixed allowlist of column names, not caller-controlled SQL.
  const columnByField: Record<Exclude<keyof UpdateLlmAllowedModelInput, 'pinEnabled'>, string> = {
    provider: 'provider',
    model: 'model',
    vendor: 'vendor',
    display_name: 'display_name',
    context_window_tokens: 'context_window_tokens',
    image_input: 'image_input',
    enabled: 'enabled',
  }
  // Evidence belongs to the (provider, model) pair it was checked against, so a
  // RENAME invalidates it — unless the same request carries fresh evidence for
  // the new pair. Without this, a curated `supported` for model A would silently
  // authorize images for model B after an operator renamed the row.
  const renamed =
    (input.provider !== undefined && input.provider !== existing.provider) ||
    (input.model !== undefined && input.model !== existing.model)
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  for (const [field, column] of Object.entries(columnByField) as [
    keyof typeof columnByField,
    string,
  ][]) {
    const value = input[field]
    if (value === undefined) continue
    // `image_input` is `jsonb`; cast explicitly like the repo's other jsonb
    // writes (`llmCatalogSync`, `pluginWorkloadSdkDb`) rather than relying on
    // parameter-type inference.
    sets.push(field === 'image_input' ? `${column} = $${idx++}::jsonb` : `${column} = $${idx++}`)
    params.push(field === 'image_input' ? imageInputToColumn(input.image_input) : value)
  }
  if (renamed && input.image_input === undefined) sets.push('image_input = NULL')
  // The catalog's lifecycle tag is about the old pair too.
  if (renamed) sets.push('catalog_status = NULL')
  // A renamed discovered row now names a pair the operator chose, which the
  // public catalog may not list (a Bedrock inference profile, an Azure
  // deployment): left as `discovery`, every live sync would mark it stale and
  // the attention feed would flag it forever. It becomes manual, like a pair
  // added by hand, and drops the old pair's liveness: the sync never clears
  // `stale` on a manual row. Subscription providers are left alone: their rows
  // are rebuilt from their own catalogs by provider, whatever the source.
  if (
    renamed &&
    existing.source === 'discovery' &&
    CATALOG_PROVIDERS.includes(input.provider ?? existing.provider)
  ) {
    sets.push(`source = 'manual'`, 'stale = false', 'last_seen_at = NULL')
  }
  // Authority over `enabled`, decided on the locked row: the route's earlier
  // read is unlocked, and the catalog prune or re-enable can commit in
  // between. Only a real change of the value, or an explicit pin, is an
  // operator decision. The edit form resends `enabled` unchanged with every
  // save, and that must not take the row away from the catalog. A rename
  // also hands the row to the operator and drops the prune token and the
  // acknowledgements: both belong to the old pair.
  const operatorDecidesEnabled =
    input.enabled !== undefined && (input.enabled !== existing.enabled || input.pinEnabled === true)
  if (operatorDecidesEnabled || renamed) {
    sets.push(`enabled_managed_by = 'operator'`, 'auto_disabled_at = NULL')
  }
  if (renamed) sets.push('attention_ack = NULL')
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
  if (renamed) {
    await dismissCatalogPair(db, { provider: existing.provider, model: existing.model })
  }

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

// Requires a transaction so the removal and its tombstone commit together. The
// pair comes from the DELETE itself: a pre-read could be overtaken by a
// concurrent rename and tombstone a pair that was never removed.
export async function deleteAllowedModel(
  id: string,
  actor: string,
  db: DbTransactionClient
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM llm_allowed_models WHERE id = $1 RETURNING provider, model`,
    [id]
  )
  const removed = result.rows[0] as ModelPair | undefined
  if (!removed) return false
  await dismissCatalogPair(db, removed)
  await writeAudit(db, {
    actor,
    action: 'delete',
    provider: removed.provider,
    model: removed.model,
    detail: { id },
  })
  return true
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
    `SELECT provider, model, vendor, display_name, context_window_tokens, image_input
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
    // Projected only when the row actually carries metadata: absence stays
    // absence so an allowlist without capabilities materializes byte-identically
    // to the pre-#654 ConfigMap (consumers normalize absence to `unknown`).
    if (raw.image_input !== null && raw.image_input !== undefined) {
      entry.imageInput = normalizeImageInputCapability(raw.image_input)
    }
    ;(grouped[provider] ??= []).push(entry)
  }
  return grouped
}

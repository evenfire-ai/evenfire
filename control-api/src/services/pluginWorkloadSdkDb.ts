import { createHash } from 'node:crypto'
import { pool } from '../db.js'
import { stableStringify } from '../utils/stableStringify.js'

// ─── Plugin Workload SDK — DB layer ──────────────────────────────────────
// Extracted from db.ts (per plan: avoid growing the migration monolith).
// Owns the three SDK tables:
//   - plugin_workload_sdk_grants          per-recipe capability grants
//   - plugin_workload_sdk_invocations     invocation audit trail
//   - plugin_workload_sdk_quota_counters  per-recipe+period quota tracking

export const PLUGIN_WORKLOAD_SDK_FAMILIES = ['promptBridge', 'clientNotifications'] as const
export type PluginWorkloadSdkFamily = (typeof PLUGIN_WORKLOAD_SDK_FAMILIES)[number]

export const PLUGIN_WORKLOAD_SDK_INVOCATION_STATUSES = [
  'in_progress',
  'complete',
  'failed',
  'provider_unavailable',
  'accepted',
  'delivered',
] as const
export type PluginWorkloadSdkInvocationStatus =
  (typeof PLUGIN_WORKLOAD_SDK_INVOCATION_STATUSES)[number]

/** Structured authorization error codes (spec §15). */
export const PLUGIN_WORKLOAD_SDK_ERROR_CODES = [
  'capability_not_declared',
  'caller_not_allowed',
  'scope_denied',
  'target_not_allowed',
  'event_type_not_allowed',
  'quota_exceeded',
  'provider_policy_denied',
  'payload_too_large',
  'idempotency_conflict',
  'recipe_binding_mismatch',
] as const
export type PluginWorkloadSdkErrorCode = (typeof PLUGIN_WORKLOAD_SDK_ERROR_CODES)[number]

/**
 * v1 allowlisted purpose enum for promptBridge requests (spec §9). A purpose
 * outside this list is rejected at input validation, before authorization.
 */
export const PLUGIN_WORKLOAD_SDK_PURPOSES = [
  'summarization',
  'classification',
  'extraction',
  'generation',
  'translation',
  'question_answering',
  'analysis',
] as const
export type PluginWorkloadSdkPurpose = (typeof PLUGIN_WORKLOAD_SDK_PURPOSES)[number]

// ─── Input validation defaults (plan §2.7) ──────────────────────────────
export const DEFAULT_MAX_REQUEST_CONTENT_BYTES = 128 * 1024
export const DEFAULT_MAX_TITLE_BYTES = 256
export const DEFAULT_MAX_BODY_BYTES = 4096
export const DEFAULT_IDEMPOTENCY_KEY_PATTERN = '^[a-zA-Z0-9_-]{1,128}$'
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128
export const MAX_TARGET_REF_LENGTH = 256
export const MAX_USER_REF_LENGTH = 256
/** Max length for a single admin allowlist entry. */
export const MAX_ALLOWLIST_ENTRY_LENGTH = 256
export const MAX_ALLOWLIST_ITEMS = 64
/** Idempotency keys are reusable after this window (OQ-5). */
const IDEMPOTENCY_TTL_HOURS = 24

export interface PluginWorkloadSdkQuotaLimits {
  maxRequestsPerRun?: number
  maxNotificationsPerRun?: number
  maxInvocationsPerMinute?: number
  maxNotificationsPerMinute?: number
  maxOutputTokens?: number
}

/**
 * Resolved model policy record (plan §2.2): a modelPolicyRef is never a
 * black box — it must resolve to a concrete record. Stored per-grant in
 * model_policies JSONB keyed by policy ref.
 */
export interface PluginWorkloadSdkModelPolicy {
  provider: string
  model: string
  temperature?: number
  maxCostUsd?: number
}

export interface PluginWorkloadSdkGrant {
  id: string
  recipeNamespace: string
  recipeName: string
  capabilityFamily: PluginWorkloadSdkFamily
  allowedModels: string[]
  allowedEventTypes: string[]
  allowedTargetRefs: string[]
  allowedUserRefs: string[]
  allowedCallers: string[]
  quotaLimits: PluginWorkloadSdkQuotaLimits
  modelPolicies: Record<string, PluginWorkloadSdkModelPolicy>
  createdAt: string
  updatedAt: string
}

export interface PluginWorkloadSdkInvocationRecord {
  id: string
  recipeNamespace: string
  recipeName: string
  callerRef: string
  correlationId: string | null
  method: PluginWorkloadSdkFamily
  /** Model name (promptBridge) or event type (clientNotifications). */
  detail: string
  purpose: string | null
  idempotencyKeyHash: string
  payloadHash: string
  status: PluginWorkloadSdkInvocationStatus
  quotaConsumed: boolean
  authorizationDecision: string
  createdAt: string
  completedAt: string | null
}

// Schema lives in pluginWorkloadSdkSchema.ts (type-only db dependency) so
// db.ts can register migration 0027 without a runtime import cycle.
export { applyPluginWorkloadSdkSchema } from './pluginWorkloadSdkSchema.js'

// ─── Hashing helpers ─────────────────────────────────────────────────────

/** SHA-256 of the raw idempotency key — never store the raw key (spec §16). */
export function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex')
}

/**
 * Deterministic payload hash for idempotency conflict detection. Uses
 * stableStringify (lexicographic key order at every depth) so semantically
 * equivalent JSON with different key ordering produces the same hash —
 * consistent with RFC 8785 JCS for the JSON subset we accept.
 */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

// ─── Row mapping ─────────────────────────────────────────────────────────

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function mapGrantRow(row: Record<string, unknown>): PluginWorkloadSdkGrant {
  const family = row.capability_family
  if (!PLUGIN_WORKLOAD_SDK_FAMILIES.includes(family as PluginWorkloadSdkFamily)) {
    throw new Error(`unknown capability_family from db: ${String(family)}`)
  }
  const quotaLimitsRaw = row.quota_limits
  const quotaLimits: PluginWorkloadSdkQuotaLimits =
    typeof quotaLimitsRaw === 'object' && quotaLimitsRaw !== null
      ? (quotaLimitsRaw as PluginWorkloadSdkQuotaLimits)
      : {}
  const modelPoliciesRaw = row.model_policies
  const modelPolicies: Record<string, PluginWorkloadSdkModelPolicy> =
    typeof modelPoliciesRaw === 'object' && modelPoliciesRaw !== null
      ? (modelPoliciesRaw as Record<string, PluginWorkloadSdkModelPolicy>)
      : {}
  return {
    id: String(row.id),
    recipeNamespace: String(row.recipe_namespace),
    recipeName: String(row.recipe_name),
    capabilityFamily: family as PluginWorkloadSdkFamily,
    allowedModels: stringArray(row.allowed_models),
    allowedEventTypes: stringArray(row.allowed_event_types),
    allowedTargetRefs: stringArray(row.allowed_target_refs),
    allowedUserRefs: stringArray(row.allowed_user_refs),
    allowedCallers: stringArray(row.allowed_callers),
    quotaLimits,
    modelPolicies,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }
}

function mapInvocationRow(row: Record<string, unknown>): PluginWorkloadSdkInvocationRecord {
  return {
    id: String(row.id),
    recipeNamespace: String(row.recipe_namespace),
    recipeName: String(row.recipe_name),
    callerRef: String(row.caller_ref),
    correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    method: row.method as PluginWorkloadSdkFamily,
    detail: String(row.detail),
    purpose: row.purpose === null ? null : String(row.purpose),
    idempotencyKeyHash: String(row.idempotency_key_hash),
    payloadHash: String(row.payload_hash),
    status: row.status as PluginWorkloadSdkInvocationStatus,
    quotaConsumed: row.quota_consumed === true,
    authorizationDecision: String(row.authorization_decision),
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt:
      row.completed_at === null ? null : new Date(row.completed_at as string).toISOString(),
  }
}

// ─── Grants ──────────────────────────────────────────────────────────────

export async function findGrant(
  recipeNamespace: string,
  recipeName: string,
  capabilityFamily: PluginWorkloadSdkFamily
): Promise<PluginWorkloadSdkGrant | null> {
  const result = await pool.query(
    `SELECT * FROM plugin_workload_sdk_grants
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND capability_family = $3`,
    [recipeNamespace, recipeName, capabilityFamily]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapGrantRow(row) : null
}

export interface UpsertGrantParams {
  recipeNamespace: string
  recipeName: string
  capabilityFamily: PluginWorkloadSdkFamily
  allowedModels?: string[]
  allowedEventTypes?: string[]
  allowedTargetRefs?: string[]
  allowedUserRefs?: string[]
  allowedCallers?: string[]
  quotaLimits?: PluginWorkloadSdkQuotaLimits
  modelPolicies?: Record<string, PluginWorkloadSdkModelPolicy>
}

export async function upsertGrant(params: UpsertGrantParams): Promise<PluginWorkloadSdkGrant> {
  const result = await pool.query(
    `INSERT INTO plugin_workload_sdk_grants
       (recipe_namespace, recipe_name, capability_family, allowed_models, allowed_event_types,
        allowed_target_refs, allowed_user_refs, allowed_callers, quota_limits, model_policies)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
     ON CONFLICT (recipe_namespace, recipe_name, capability_family)
     DO UPDATE SET
       allowed_models = EXCLUDED.allowed_models,
       allowed_event_types = EXCLUDED.allowed_event_types,
       allowed_target_refs = EXCLUDED.allowed_target_refs,
       allowed_user_refs = EXCLUDED.allowed_user_refs,
       allowed_callers = EXCLUDED.allowed_callers,
       quota_limits = EXCLUDED.quota_limits,
       model_policies = EXCLUDED.model_policies,
       updated_at = now()
     RETURNING *`,
    [
      params.recipeNamespace,
      params.recipeName,
      params.capabilityFamily,
      JSON.stringify(params.allowedModels ?? []),
      JSON.stringify(params.allowedEventTypes ?? []),
      JSON.stringify(params.allowedTargetRefs ?? []),
      JSON.stringify(params.allowedUserRefs ?? []),
      JSON.stringify(params.allowedCallers ?? []),
      JSON.stringify(params.quotaLimits ?? {}),
      JSON.stringify(params.modelPolicies ?? {}),
    ]
  )
  return mapGrantRow(result.rows[0] as Record<string, unknown>)
}

export async function listGrants(filter?: {
  recipeNamespace?: string
  recipeName?: string
}): Promise<PluginWorkloadSdkGrant[]> {
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter?.recipeNamespace) {
    values.push(filter.recipeNamespace)
    clauses.push(`recipe_namespace = $${values.length}`)
  }
  if (filter?.recipeName) {
    values.push(filter.recipeName)
    clauses.push(`recipe_name = $${values.length}`)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const result = await pool.query(
    `SELECT * FROM plugin_workload_sdk_grants ${where}
     ORDER BY recipe_namespace, recipe_name, capability_family`,
    values
  )
  return (result.rows as Record<string, unknown>[]).map(mapGrantRow)
}

/**
 * Delete a grant by UUID, scoped to its recipe binding. The recipe_namespace
 * + recipe_name predicates prevent a UUID alone from deleting a grant that
 * belongs to a different recipe than the caller intended (defense in depth on
 * top of the admin auth gate).
 */
export async function deleteGrant(
  id: string,
  recipeNamespace: string,
  recipeName: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM plugin_workload_sdk_grants
     WHERE id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
    [id, recipeNamespace, recipeName]
  )
  return (result.rowCount ?? 0) > 0
}

// ─── Recipients (clientNotifications picker) ─────────────────────────────

/**
 * A grant's allowed userRef resolved for the picker: `userRef` is the opaque
 * UUID the notify call targets (the option value), `displayName` is the user's
 * email — the human handle shown in the dropdown.
 */
export interface PluginWorkloadSdkRecipientProfile {
  userRef: string
  displayName: string
}

/** Control-plane user UUID shape — allowedUserRefs are enforced to this at grant creation. */
const RECIPIENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a grant's allowedUserRefs (control-plane user UUIDs) to a display
 * handle for the clientNotifications recipient picker. EvenFire users are
 * identified by email — it is the unique, human-readable handle — so the picker
 * shows the email. The opaque UUID is the option VALUE the notify call needs but
 * is never surfaced as a label: a ref that no longer resolves to a user (e.g. a
 * deleted account) is dropped, not shown as a bare UUID. Input order is
 * preserved; non-UUID refs are skipped defensively (grant creation enforces UUIDs).
 */
export async function resolveRecipientProfiles(
  userRefs: string[]
): Promise<PluginWorkloadSdkRecipientProfile[]> {
  const refs = userRefs.filter(ref => RECIPIENT_UUID_RE.test(ref))
  if (refs.length === 0) return []
  const result = await pool.query(
    `SELECT u.id, u.email FROM users u WHERE u.id = ANY($1::uuid[])`,
    [refs]
  )
  const emailById = new Map<string, string>()
  for (const row of result.rows as Array<{ id: string; email: string | null }>) {
    if (row.email) emailById.set(String(row.id), String(row.email))
  }
  // Preserve input order; drop refs that no longer resolve (never show a UUID).
  return refs
    .filter(ref => emailById.has(ref))
    .map(ref => ({ userRef: ref, displayName: emailById.get(ref) as string }))
}

// ─── Invocations ─────────────────────────────────────────────────────────

export interface InsertInvocationParams {
  recipeNamespace: string
  recipeName: string
  callerRef: string
  correlationId?: string
  method: PluginWorkloadSdkFamily
  detail: string
  purpose?: string
  idempotencyKeyHash: string
  payloadHash: string
  status: PluginWorkloadSdkInvocationStatus
  authorizationDecision: string
}

export type InsertInvocationResult =
  | { kind: 'inserted'; invocation: PluginWorkloadSdkInvocationRecord }
  | { kind: 'replay'; invocation: PluginWorkloadSdkInvocationRecord }
  | { kind: 'conflict'; invocation: PluginWorkloadSdkInvocationRecord }
  // Lost the ON CONFLICT race AND the winning row vanished (pruned between the
  // INSERT and the fallback SELECT). A structured signal — NOT an opaque throw
  // — so the caller maps it to a deterministic idempotency_conflict (409-style)
  // deny instead of a 500. The caller can safely retry with a fresh key.
  | { kind: 'race_unresolved' }

/**
 * Insert an invocation with idempotency semantics: same key + same payload
 * hash → replay (existing record returned); same key + different payload
 * hash → conflict (spec §15 idempotency_conflict).
 */
export async function insertInvocation(
  params: InsertInvocationParams
): Promise<InsertInvocationResult> {
  const inserted = await pool.query(
    `INSERT INTO plugin_workload_sdk_invocations
       (recipe_namespace, recipe_name, caller_ref, correlation_id, method, detail, purpose,
        idempotency_key_hash, payload_hash, status, authorization_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (recipe_namespace, recipe_name, method, idempotency_key_hash) DO NOTHING
     RETURNING *`,
    [
      params.recipeNamespace,
      params.recipeName,
      params.callerRef,
      params.correlationId ?? null,
      params.method,
      params.detail,
      params.purpose ?? null,
      params.idempotencyKeyHash,
      params.payloadHash,
      params.status,
      params.authorizationDecision,
    ]
  )
  const insertedRow = inserted.rows[0] as Record<string, unknown> | undefined
  if (insertedRow) {
    return { kind: 'inserted', invocation: mapInvocationRow(insertedRow) }
  }

  const existing = await pool.query(
    `SELECT * FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND method = $3 AND idempotency_key_hash = $4`,
    [params.recipeNamespace, params.recipeName, params.method, params.idempotencyKeyHash]
  )
  const existingRow = existing.rows[0] as Record<string, unknown> | undefined
  if (!existingRow) {
    // Lost the race AND the winner vanished (pruned between statements) —
    // surface a structured signal so the caller returns a deterministic
    // idempotency_conflict (NOT a 500) and the workload retries with a fresh key.
    return { kind: 'race_unresolved' }
  }
  const invocation = mapInvocationRow(existingRow)
  return invocation.payloadHash === params.payloadHash
    ? { kind: 'replay', invocation }
    : { kind: 'conflict', invocation }
}

export async function getInvocationById(
  id: string
): Promise<PluginWorkloadSdkInvocationRecord | null> {
  const result = await pool.query(`SELECT * FROM plugin_workload_sdk_invocations WHERE id = $1`, [
    id,
  ])
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapInvocationRow(row) : null
}

export async function updateInvocationStatus(
  id: string,
  status: PluginWorkloadSdkInvocationStatus,
  opts: {
    completed?: boolean
    recipeNamespace?: string
    recipeName?: string
    /**
     * Optimistic-concurrency guard: when set, the UPDATE only applies if the
     * row is currently in this status. Used to transition accepted → delivered
     * exactly once without clobbering a terminal 'failed'.
     */
    expectedCurrentStatus?: PluginWorkloadSdkInvocationStatus
  } = {}
): Promise<boolean> {
  const values: unknown[] = [id, status, opts.completed ?? false]
  let bindingClause = ''
  if (opts.recipeNamespace !== undefined && opts.recipeName !== undefined) {
    values.push(opts.recipeNamespace, opts.recipeName)
    bindingClause = ` AND recipe_namespace = $${values.length - 1} AND recipe_name = $${values.length}`
  }
  let statusGuardClause = ''
  if (opts.expectedCurrentStatus !== undefined) {
    values.push(opts.expectedCurrentStatus)
    statusGuardClause = ` AND status = $${values.length}`
  }
  const result = await pool.query(
    `UPDATE plugin_workload_sdk_invocations
     SET status = $2,
         completed_at = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1${bindingClause}${statusGuardClause}`,
    values
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Mark stale in_progress invocations as failed (mcp-host restart recovery —
 * plan §2.4). Returns the number of rows transitioned.
 */
export async function failStaleInvocations(olderThanSeconds: number): Promise<number> {
  const result = await pool.query(
    `UPDATE plugin_workload_sdk_invocations
     SET status = 'failed', completed_at = now()
     WHERE status = 'in_progress' AND created_at < now() - interval '1 second' * $1`,
    [olderThanSeconds]
  )
  return result.rowCount ?? 0
}

export interface ListInvocationsFilter {
  recipeNamespace?: string
  recipeName?: string
  method?: PluginWorkloadSdkFamily
  status?: PluginWorkloadSdkInvocationStatus
  since?: string
  until?: string
  limit?: number
}

export async function listInvocations(
  filter: ListInvocationsFilter
): Promise<PluginWorkloadSdkInvocationRecord[]> {
  const clauses: string[] = []
  const values: unknown[] = []
  const push = (clause: string, value: unknown) => {
    values.push(value)
    clauses.push(clause.replace('?', `$${values.length}`))
  }
  if (filter.recipeNamespace) push('recipe_namespace = ?', filter.recipeNamespace)
  if (filter.recipeName) push('recipe_name = ?', filter.recipeName)
  if (filter.method) push('method = ?', filter.method)
  if (filter.status) push('status = ?', filter.status)
  if (filter.since) push('created_at >= ?', filter.since)
  if (filter.until) push('created_at <= ?', filter.until)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  values.push(limit)
  const result = await pool.query(
    `SELECT * FROM plugin_workload_sdk_invocations ${where}
     ORDER BY created_at DESC LIMIT $${values.length}`,
    values
  )
  return (result.rows as Record<string, unknown>[]).map(mapInvocationRow)
}

/**
 * Prune invocation rows past the idempotency TTL (OQ-5): after 24h the same
 * idempotency key becomes reusable (new invocation period). Only terminal
 * rows are pruned — an in_progress row past TTL is first failed by
 * failStaleInvocations.
 */
export async function prunePluginWorkloadSdkExpiredIdempotency(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM plugin_workload_sdk_invocations
     WHERE created_at < now() - interval '1 hour' * $1
       AND status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  return result.rowCount ?? 0
}

// ─── Quota counters ──────────────────────────────────────────────────────

/** Sentinel period for eager SDK traffic before any workflow run exists. */
export const PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD = new Date(0)

/**
 * Resolve the quota counter bucket for per-run limits. Uses the active
 * workflow run's start time when one exists; otherwise the eager sentinel.
 *
 * When a run is created concurrently with the first SDK call, the run row may
 * not be visible yet — callers fall back to the eager sentinel until the next
 * attempt sees the committed run.
 */
export async function resolveQuotaPeriodStart(
  recipeNamespace: string,
  recipeName: string
): Promise<Date> {
  const result = await pool.query(
    `SELECT COALESCE(started_at, created_at) AS period_start
     FROM workflow_runs
     WHERE recipe_namespace = $1
       AND recipe_name = $2
       AND phase NOT IN ('Succeeded', 'Failed', 'Canceled')
     ORDER BY COALESCE(started_at, created_at) DESC
     LIMIT 1`,
    [recipeNamespace, recipeName]
  )
  const row = result.rows[0] as { period_start?: Date | string } | undefined
  if (!row?.period_start) return PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD
  return new Date(row.period_start)
}

export interface QuotaCounterRow {
  recipeNamespace: string
  recipeName: string
  periodStart: string
  promptBridgeCount: number
  notificationCount: number
  lastUpdated: string
}

export async function getQuotaCounters(
  recipeNamespace: string,
  recipeName: string
): Promise<QuotaCounterRow[]> {
  const result = await pool.query(
    `SELECT * FROM plugin_workload_sdk_quota_counters
     WHERE recipe_namespace = $1 AND recipe_name = $2
     ORDER BY period_start DESC LIMIT 30`,
    [recipeNamespace, recipeName]
  )
  return (result.rows as Record<string, unknown>[]).map(row => ({
    recipeNamespace: String(row.recipe_namespace),
    recipeName: String(row.recipe_name),
    periodStart: new Date(row.period_start as string).toISOString(),
    promptBridgeCount: Number(row.prompt_bridge_count),
    notificationCount: Number(row.notification_count),
    lastUpdated: new Date(row.last_updated as string).toISOString(),
  }))
}

export async function getPeriodQuotaUsage(
  recipeNamespace: string,
  recipeName: string,
  family: PluginWorkloadSdkFamily,
  periodStart: Date
): Promise<number> {
  const column = family === 'promptBridge' ? 'prompt_bridge_count' : 'notification_count'
  const result = await pool.query(
    `SELECT ${column} AS usage_count
     FROM plugin_workload_sdk_quota_counters
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND period_start = $3`,
    [recipeNamespace, recipeName, periodStart]
  )
  const row = result.rows[0] as { usage_count?: number | string } | undefined
  return Number(row?.usage_count ?? 0)
}

/**
 * Atomically consume one unit of period quota. The conditional UPDATE only
 * increments while the post-increment count stays within `limit`, so two
 * concurrent calls can never both pass a remaining-1 budget.
 *
 * `foldEagerUsage` (default `false`) folds the eager-sentinel usage into the
 * same atomic conditional — when set, the run-period decision becomes
 * `runCount + 1 + eagerUsage <= limit`, where `eagerUsage` is the count
 * already booked under the eager sentinel period
 * (`PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD`). That eager usage is read with a
 * correlated subquery INSIDE the same conditional-upsert statement, so there
 * is no TOCTOU window: two concurrent run-period consumers can never both pass
 * a budget the eager usage already exhausted.
 *
 * The eager-period `$6` bind is appended to the parameter array ONLY when
 * `foldEagerUsage` is `true`. When it is `false` the eager-usage SQL fragment
 * is the literal `'0'` and never references `$6`, so binding it would raise a
 * parameter-count mismatch; the conditional bind keeps both paths valid.
 *
 * Returns false when the limit is hit (caller maps to quota_exceeded,
 * retryable=false).
 */
export async function consumePeriodQuota(
  recipeNamespace: string,
  recipeName: string,
  family: PluginWorkloadSdkFamily,
  limit: number,
  periodStart: Date = PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD,
  foldEagerUsage = false
): Promise<boolean> {
  const column = family === 'promptBridge' ? 'prompt_bridge_count' : 'notification_count'
  // When `foldEagerUsage` is set, the run-period decision must account for
  // usage already booked under the eager sentinel (so the run cap isn't
  // doubled). We read that eager usage with a correlated subquery INSIDE the
  // same conditional-upsert statement, eliminating the read-then-consume
  // TOCTOU: two concurrent run-period consumers evaluate the gate against the
  // committed counter row under the ON CONFLICT row lock, so they cannot both
  // pass a budget the eager usage already exhausted.
  const eagerUsageExpr = foldEagerUsage
    ? `COALESCE((
        SELECT eager.${column}
          FROM plugin_workload_sdk_quota_counters eager
         WHERE eager.recipe_namespace = $1
           AND eager.recipe_name = $2
           AND eager.period_start = $6
      ), 0)`
    : '0'
  // Single conditional upsert. INSERT path (fresh run period → count becomes 1)
  // is gated by the `SELECT ... WHERE`; UPDATE path (existing row) is gated by
  // the `ON CONFLICT ... WHERE` on the post-increment count. Both fold in the
  // live eager usage so the decision is atomic.
  //
  // The $6 (eager period) bind is appended ONLY when foldEagerUsage is set —
  // otherwise eagerUsageExpr is the literal '0' and the SQL never references
  // $6, so binding it would raise "bind message supplies 6 parameters, but
  // prepared statement requires 5" and break every quota consumption.
  const params: Array<string | number | Date> = [
    recipeNamespace,
    recipeName,
    periodStart,
    family,
    limit,
  ]
  if (foldEagerUsage) {
    params.push(PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD)
  }
  const result = await pool.query(
    `INSERT INTO plugin_workload_sdk_quota_counters
       (recipe_namespace, recipe_name, period_start, prompt_bridge_count, notification_count)
     SELECT $1, $2, $3,
            CASE WHEN $4 = 'promptBridge' THEN 1 ELSE 0 END,
            CASE WHEN $4 = 'clientNotifications' THEN 1 ELSE 0 END
      WHERE 1 + ${eagerUsageExpr} <= $5
     ON CONFLICT (recipe_namespace, recipe_name, period_start)
     DO UPDATE SET ${column} = plugin_workload_sdk_quota_counters.${column} + 1,
                   last_updated = now()
     WHERE plugin_workload_sdk_quota_counters.${column} + 1 + ${eagerUsageExpr} <= $5
     RETURNING ${column}`,
    params
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Per-minute rate limiting derived from the invocation audit trail itself
 * (no separate window table): counts invocations recorded in the trailing
 * 60s for the recipe+method, optionally narrowed to one detail value
 * (event type) to prevent notification spam per eventType.
 */
export async function countRecentInvocations(
  recipeNamespace: string,
  recipeName: string,
  method: PluginWorkloadSdkFamily,
  opts: { detail?: string } = {}
): Promise<number> {
  const values: unknown[] = [recipeNamespace, recipeName, method]
  let detailClause = ''
  if (opts.detail !== undefined) {
    values.push(opts.detail)
    detailClause = `AND detail = $${values.length}`
  }
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND method = $3 ${detailClause}
       AND created_at > now() - interval '1 minute'`,
    values
  )
  const row = result.rows[0] as { n?: number } | undefined
  return row?.n ?? 0
}

import { createHash, randomUUID } from 'node:crypto'
import { type DbClient, type DbTransactionClient, pool, withTransaction } from '../db.js'
import type { AdministrativeEventSubmitterPrincipalV1 } from '../middleware/tracingSubmitterAuth.js'
import { stableStringify } from '../utils/stableStringify.js'
import {
  type ControlApiPermissionChange,
  appendControlApiPermissionEventsInTransaction,
} from './tracing/controlApiPermissionEvents.js'

// ─── Plugin Workload SDK — DB layer ──────────────────────────────────────
// Extracted from db.ts (per plan: avoid growing the migration monolith).
// Owns the three SDK tables:
//   - plugin_workload_sdk_grants          per-recipe capability grants
//   - plugin_workload_sdk_invocations     invocation audit trail
//   - plugin_workload_sdk_quota_counters  historical-only counters (issue #348);
//                                         admin read path only, no writers

export const PLUGIN_WORKLOAD_SDK_FAMILIES = ['promptBridge', 'clientNotifications'] as const
export type PluginWorkloadSdkFamily = (typeof PLUGIN_WORKLOAD_SDK_FAMILIES)[number]

// ─── Grant-update NOTIFY (issue #375, P3) ────────────────────────────────
// CROSS-SERVICE CONTRACT: a transactional `pg_notify` fired inside the
// grant-mutation transactions (upsert / delete / revoke) so the Workflow
// Recipes Controller re-reconciles the affected recipe immediately (~1–5s)
// instead of waiting for its ≤30s level-triggered watchdog. The WRC LISTEN side
// lives in `workflow-recipes/src/reconciler/grantUpdateListener.ts` — the
// channel name and payload shape below MUST stay in sync with it.
//
// This is an app-level NOTIFY (not a DDL trigger) so the payload stays typed and
// the change is fully revertible. Being inside the transaction, it is delivered
// on COMMIT and discarded on ROLLBACK. Semantics are best-effort: a dropped
// notification degrades to the existing polling backstop, never worse.
export const PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL = 'plugin_workload_sdk_grant_update'

export interface GrantUpdateNotifyInput {
  recipeNamespace: string
  recipeName: string
  /** Omitted for a whole-recipe revoke that spans multiple families. */
  capabilityFamily?: string
}

/**
 * Build the JSON payload for a grant-update NOTIFY. Pure and exported so the
 * exact wire shape can be unit-tested without a live Postgres.
 */
export function buildGrantUpdateNotifyPayload(input: GrantUpdateNotifyInput): string {
  return JSON.stringify({
    recipeNamespace: input.recipeNamespace,
    recipeName: input.recipeName,
    ...(input.capabilityFamily ? { capabilityFamily: input.capabilityFamily } : {}),
  })
}

/**
 * Emit the grant-update NOTIFY on the shared channel. MUST be called with the
 * in-transaction `db` client so the signal is delivered on COMMIT (and dropped
 * on ROLLBACK), never as a separate connection.
 *
 * A `pg_notify` inside the transaction would roll the whole grant mutation back
 * if it threw — but the only failure mode is a payload over Postgres' 8000-byte
 * NOTIFY limit, and this payload is just a recipe namespace/name (+ optional
 * short family), which cannot approach that bound. So the mutation is never at
 * risk from the notify, and the transactional coupling is intentional.
 */
async function notifyGrantUpdate(
  // issue #375 M3: REQUIRES the branded transaction session — `pool` no longer
  // structurally satisfies this parameter, so the db→pool refactor that breaks
  // COMMIT/ROLLBACK coupling fails to COMPILE instead of merely failing a test.
  db: DbTransactionClient,
  input: GrantUpdateNotifyInput
): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [
    PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
    buildGrantUpdateNotifyPayload(input),
  ])
}

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
  'ambiguous_model',
  'event_type_not_allowed',
  'quota_exceeded',
  'provider_policy_denied',
  'provider_unavailable',
  'payload_too_large',
  'idempotency_conflict',
  'recipe_binding_mismatch',
  'protocol_mismatch',
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
/**
 * Maximum number of provider targets an operator may persist in one grant.
 * This is deliberately separate from the execution budget below: a policy may
 * contain a catalogue larger than a single invocation's ordered suffix.
 */
export const MAX_PROMPT_BRIDGE_TARGETS_PER_GRANT = MAX_ALLOWLIST_ITEMS
/** Hard cap for physical provider attempts in one logical invocation. */
export const MAX_PROMPT_BRIDGE_PROVIDER_ATTEMPTS = 4
/** Default lease is the prompt timeout plus a bounded recovery grace period. */
export const DEFAULT_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS = 180
const MIN_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS = 30
const MAX_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS = 3600

/** One operator-controlled lease value is shared by issuance and stale sweep. */
export function getPromptBridgeAttemptLeaseSeconds(): number {
  const raw = Number(process.env.PLUGIN_WORKLOAD_SDK_ATTEMPT_LEASE_SECONDS)
  if (!Number.isInteger(raw)) return DEFAULT_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS
  return Math.min(
    Math.max(raw, MIN_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS),
    MAX_PROMPT_BRIDGE_ATTEMPT_LEASE_SECONDS
  )
}
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

/** A single operator-authorized promptBridge attempt target. */
export interface PluginWorkloadSdkPromptTarget {
  targetRef: string
  provider: string
  model: string
  /**
   * Secret data-key identity only; never its value. Empty for oauth-broker
   * providers (Codex): no static Secret key exists for a brokered grant.
   */
  credentialSlot: string
  /**
   * Codex subscription grant (connection key) this target executes against.
   * Required for oauth-broker providers, absent for API-key providers. The
   * grant is only *chosen* here — it must already exist and be connected.
   * Control-api stamps the matching `clerum.io/codex-connection-ref`
   * annotation; authorize attests that annotation and fail-closes if this
   * field disagrees.
   */
  connectionRef?: string
}

/**
 * Non-secret snapshot of the originally authorized ordered suffix. It is the
 * authority for JIT fallback-ticket issuance; a request body never supplies
 * this list.
 */
export interface PluginWorkloadSdkPromptAuthorization {
  policyRevision: number
  policyHash: string
  authorizedTargetRefs: string[]
}

export interface PluginWorkloadSdkGrant {
  id: string
  recipeNamespace: string
  recipeName: string
  capabilityFamily: PluginWorkloadSdkFamily
  /**
   * Explicit provider bound to a promptBridge grant (R1). NULL for grants
   * written before the provider column existed and for clientNotifications
   * grants. A NULL value is legacy/unreviewed state; neither the API nor the
   * Control UI may infer a routable provider from a flat model list.
   */
  provider: string | null
  allowedModels: string[]
  allowedEventTypes: string[]
  allowedTargetRefs: string[]
  allowedUserRefs: string[]
  allowedCallers: string[]
  quotaLimits: PluginWorkloadSdkQuotaLimits
  modelPolicies: Record<string, PluginWorkloadSdkModelPolicy>
  /** Empty/null means a legacy grant and is deliberately not routable. */
  promptTargets: PluginWorkloadSdkPromptTarget[]
  defaultTargetRef: string | null
  policyState: 'active' | 'legacy_unreviewed' | 'revoking' | 'disabled'
  policyRevision: number
  /** Durable proof that an operator explicitly saved the current policy. */
  policyReviewProvenancePresent?: boolean
  /** Kill-switch epoch. Non-null while a recipe is revoking or disabled. */
  revocationId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Single readiness predicate for the provider-free notification capability.
 * An active grant without a usable recipient allowlist cannot deliver a
 * notification, so it must never be advertised as validated or admitted by
 * the authorizer.
 */
export function isClientNotificationsPolicyReady(
  grant: Pick<
    PluginWorkloadSdkGrant,
    'policyState' | 'allowedCallers' | 'allowedEventTypes' | 'allowedTargetRefs' | 'allowedUserRefs'
  >
): boolean {
  return (
    grant.policyState === 'active' &&
    grant.allowedCallers.length > 0 &&
    grant.allowedEventTypes.length > 0 &&
    grant.allowedTargetRefs.length + grant.allowedUserRefs.length > 0
  )
}

const CONTROL_PLANE_USER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the destination half of the notification contract against the same
 * tables used by delivery. A non-empty JSON allowlist is not sufficient:
 * deleted users and disabled medium identities must not make a recipe appear
 * validated when every send would remain queued or be dropped. A transaction
 * client may be supplied so an admin upsert and its readiness check share one
 * database boundary.
 */
export async function hasUsableClientNotificationRecipients(
  grant: Pick<PluginWorkloadSdkGrant, 'allowedTargetRefs' | 'allowedUserRefs'>,
  db: Pick<DbClient, 'query'> = pool
): Promise<boolean> {
  const userRefs = grant.allowedUserRefs.filter(ref => CONTROL_PLANE_USER_UUID_RE.test(ref))
  if (userRefs.length > 0) {
    const users = await db.query(
      `SELECT id
         FROM users
        WHERE id = ANY($1::uuid[])
          AND email IS NOT NULL
          AND btrim(email) <> ''
        LIMIT 1`,
      [userRefs]
    )
    if (users.rows.length > 0) return true
  }

  const targetRefs = grant.allowedTargetRefs.filter(ref => ref.trim().length > 0)
  if (targetRefs.length === 0) return false

  // Opaque targetRef delivery is backed by verified, non-disabled medium
  // identities; arbitrary strings are intentionally not treated as usable.
  const mediumAccounts = await db.query(
    `SELECT 1
       FROM workflow_approval_medium_accounts
      WHERE provider_user_id = ANY($1::text[])
        AND disabled_at IS NULL
      LIMIT 1`,
    [targetRefs]
  )
  return mediumAccounts.rows.length > 0
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
  contractVersion: 1 | 2
  promptAuthorization: PluginWorkloadSdkPromptAuthorization | null
  /** Monotonic physical-attempt generation; increments on failed replay. */
  attemptGeneration: number
  leaseExpiresAt: string | null
  createdAt: string
  updatedAt: string
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

/** Stable fingerprint of the complete ordered policy; contains no secret values. */
export function hashPromptTargetPolicy(
  grant: Pick<PluginWorkloadSdkGrant, 'policyRevision' | 'defaultTargetRef' | 'promptTargets'>
): string {
  return createHash('sha256')
    .update(
      stableStringify({
        revision: grant.policyRevision,
        defaultTargetRef: grant.defaultTargetRef,
        targets: grant.promptTargets,
      })
    )
    .digest('hex')
}

// ─── Row mapping ─────────────────────────────────────────────────────────

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function promptTargets(value: unknown): PluginWorkloadSdkPromptTarget[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    if (typeof raw !== 'object' || raw === null) return []
    const target = raw as Record<string, unknown>
    if (
      typeof target.targetRef !== 'string' ||
      typeof target.provider !== 'string' ||
      typeof target.model !== 'string' ||
      typeof target.credentialSlot !== 'string' ||
      (target.connectionRef !== undefined && typeof target.connectionRef !== 'string')
    ) {
      return []
    }
    return [
      {
        targetRef: target.targetRef,
        provider: target.provider,
        model: target.model,
        credentialSlot: target.credentialSlot,
        ...(typeof target.connectionRef === 'string' && target.connectionRef
          ? { connectionRef: target.connectionRef }
          : {}),
      },
    ]
  })
}

export function mapGrantRow(row: Record<string, unknown>): PluginWorkloadSdkGrant {
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
    provider: row.provider == null ? null : String(row.provider),
    allowedModels: stringArray(row.allowed_models),
    allowedEventTypes: stringArray(row.allowed_event_types),
    allowedTargetRefs: stringArray(row.allowed_target_refs),
    allowedUserRefs: stringArray(row.allowed_user_refs),
    allowedCallers: stringArray(row.allowed_callers),
    quotaLimits,
    modelPolicies,
    promptTargets: promptTargets(row.prompt_targets),
    defaultTargetRef: row.default_target_ref == null ? null : String(row.default_target_ref),
    policyState:
      row.policy_state === 'legacy_unreviewed' ||
      row.policy_state === 'revoking' ||
      row.policy_state === 'disabled'
        ? (row.policy_state as 'legacy_unreviewed' | 'revoking' | 'disabled')
        : 'active',
    policyRevision:
      typeof row.policy_revision === 'number' && Number.isInteger(row.policy_revision)
        ? row.policy_revision
        : 0,
    policyReviewProvenancePresent:
      row.policy_reviewed_at != null &&
      typeof row.policy_reviewed_by === 'string' &&
      row.policy_reviewed_by.trim().length > 0,
    revocationId: row.revocation_id == null ? null : String(row.revocation_id),
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
    contractVersion: row.contract_version === 1 ? 1 : 2,
    promptAuthorization: promptAuthorization(row.prompt_authorization),
    attemptGeneration:
      typeof row.attempt_generation === 'number' && Number.isInteger(row.attempt_generation)
        ? Math.max(row.attempt_generation, 1)
        : 1,
    leaseExpiresAt:
      row.lease_expires_at == null ? null : new Date(row.lease_expires_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date((row.updated_at ?? row.created_at) as string).toISOString(),
    completedAt:
      row.completed_at === null ? null : new Date(row.completed_at as string).toISOString(),
  }
}

function promptAuthorization(value: unknown): PluginWorkloadSdkPromptAuthorization | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.policyRevision !== 'number' ||
    !Number.isInteger(record.policyRevision) ||
    record.policyRevision < 1 ||
    typeof record.policyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.policyHash) ||
    !Array.isArray(record.authorizedTargetRefs) ||
    record.authorizedTargetRefs.length === 0 ||
    !record.authorizedTargetRefs.every(ref => typeof ref === 'string' && ref.length > 0)
  ) {
    return null
  }
  return {
    policyRevision: record.policyRevision,
    policyHash: record.policyHash,
    authorizedTargetRefs: [...record.authorizedTargetRefs],
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
  /**
   * Explicit provider for promptBridge grants (R1). The route requires it for
   * promptBridge and omits it for clientNotifications. Because the upsert is a
   * full-column overwrite, a promptBridge update MUST always carry the provider
   * or it would be wiped to NULL.
   */
  provider?: string
  allowedModels?: string[]
  allowedEventTypes?: string[]
  allowedTargetRefs?: string[]
  allowedUserRefs?: string[]
  allowedCallers?: string[]
  quotaLimits?: PluginWorkloadSdkQuotaLimits
  modelPolicies?: Record<string, PluginWorkloadSdkModelPolicy>
  promptTargets?: PluginWorkloadSdkPromptTarget[]
  defaultTargetRef?: string
}

export async function upsertGrant(
  params: UpsertGrantParams,
  operatorSub: string,
  // When the caller already runs inside a carrier transaction (the grant
  // write-gate, which holds the per-model advisory locks — R1-H3 fase 2), the
  // upsert MUST reuse that same transaction so the recipe lock is taken AFTER
  // the model locks (global order: `llm-model:*` before `plugin_workload_sdk:*`)
  // and the enabled-ness revalidation + the write commit atomically. Every other
  // caller passes no `db` and gets its own transaction, exactly as before.
  // The carrier MUST be a real transaction session (branded, issue #375 M3):
  // it holds the advisory locks and `notifyGrantUpdate` refuses `pool`.
  db?: DbTransactionClient
): Promise<PluginWorkloadSdkGrant> {
  if (db) return upsertGrantInTransaction(params, operatorSub, db)
  return withTransaction(inner => upsertGrantInTransaction(params, operatorSub, inner))
}

async function upsertGrantInTransaction(
  params: UpsertGrantParams,
  operatorSub: string,
  db: DbTransactionClient
): Promise<PluginWorkloadSdkGrant> {
  {
    // All capability families for a recipe share one lock. A family-scoped
    // lock permits an SDK-only revoke to race an upsert for the other family.
    const recipeLock = `plugin_workload_sdk:${params.recipeNamespace}/${params.recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const previous = await db.query(
      `SELECT allowed_user_refs, policy_state, revocation_id
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND capability_family = $3
        FOR UPDATE`,
      [params.recipeNamespace, params.recipeName, params.capabilityFamily]
    )
    const previousRow = previous.rows[0] as { allowed_user_refs?: unknown } | undefined
    const recipeState = await db.query(
      `SELECT policy_state, revocation_id
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND policy_state IN ('revoking', 'disabled')
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE`,
      [params.recipeNamespace, params.recipeName]
    )
    if (recipeState.rows.length > 0) {
      throw new Error(
        `Plugin Workload SDK policy for ${params.recipeNamespace}/${params.recipeName} is ${String((recipeState.rows[0] as { policy_state: unknown }).policy_state)} and cannot be reactivated`
      )
    }
    const previousUserRefs = Array.isArray(previousRow?.allowed_user_refs)
      ? previousRow.allowed_user_refs.map(String)
      : []
    if (
      params.capabilityFamily === 'clientNotifications' &&
      !(await hasUsableClientNotificationRecipients(
        {
          allowedTargetRefs: params.allowedTargetRefs ?? [],
          allowedUserRefs: params.allowedUserRefs ?? [],
        },
        db
      ))
    ) {
      throw new Error(
        'clientNotifications policy requires at least one existing user or verified notification target'
      )
    }
    const result = await db.query(
      `INSERT INTO plugin_workload_sdk_grants
         (recipe_namespace, recipe_name, capability_family, provider, allowed_models,
         allowed_event_types, allowed_target_refs, allowed_user_refs, allowed_callers,
         quota_limits, model_policies, prompt_targets, default_target_ref,
         policy_reviewed_at, policy_reviewed_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, now(), $14)
       ON CONFLICT (recipe_namespace, recipe_name, capability_family)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         allowed_models = EXCLUDED.allowed_models,
         allowed_event_types = EXCLUDED.allowed_event_types,
         allowed_target_refs = EXCLUDED.allowed_target_refs,
         allowed_user_refs = EXCLUDED.allowed_user_refs,
         allowed_callers = EXCLUDED.allowed_callers,
         quota_limits = EXCLUDED.quota_limits,
         model_policies = EXCLUDED.model_policies,
         prompt_targets = EXCLUDED.prompt_targets,
         default_target_ref = EXCLUDED.default_target_ref,
         -- A stale upsert must never undo a kill-switch. The recipe-wide
         -- lock plus the guard above makes this branch defensive for rows
         -- created by older binaries that did not know revocation_id.
         policy_state = CASE
           WHEN plugin_workload_sdk_grants.policy_state IN ('revoking', 'disabled')
           THEN plugin_workload_sdk_grants.policy_state
           ELSE 'active'
         END,
         revocation_id = CASE
           WHEN plugin_workload_sdk_grants.policy_state IN ('revoking', 'disabled')
           THEN plugin_workload_sdk_grants.revocation_id
           ELSE NULL
         END,
         policy_revision = plugin_workload_sdk_grants.policy_revision + 1,
         policy_reviewed_at = now(),
         policy_reviewed_by = EXCLUDED.policy_reviewed_by,
         updated_at = now()
       RETURNING *`,
      [
        params.recipeNamespace,
        params.recipeName,
        params.capabilityFamily,
        params.provider ?? null,
        JSON.stringify(params.allowedModels ?? []),
        JSON.stringify(params.allowedEventTypes ?? []),
        JSON.stringify(params.allowedTargetRefs ?? []),
        JSON.stringify(params.allowedUserRefs ?? []),
        JSON.stringify(params.allowedCallers ?? []),
        JSON.stringify(params.quotaLimits ?? {}),
        JSON.stringify(params.modelPolicies ?? {}),
        JSON.stringify(params.promptTargets ?? []),
        params.defaultTargetRef ?? null,
        operatorSub,
      ]
    )
    const grant = mapGrantRow(result.rows[0] as Record<string, unknown>)
    const currentUserRefs = grant.allowedUserRefs
    const addedUserRefs = currentUserRefs.filter(ref => !previousUserRefs.includes(ref))
    const removedUserRefs = previousUserRefs.filter(ref => !currentUserRefs.includes(ref))
    const referencedUsers = [...new Set([...addedUserRefs, ...removedUserRefs])]
    const resolvedUsers = new Set<string>()
    if (referencedUsers.length > 0) {
      const users = await db.query(`SELECT id::text AS id FROM users WHERE id = ANY($1::uuid[])`, [
        referencedUsers,
      ])
      for (const row of users.rows) resolvedUsers.add(String((row as { id: string }).id))
    }
    const resourceRef = `plugin_workload_sdk:${params.recipeNamespace}/${params.recipeName}:${params.capabilityFamily}`
    const changes: ControlApiPermissionChange[] = [
      {
        action: 'grant' as const,
        resourceClass: 'plugin_workload_sdk_access',
        resourceRef,
        subject: { kind: 'service' as const, id: params.capabilityFamily },
        namespace: params.recipeNamespace,
        sourceAuditRef: `plugin_workload_sdk_grants:${grant.id}`,
        status: 'configured',
      },
      ...addedUserRefs
        .filter(userRef => resolvedUsers.has(userRef))
        .map(userRef => ({
          action: 'grant' as const,
          resourceClass: 'plugin_workload_sdk_access',
          resourceRef,
          subject: { kind: 'user' as const, id: userRef },
          namespace: params.recipeNamespace,
          sourceAuditRef: `plugin_workload_sdk_grants:${grant.id}`,
        })),
      ...removedUserRefs
        .filter(userRef => resolvedUsers.has(userRef))
        .map(userRef => ({
          action: 'revoke' as const,
          resourceClass: 'plugin_workload_sdk_access',
          resourceRef,
          subject: { kind: 'user' as const, id: userRef },
          namespace: params.recipeNamespace,
          sourceAuditRef: `plugin_workload_sdk_grants:${grant.id}`,
        })),
    ]
    await appendControlApiPermissionEventsInTransaction(db, { operatorSub, changes })
    // issue #375 (P3): nudge the WRC to re-reconcile now that the grant changed.
    await notifyGrantUpdate(db, {
      recipeNamespace: params.recipeNamespace,
      recipeName: params.recipeName,
      capabilityFamily: params.capabilityFamily,
    })
    return grant
  }
}

export async function listGrants(
  filter?: {
    recipeNamespace?: string
    recipeName?: string
  },
  // Accepts a transaction client so the grant write-gate can read the stored
  // grant (Pieza D no-worsening context) on the SAME connection that holds the
  // model advisory locks — no extra pool checkout under the lock (adenda A3).
  // Defaults to the global pool for every other (unlocked) caller.
  db: Pick<DbClient, 'query'> = pool
): Promise<PluginWorkloadSdkGrant[]> {
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
  const result = await db.query(
    `SELECT * FROM plugin_workload_sdk_grants ${where}
     ORDER BY recipe_namespace, recipe_name, capability_family`,
    values
  )
  return (result.rows as Record<string, unknown>[]).map(mapGrantRow)
}

/**
 * Grants whose `allowed_models` list names `model` — the 4th source of the
 * LLM-model impact enumeration (Fase 3, `llmModelImpact.ts`).
 *
 * MATCH BY MODEL NAME ONLY, deliberately NOT by `(provider, model)`. The
 * `allowed_models` column is a provider-LESS flat model-name list and is NOT
 * enforced to hold only models of the grant's `provider` column: the write-gate
 * (`routes/admin/pluginWorkloadSdk.ts`) validates `prompt_targets` per-provider,
 * but `allowed_models` is parsed from the request body free-form and passed
 * straight through — and since `prompt_targets` can span multiple providers, the
 * mirrored `allowed_models` set can too. Filtering by `provider` would therefore
 * UNDER-report references, the unsafe direction for a safety gate that gates a
 * destructive disable/delete. Matching by model name may over-report a same-named
 * model under a different provider (extra operator friction, never silent
 * breakage) — the fail-safe trade-off. This is exercised by the realPostgres
 * integration test `db.listGrantsReferencingModel.realPostgres.integration`.
 *
 * No `policy_state` and no `provider IS NOT NULL` filter: a grant is surfaced
 * whenever it names the model, including legacy NULL-provider and
 * `revoking`/`disabled` rows (fail-loud — never hide a dangling reference).
 *
 * `allowed_models @> to_jsonb($1::text)` is jsonb array-contains-scalar: for a
 * text `model`, `to_jsonb('m'::text)` is the JSON string `"m"`, and a jsonb
 * array `@>` a scalar is true when the array contains that element.
 */
export async function listGrantsReferencingModel(
  model: string,
  db: DbClient = pool
): Promise<PluginWorkloadSdkGrant[]> {
  const result = await db.query(
    `SELECT * FROM plugin_workload_sdk_grants
      WHERE allowed_models @> to_jsonb($1::text)
      ORDER BY recipe_namespace, recipe_name, capability_family`,
    [model]
  )
  return (result.rows as Record<string, unknown>[]).map(mapGrantRow)
}

/**
 * Read-only migration gate for promptBridge rows written before the ordered
 * target policy existed. Legacy rows are intentionally never inferred or
 * rewritten here; operators get only non-secret identifiers, shape flags, and
 * reasons that must be resolved by an explicit policy upsert.
 */
export interface PluginWorkloadSdkLegacyGrantInventoryItem {
  id: string
  recipeNamespace: string
  recipeName: string
  policyState: string
  policyRevision: number
  providerPresent: boolean
  policyReviewProvenancePresent: boolean
  promptTargetsCount: number
  defaultTargetRefPresent: boolean
  reasons: string[]
}

export interface PluginWorkloadSdkLegacyGrantInventory {
  totalPromptBridgeGrants: number
  legacyPromptBridgeGrants: number
  activationReady: boolean
  items: PluginWorkloadSdkLegacyGrantInventoryItem[]
}

export async function getPluginWorkloadSdkLegacyGrantInventory(filter?: {
  recipeNamespace?: string
  recipeName?: string
}): Promise<PluginWorkloadSdkLegacyGrantInventory> {
  const clauses = ["capability_family = 'promptBridge'"]
  const values: unknown[] = []
  if (filter?.recipeNamespace) {
    values.push(filter.recipeNamespace)
    clauses.push(`recipe_namespace = $${values.length}`)
  }
  if (filter?.recipeName) {
    values.push(filter.recipeName)
    clauses.push(`recipe_name = $${values.length}`)
  }
  const result = await pool.query(
    `SELECT id, recipe_namespace, recipe_name, policy_state, policy_revision,
            provider, prompt_targets, default_target_ref, policy_reviewed_at,
            policy_reviewed_by
       FROM plugin_workload_sdk_grants
      WHERE ${clauses.join(' AND ')}
      ORDER BY recipe_namespace, recipe_name`,
    values
  )

  const items = (result.rows as Record<string, unknown>[]).flatMap(row => {
    const rawTargets = Array.isArray(row.prompt_targets) ? row.prompt_targets : []
    const targets = promptTargets(row.prompt_targets)
    const policyState = String(row.policy_state ?? '')
    const policyRevision =
      typeof row.policy_revision === 'number' && Number.isInteger(row.policy_revision)
        ? row.policy_revision
        : Number(row.policy_revision ?? 0)
    const providerPresent = typeof row.provider === 'string' && row.provider.trim().length > 0
    const policyReviewProvenancePresent =
      row.policy_reviewed_at != null &&
      typeof row.policy_reviewed_by === 'string' &&
      row.policy_reviewed_by.trim().length > 0
    const defaultTargetRefPresent =
      typeof row.default_target_ref === 'string' && row.default_target_ref.trim().length > 0
    const reasons: string[] = []
    if (policyState === 'legacy_unreviewed') reasons.push('legacy_policy_state')
    if (!policyReviewProvenancePresent) reasons.push('missing_operator_review_provenance')
    if (!providerPresent) reasons.push('missing_provider')
    if (rawTargets.length !== targets.length) reasons.push('invalid_prompt_targets')
    if (targets.length === 0) reasons.push('empty_prompt_targets')
    if (!defaultTargetRefPresent) reasons.push('missing_default_target')
    if (policyRevision < 1) reasons.push('invalid_policy_revision')
    if (defaultTargetRefPresent && targets[0]?.targetRef !== String(row.default_target_ref)) {
      reasons.push('default_target_not_first')
    }
    const targetRefs = targets.map(target => target.targetRef)
    if (new Set(targetRefs).size !== targetRefs.length) reasons.push('duplicate_target_refs')
    if (reasons.length === 0) return []
    return [
      {
        id: String(row.id),
        recipeNamespace: String(row.recipe_namespace),
        recipeName: String(row.recipe_name),
        policyState,
        policyRevision: Number.isFinite(policyRevision) ? policyRevision : 0,
        providerPresent,
        policyReviewProvenancePresent,
        promptTargetsCount: targets.length,
        defaultTargetRefPresent,
        reasons,
      },
    ]
  })
  return {
    totalPromptBridgeGrants: result.rows.length,
    legacyPromptBridgeGrants: items.length,
    activationReady: items.length === 0,
    items,
  }
}

export type PluginWorkloadSdkRevocationState = 'missing' | 'revoking' | 'disabled' | 'conflict'

export interface PluginWorkloadSdkRevocationReceipt {
  state: PluginWorkloadSdkRevocationState
  revocationId?: string
  revoked: number
  fencedInvocations: number
  disabled?: number
}

export interface PluginWorkloadSdkRevocationActor {
  operatorSub: string
  internalPrincipal: AdministrativeEventSubmitterPrincipalV1
}

/**
 * Fence every SDK capability for a recipe before its runtime resources are
 * torn down. This is deliberately recipe-scoped and transactional: the
 * recipe-wide advisory lock is the linearization point shared with upserts,
 * authorization, JIT issuance, and ticket redemption. A receipt epoch is
 * returned so only the reconcile that fenced this exact policy can finalize it.
 */
export async function revokePluginWorkloadSdkForRecipe(
  recipeNamespace: string,
  recipeName: string,
  actor: PluginWorkloadSdkRevocationActor
): Promise<PluginWorkloadSdkRevocationReceipt> {
  return withTransaction(async db => {
    const recipeLock = `plugin_workload_sdk:${recipeNamespace}/${recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const grants = await db.query(
      `SELECT id, capability_family, policy_state, revocation_id
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1 AND recipe_name = $2
        FOR UPDATE`,
      [recipeNamespace, recipeName]
    )
    if (grants.rows.length === 0) {
      return { state: 'missing', revoked: 0, fencedInvocations: 0 }
    }

    const revocationIds = [
      ...new Set(
        grants.rows
          .map(row => (row as { revocation_id?: unknown }).revocation_id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .map(String)
      ),
    ]
    if (revocationIds.length > 1) {
      return {
        state: 'conflict',
        revoked: 0,
        fencedInvocations: 0,
      }
    }
    const currentRevocationId = revocationIds[0] ?? randomUUID()
    const hasActivePolicy = grants.rows.some(row =>
      ['active', 'legacy_unreviewed'].includes(
        String((row as { policy_state: unknown }).policy_state)
      )
    )
    const hasRevokingPolicy = grants.rows.some(
      row => String((row as { policy_state: unknown }).policy_state) === 'revoking'
    )

    const revoked = await db.query(
      `UPDATE plugin_workload_sdk_grants
          SET policy_state = 'revoking',
              policy_revision = policy_revision + 1,
              revocation_id = COALESCE(revocation_id, $3::uuid),
              updated_at = now()
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND policy_state IN ('active', 'legacy_unreviewed')`,
      [recipeNamespace, recipeName, currentRevocationId]
    )

    const fenced = await db.query(
      `UPDATE plugin_workload_sdk_invocations
          SET status = 'failed',
              authorization_decision = 'revoked',
              updated_at = now(),
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, now())
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND status = 'in_progress'
        RETURNING id`,
      [recipeNamespace, recipeName]
    )
    await db.query(
      `UPDATE plugin_workload_sdk_invocation_attempts
          SET status = 'failed',
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, now())
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND status = 'in_progress'`,
      [recipeNamespace, recipeName]
    )
    await db.query(
      `UPDATE plugin_workload_sdk_provider_attempts
          SET status = 'failed',
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, now())
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND status IN ('reserved', 'in_progress')`,
      [recipeNamespace, recipeName]
    )

    const changes: ControlApiPermissionChange[] = grants.rows
      .filter(row =>
        ['active', 'legacy_unreviewed'].includes(
          String((row as { policy_state: unknown }).policy_state)
        )
      )
      .map(row => ({
        action: 'revoke' as const,
        resourceClass: 'plugin_workload_sdk_access',
        resourceRef: `plugin_workload_sdk:${recipeNamespace}/${recipeName}:${String((row as { capability_family: unknown }).capability_family)}`,
        subject: {
          kind: 'service' as const,
          id: String((row as { capability_family: unknown }).capability_family),
        },
        namespace: recipeNamespace,
        sourceAuditRef: `plugin_workload_sdk_grants:${String((row as { id: unknown }).id)}`,
        status: 'revoking',
      }))
    if (changes.length > 0) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: actor.operatorSub,
        internalPrincipal: actor.internalPrincipal,
        changes,
      })
    }
    // issue #375 (P3): a whole-recipe revoke spans every family, so omit the
    // capabilityFamily — the WRC only needs the recipe coordinates to re-reconcile.
    // issue #375 (B2): notify ONLY on an actual transition (rows moved to
    // 'revoking', or permission changes emitted). A no-op revoke — every grant
    // already revoking/disabled — must stay silent, otherwise the WRC would
    // force-reconcile the still-cached recipe, which can re-enter revoke and
    // NOTIFY again: a reconcile+pg_notify spin. Matches upsert/delete "notify
    // only on a real mutation" semantics.
    if ((revoked.rowCount ?? 0) > 0 || changes.length > 0) {
      await notifyGrantUpdate(db, { recipeNamespace, recipeName })
    }
    return {
      state:
        hasActivePolicy || hasRevokingPolicy || (revoked.rowCount ?? 0) > 0
          ? 'revoking'
          : 'disabled',
      revocationId: currentRevocationId,
      revoked: revoked.rowCount ?? 0,
      fencedInvocations: fenced.rowCount ?? 0,
    }
  })
}

/**
 * Complete a previously fenced revocation only after the caller has proved
 * that the recipe-bound SDK endpoint and credentials are gone. The state
 * transition is intentionally impossible from `active`, preventing callers
 * from declaring a kill-switch success without the teardown boundary.
 *
 * issue #375 (B2 counterpart): finalize (`revoking`→`disabled`) deliberately
 * emits NO grant-update pg_notify — it is terminal cleanup reachable only after
 * teardown is proven, its only caller/consumer is the WRC itself, and the
 * visible `revoke` transition already notified.
 */
export async function finalizePluginWorkloadSdkRevocation(
  recipeNamespace: string,
  recipeName: string,
  expectedRevocationId: string,
  actor: PluginWorkloadSdkRevocationActor
): Promise<PluginWorkloadSdkRevocationReceipt> {
  return withTransaction(async db => {
    const recipeLock = `plugin_workload_sdk:${recipeNamespace}/${recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const grants = await db.query(
      `SELECT id, capability_family, policy_state, revocation_id
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1 AND recipe_name = $2
        FOR UPDATE`,
      [recipeNamespace, recipeName]
    )
    if (grants.rows.length === 0) {
      return { state: 'missing', revoked: 0, fencedInvocations: 0, disabled: 0 }
    }
    const hasActive = grants.rows.some(row =>
      ['active', 'legacy_unreviewed'].includes(
        String((row as { policy_state: unknown }).policy_state)
      )
    )
    const hasWrongEpoch = grants.rows.some(row => {
      const state = String((row as { policy_state: unknown }).policy_state)
      return (
        (state === 'revoking' || state === 'disabled') &&
        String((row as { revocation_id?: unknown }).revocation_id ?? '') !== expectedRevocationId
      )
    })
    if (hasActive || hasWrongEpoch) {
      return {
        state: 'conflict',
        revocationId: expectedRevocationId,
        revoked: 0,
        fencedInvocations: 0,
      }
    }
    const result = await db.query(
      `UPDATE plugin_workload_sdk_grants
          SET policy_state = 'disabled',
              updated_at = now()
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND policy_state = 'revoking'
          AND revocation_id = $3::uuid
        RETURNING id, capability_family`,
      [recipeNamespace, recipeName, expectedRevocationId]
    )
    const disabledRows =
      result.rows.length > 0
        ? result.rows
        : grants.rows.filter(
            row => String((row as { policy_state: unknown }).policy_state) === 'disabled'
          )
    if (disabledRows.length === 0) {
      return {
        state: 'conflict',
        revocationId: expectedRevocationId,
        revoked: 0,
        fencedInvocations: 0,
      }
    }
    const changes: ControlApiPermissionChange[] = result.rows.map(row => ({
      action: 'revoke' as const,
      resourceClass: 'plugin_workload_sdk_access',
      resourceRef: `plugin_workload_sdk:${recipeNamespace}/${recipeName}:${String((row as { capability_family: unknown }).capability_family)}`,
      subject: {
        kind: 'service' as const,
        id: String((row as { capability_family: unknown }).capability_family),
      },
      namespace: recipeNamespace,
      sourceAuditRef: `plugin_workload_sdk_grants:${String((row as { id: unknown }).id)}`,
      status: 'disabled',
    }))
    if (changes.length > 0) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: actor.operatorSub,
        internalPrincipal: actor.internalPrincipal,
        changes,
      })
    }
    return {
      state: 'disabled',
      revocationId: expectedRevocationId,
      revoked: 0,
      fencedInvocations: 0,
      disabled: result.rowCount ?? 0,
    }
  })
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
  recipeName: string,
  operatorSub: string
): Promise<boolean> {
  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `plugin_workload_sdk:${recipeNamespace}/${recipeName}`,
    ])
    const result = await db.query(
      `DELETE FROM plugin_workload_sdk_grants
       WHERE id = $1 AND recipe_namespace = $2 AND recipe_name = $3
       RETURNING *`,
      [id, recipeNamespace, recipeName]
    )
    if ((result.rowCount ?? 0) === 0) return false
    const grant = mapGrantRow(result.rows[0] as Record<string, unknown>)
    const resolvedUsers = new Set<string>()
    if (grant.allowedUserRefs.length > 0) {
      const users = await db.query(`SELECT id::text AS id FROM users WHERE id = ANY($1::uuid[])`, [
        grant.allowedUserRefs,
      ])
      for (const row of users.rows) resolvedUsers.add(String((row as { id: string }).id))
    }
    const resourceRef = `plugin_workload_sdk:${grant.recipeNamespace}/${grant.recipeName}:${grant.capabilityFamily}`
    const changes: ControlApiPermissionChange[] = [
      {
        action: 'revoke',
        resourceClass: 'plugin_workload_sdk_access',
        resourceRef,
        subject: { kind: 'service', id: grant.capabilityFamily },
        namespace: grant.recipeNamespace,
        sourceAuditRef: `plugin_workload_sdk_grants:${grant.id}`,
      },
      ...grant.allowedUserRefs
        .filter(userRef => resolvedUsers.has(userRef))
        .map(userRef => ({
          action: 'revoke' as const,
          resourceClass: 'plugin_workload_sdk_access',
          resourceRef,
          subject: { kind: 'user' as const, id: userRef },
          namespace: grant.recipeNamespace,
          sourceAuditRef: `plugin_workload_sdk_grants:${grant.id}`,
        })),
    ]
    await appendControlApiPermissionEventsInTransaction(db, { operatorSub, changes })
    // issue #375 (P3): nudge the WRC to re-reconcile after the grant is removed
    // so the capability projection transitions back to awaiting_policy/degraded.
    await notifyGrantUpdate(db, {
      recipeNamespace: grant.recipeNamespace,
      recipeName: grant.recipeName,
      capabilityFamily: grant.capabilityFamily,
    })
    return true
  })
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

/**
 * Immutable identity for one physical provider attempt. The parent invocation
 * is the idempotent logical request; this row is the receipt/fencing record
 * used by tickets, usage ingestion, and late-result rejection.
 */
export interface PluginWorkloadSdkAttemptReceipt {
  invocationId: string
  recipeNamespace: string
  recipeName: string
  attemptGeneration: number
  method: PluginWorkloadSdkFamily
  targetRefs: string[]
  policyRevision: number | null
  policyHash: string | null
  status: PluginWorkloadSdkInvocationStatus
  startedAt: string
  leaseExpiresAt: string | null
  completedAt: string | null
}

function mapAttemptReceiptRow(row: Record<string, unknown>): PluginWorkloadSdkAttemptReceipt {
  return {
    invocationId: String(row.invocation_id),
    recipeNamespace: String(row.recipe_namespace),
    recipeName: String(row.recipe_name),
    attemptGeneration: Number(row.attempt_generation),
    method: row.method as PluginWorkloadSdkFamily,
    targetRefs: stringArray(row.target_refs),
    policyRevision: row.policy_revision == null ? null : Number(row.policy_revision),
    policyHash: row.policy_hash == null ? null : String(row.policy_hash),
    status: row.status as PluginWorkloadSdkInvocationStatus,
    startedAt: new Date(row.started_at as string).toISOString(),
    leaseExpiresAt:
      row.lease_expires_at == null ? null : new Date(row.lease_expires_at as string).toISOString(),
    completedAt:
      row.completed_at == null ? null : new Date(row.completed_at as string).toISOString(),
  }
}

export async function getPluginWorkloadSdkAttemptReceipt(
  invocationId: string,
  attemptGeneration: number,
  db: DbClient = pool
): Promise<PluginWorkloadSdkAttemptReceipt | null> {
  const result = await db.query(
    `SELECT * FROM plugin_workload_sdk_invocation_attempts
      WHERE invocation_id = $1 AND attempt_generation = $2`,
    [invocationId, attemptGeneration]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapAttemptReceiptRow(row) : null
}

export type PluginWorkloadSdkProviderAttemptStatus =
  | 'reserved'
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'provider_unavailable'
  | 'skipped'

export interface PluginWorkloadSdkProviderAttempt {
  id: string
  invocationId: string
  recipeNamespace: string
  recipeName: string
  attemptGeneration: number
  attemptIndex: number
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
  status: PluginWorkloadSdkProviderAttemptStatus
  credentialJti: string | null
  startedAt: string
  leaseExpiresAt: string | null
  completedAt: string | null
  usageRequestId: string | null
}

function mapProviderAttemptRow(row: Record<string, unknown>): PluginWorkloadSdkProviderAttempt {
  return {
    id: String(row.id),
    invocationId: String(row.invocation_id),
    recipeNamespace: String(row.recipe_namespace),
    recipeName: String(row.recipe_name),
    attemptGeneration: Number(row.attempt_generation),
    attemptIndex: Number(row.attempt_index),
    targetRef: String(row.target_ref),
    provider: String(row.provider),
    model: String(row.model),
    credentialSlot: String(row.credential_slot),
    status: row.status as PluginWorkloadSdkProviderAttemptStatus,
    credentialJti: row.credential_jti == null ? null : String(row.credential_jti),
    startedAt: new Date(row.started_at as string).toISOString(),
    leaseExpiresAt:
      row.lease_expires_at == null ? null : new Date(row.lease_expires_at as string).toISOString(),
    completedAt:
      row.completed_at == null ? null : new Date(row.completed_at as string).toISOString(),
    usageRequestId: row.usage_request_id == null ? null : String(row.usage_request_id),
  }
}

/** Reserve one physical target before issuing a JIT credential ticket. */
export async function reservePluginWorkloadSdkProviderAttempt(input: {
  invocationId: string
  recipeNamespace: string
  recipeName: string
  attemptGeneration: number
  target: PluginWorkloadSdkPromptTarget
}): Promise<PluginWorkloadSdkProviderAttempt | null> {
  return withTransaction(async db => {
    // Revoke and every capability-creation path use this same recipe lock.
    // Acquire it before the invocation row lock to keep one global order and
    // avoid a revoke↔attempt deadlock.
    const recipeLock = `plugin_workload_sdk:${input.recipeNamespace}/${input.recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const invocationResult = await db.query(
      `SELECT id, method, status, attempt_generation, lease_expires_at, prompt_authorization
         FROM plugin_workload_sdk_invocations
        WHERE id = $1 AND recipe_namespace = $2 AND recipe_name = $3
        FOR UPDATE`,
      [input.invocationId, input.recipeNamespace, input.recipeName]
    )
    const invocation = invocationResult.rows[0] as Record<string, unknown> | undefined
    const authorization = promptAuthorization(invocation?.prompt_authorization)
    if (
      !invocation ||
      invocation.method !== 'promptBridge' ||
      invocation.status !== 'in_progress' ||
      Number(invocation.attempt_generation) !== input.attemptGeneration ||
      !invocation.lease_expires_at ||
      new Date(invocation.lease_expires_at as string).getTime() <= Date.now() ||
      !authorization?.authorizedTargetRefs.includes(input.target.targetRef)
    ) {
      return null
    }
    const grantResult = await db.query(
      `SELECT policy_state, policy_revision, prompt_targets, default_target_ref
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND capability_family = 'promptBridge'
        FOR UPDATE`,
      [input.recipeNamespace, input.recipeName]
    )
    const grant = grantResult.rows[0] as Record<string, unknown> | undefined
    const currentTargets = promptTargets(grant?.prompt_targets)
    const currentRevision = Number(grant?.policy_revision)
    const currentHash = hashPromptTargetPolicy({
      policyRevision: currentRevision,
      defaultTargetRef: grant?.default_target_ref == null ? null : String(grant.default_target_ref),
      promptTargets: currentTargets,
    })
    const currentTarget = currentTargets.find(target => target.targetRef === input.target.targetRef)
    if (
      !grant ||
      grant.policy_state !== 'active' ||
      currentRevision !== authorization?.policyRevision ||
      currentHash !== authorization?.policyHash ||
      !currentTarget ||
      currentTarget.provider !== input.target.provider ||
      currentTarget.model !== input.target.model ||
      currentTarget.credentialSlot !== input.target.credentialSlot ||
      (currentTarget.connectionRef ?? '') !== (input.target.connectionRef ?? '')
    ) {
      return null
    }
    const attemptsResult = await db.query(
      `SELECT attempt_index, target_ref, status
         FROM plugin_workload_sdk_provider_attempts
        WHERE invocation_id = $1 AND attempt_generation = $2
        ORDER BY attempt_index ASC
        FOR UPDATE`,
      [input.invocationId, input.attemptGeneration]
    )
    const attempts = attemptsResult.rows as Array<{
      attempt_index?: unknown
      target_ref?: unknown
      status?: unknown
    }>
    const attemptIndex = attempts.length + 1
    const expectedTargetRef = authorization.authorizedTargetRefs[attemptIndex - 1]
    if (
      attemptIndex > MAX_PROMPT_BRIDGE_PROVIDER_ATTEMPTS ||
      !expectedTargetRef ||
      expectedTargetRef !== input.target.targetRef
    ) {
      return null
    }
    if (attemptIndex > 1) {
      const previousAttempt = attempts[attempts.length - 1]
      if (
        !previousAttempt ||
        !['failed', 'provider_unavailable', 'skipped'].includes(String(previousAttempt.status))
      ) {
        return null
      }
    }
    const result = await db.query(
      `INSERT INTO plugin_workload_sdk_provider_attempts
         (invocation_id, recipe_namespace, recipe_name, attempt_generation, attempt_index,
          target_ref, provider, model, credential_slot, status, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10)
       RETURNING *`,
      [
        input.invocationId,
        input.recipeNamespace,
        input.recipeName,
        input.attemptGeneration,
        attemptIndex,
        input.target.targetRef,
        input.target.provider,
        input.target.model,
        input.target.credentialSlot,
        invocation.lease_expires_at,
      ]
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row ? mapProviderAttemptRow(row) : null
  })
}

export async function getPluginWorkloadSdkProviderAttempt(
  id: string,
  db: DbClient = pool
): Promise<PluginWorkloadSdkProviderAttempt | null> {
  const result = await db.query(
    `SELECT * FROM plugin_workload_sdk_provider_attempts WHERE id = $1`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapProviderAttemptRow(row) : null
}

export async function lockPluginWorkloadSdkRecipe(
  db: DbClient,
  recipeNamespace: string,
  recipeName: string
): Promise<void> {
  const recipeLock = `plugin_workload_sdk:${recipeNamespace}/${recipeName}`
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
}

export async function getPluginWorkloadSdkProviderAttemptForUpdate(
  id: string,
  db: DbClient
): Promise<PluginWorkloadSdkProviderAttempt | null> {
  const result = await db.query(
    `SELECT * FROM plugin_workload_sdk_provider_attempts WHERE id = $1 FOR UPDATE`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapProviderAttemptRow(row) : null
}

export async function pluginWorkloadSdkSpendOutcomeExists(
  providerAttemptId: string,
  db: DbClient
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM plugin_workload_sdk_spend_outcomes WHERE provider_attempt_id = $1`,
    [providerAttemptId]
  )
  return result.rows.length > 0
}

/**
 * JTI-free reserved → in_progress for Codex authorize-link. Does not write
 * credential_jti. The secret-ticket path still promotes through
 * registerPluginWorkloadSdkCredentialTicketJti.
 */
export async function promoteReservedOauthBrokerProviderAttempt(
  input: {
    id: string
    invocationId: string
    recipeNamespace: string
    recipeName: string
    attemptGeneration: number
    attemptIndex: number
    model: string
    targetRef: string
  },
  db: DbClient
): Promise<boolean> {
  const result = await db.query(
    `UPDATE plugin_workload_sdk_provider_attempts
        SET status = 'in_progress'
      WHERE id = $1
        AND invocation_id = $2
        AND recipe_namespace = $3
        AND recipe_name = $4
        AND attempt_generation = $5
        AND attempt_index = $6
        AND provider = 'codex-subscription'
        AND model = $7
        AND target_ref = $8
        AND status = 'reserved'
        AND credential_jti IS NULL`,
    [
      input.id,
      input.invocationId,
      input.recipeNamespace,
      input.recipeName,
      input.attemptGeneration,
      input.attemptIndex,
      input.model,
      input.targetRef,
    ]
  )
  return (result.rowCount ?? 0) === 1
}

export async function markPluginWorkloadSdkProviderAttemptStatus(input: {
  id: string
  invocationId: string
  recipeNamespace: string
  recipeName: string
  attemptGeneration: number
  status: Exclude<PluginWorkloadSdkProviderAttemptStatus, 'reserved' | 'in_progress'>
}): Promise<boolean> {
  // Terminal reports are idempotent: a committed response whose HTTP reply
  // was lost must be safe to repeat. A different terminal outcome still
  // returns false, so a late failure can never downgrade a completed attempt.
  const result = await pool.query(
    `UPDATE plugin_workload_sdk_provider_attempts
        SET status = $6,
            completed_at = now(),
            lease_expires_at = NULL
      WHERE id = $1
        AND invocation_id = $2
        AND recipe_namespace = $3
        AND recipe_name = $4
        AND attempt_generation = $5
        AND (
          status = $6
          OR (
            status IN ('reserved', 'in_progress')
            AND EXISTS (
              SELECT 1
                FROM plugin_workload_sdk_invocations inv
               WHERE inv.id = $2
                 AND inv.status = 'in_progress'
                 AND inv.attempt_generation = $5
                 AND inv.lease_expires_at > now()
            )
          )
        )`,
    [
      input.id,
      input.invocationId,
      input.recipeNamespace,
      input.recipeName,
      input.attemptGeneration,
      input.status,
    ]
  )
  return (result.rowCount ?? 0) === 1
}

async function insertAttemptReceipt(
  db: DbClient,
  invocation: PluginWorkloadSdkInvocationRecord
): Promise<void> {
  const authorization = invocation.promptAuthorization
  await db.query(
    `INSERT INTO plugin_workload_sdk_invocation_attempts
       (invocation_id, recipe_namespace, recipe_name, attempt_generation, method, target_refs, policy_revision,
        policy_hash, status, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (invocation_id, attempt_generation) DO NOTHING`,
    [
      invocation.id,
      invocation.recipeNamespace,
      invocation.recipeName,
      invocation.attemptGeneration,
      invocation.method,
      JSON.stringify(authorization?.authorizedTargetRefs ?? []),
      authorization?.policyRevision ?? null,
      authorization?.policyHash ?? null,
      invocation.status,
      invocation.leaseExpiresAt,
    ]
  )
}

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
  promptAuthorization?: PluginWorkloadSdkPromptAuthorization
  contractVersion?: 1 | 2
  /** Lease for the first physical attempt; terminal transitions clear it. */
  attemptLeaseSeconds?: number
  /**
   * States that may create/replay an invocation. The check runs under the
   * recipe-wide advisory lock so revoke and authorization have one ordering.
   */
  requiredGrantStates?: readonly ('active' | 'legacy_unreviewed')[]
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
  | { kind: 'policy_revoked' }

/**
 * Insert an invocation with idempotency semantics: same key + same payload
 * hash → replay (existing record returned); same key + different payload
 * hash → conflict (spec §15 idempotency_conflict).
 */
export async function insertInvocation(
  params: InsertInvocationParams
): Promise<InsertInvocationResult> {
  return withTransaction(async db => {
    const recipeLock = `plugin_workload_sdk:${params.recipeNamespace}/${params.recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    if (params.requiredGrantStates) {
      const grant = await db.query(
        `SELECT policy_state
           FROM plugin_workload_sdk_grants
          WHERE recipe_namespace = $1
            AND recipe_name = $2
            AND capability_family = $3
          FOR UPDATE`,
        [params.recipeNamespace, params.recipeName, params.method]
      )
      const state = String(
        (grant.rows[0] as { policy_state?: unknown } | undefined)?.policy_state ?? ''
      )
      if (!params.requiredGrantStates.includes(state as 'active' | 'legacy_unreviewed')) {
        return { kind: 'policy_revoked' }
      }
    }
    const inserted = await db.query(
      `INSERT INTO plugin_workload_sdk_invocations
       (recipe_namespace, recipe_name, caller_ref, correlation_id, method, detail, purpose,
        idempotency_key_hash, payload_hash, status, authorization_decision, prompt_authorization,
        contract_version, attempt_generation, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1,
        now() + interval '1 second' * $14)
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
        params.promptAuthorization ? JSON.stringify(params.promptAuthorization) : null,
        params.contractVersion ?? 2,
        params.attemptLeaseSeconds ?? getPromptBridgeAttemptLeaseSeconds(),
      ]
    )
    const insertedRow = inserted.rows[0] as Record<string, unknown> | undefined
    if (insertedRow) {
      const invocation = mapInvocationRow(insertedRow)
      await insertAttemptReceipt(db, invocation)
      return { kind: 'inserted', invocation }
    }

    const existing = await db.query(
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
  })
}

export async function getInvocationById(
  id: string,
  db: DbClient = pool
): Promise<PluginWorkloadSdkInvocationRecord | null> {
  const result = await db.query(`SELECT * FROM plugin_workload_sdk_invocations WHERE id = $1`, [id])
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapInvocationRow(row) : null
}

export async function registerPluginWorkloadSdkCredentialTicketJti(input: {
  jti: string
  recipeNamespace: string
  recipeName: string
  invocationId: string
  targetRef: string
  attemptGeneration: number
  providerAttemptId: string
  expiresAt: Date
}): Promise<boolean> {
  return withTransaction(async db => {
    const recipeLock = `plugin_workload_sdk:${input.recipeNamespace}/${input.recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const grant = await db.query(
      `SELECT policy_state
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND capability_family = 'promptBridge'
        FOR UPDATE`,
      [input.recipeNamespace, input.recipeName]
    )
    if (
      String((grant.rows[0] as { policy_state?: unknown } | undefined)?.policy_state ?? '') !==
      'active'
    ) {
      return false
    }
    const invocation = await db.query(
      `SELECT id, status, attempt_generation, lease_expires_at
         FROM plugin_workload_sdk_invocations
        WHERE id = $1
          AND recipe_namespace = $2
          AND recipe_name = $3
        FOR UPDATE`,
      [input.invocationId, input.recipeNamespace, input.recipeName]
    )
    const invocationRow = invocation.rows[0] as Record<string, unknown> | undefined
    if (
      !invocationRow ||
      invocationRow.status !== 'in_progress' ||
      Number(invocationRow.attempt_generation) !== input.attemptGeneration ||
      !invocationRow.lease_expires_at ||
      new Date(invocationRow.lease_expires_at as string).getTime() <= Date.now()
    ) {
      return false
    }
    const providerAttempt = await db.query(
      `SELECT id
         FROM plugin_workload_sdk_provider_attempts
        WHERE id = $1
          AND invocation_id = $2
          AND recipe_namespace = $3
          AND recipe_name = $4
          AND attempt_generation = $5
          AND target_ref = $6
          AND status = 'reserved'
        FOR UPDATE`,
      [
        input.providerAttemptId,
        input.invocationId,
        input.recipeNamespace,
        input.recipeName,
        input.attemptGeneration,
        input.targetRef,
      ]
    )
    if (providerAttempt.rows.length !== 1) return false
    // Opportunistic cleanup bounds the one-shot registry without retaining any
    // credentials or ticket bodies.
    await db.query(
      `DELETE FROM plugin_workload_sdk_credential_ticket_jtis WHERE expires_at <= now()`
    )
    const result = await db.query(
      `INSERT INTO plugin_workload_sdk_credential_ticket_jtis
         (jti, recipe_namespace, recipe_name, invocation_id, target_ref, attempt_generation,
          provider_attempt_id, expires_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE EXISTS (
          SELECT 1 FROM plugin_workload_sdk_provider_attempts
           WHERE id = $7
             AND invocation_id = $4
             AND recipe_namespace = $2
             AND recipe_name = $3
             AND attempt_generation = $6
             AND target_ref = $5
             AND status = 'reserved'
        )
       ON CONFLICT (jti) DO NOTHING`,
      [
        input.jti,
        input.recipeNamespace,
        input.recipeName,
        input.invocationId,
        input.targetRef,
        input.attemptGeneration,
        input.providerAttemptId,
        input.expiresAt,
      ]
    )
    if ((result.rowCount ?? 0) !== 1) return false
    const promoted = await db.query(
      `UPDATE plugin_workload_sdk_provider_attempts
          SET credential_jti = $2, status = 'in_progress'
        WHERE id = $1 AND status = 'reserved'`,
      [input.providerAttemptId, input.jti]
    )
    if ((promoted.rowCount ?? 0) === 1) return true
    // The JTI insert and the reservation promotion are one state transition.
    // Remove the orphaned registry row before committing a false result so a
    // race cannot leave a redeemable ticket with no physical attempt owner.
    await db.query(`DELETE FROM plugin_workload_sdk_credential_ticket_jtis WHERE jti = $1`, [
      input.jti,
    ])
    return false
  })
}

/** Atomically consumes a ticket identity after all binding/policy checks pass. */
export async function redeemPluginWorkloadSdkCredentialTicketJti(input: {
  jti: string
  recipeNamespace: string
  recipeName: string
  invocationId: string
  targetRef: string
  attemptGeneration: number
  providerAttemptId: string
}): Promise<boolean> {
  return withTransaction(async db => {
    const recipeLock = `plugin_workload_sdk:${input.recipeNamespace}/${input.recipeName}`
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])
    const grant = await db.query(
      `SELECT policy_state
         FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND capability_family = 'promptBridge'
        FOR UPDATE`,
      [input.recipeNamespace, input.recipeName]
    )
    if (
      String((grant.rows[0] as { policy_state?: unknown } | undefined)?.policy_state ?? '') !==
      'active'
    ) {
      return false
    }
    const result = await db.query(
      `UPDATE plugin_workload_sdk_credential_ticket_jtis AS ticket
          SET redeemed_at = now()
        WHERE ticket.jti = $1
          AND ticket.recipe_namespace = $2
          AND ticket.recipe_name = $3
          AND ticket.invocation_id = $4
          AND ticket.target_ref = $5
          AND ticket.attempt_generation = $6
          AND ticket.provider_attempt_id = $7
          AND ticket.redeemed_at IS NULL
          AND ticket.expires_at > now()
          AND EXISTS (
            SELECT 1
              FROM plugin_workload_sdk_invocations invocation
             WHERE invocation.id = ticket.invocation_id
               AND invocation.recipe_namespace = ticket.recipe_namespace
               AND invocation.recipe_name = ticket.recipe_name
               AND invocation.method = 'promptBridge'
               AND invocation.status = 'in_progress'
               AND invocation.attempt_generation = ticket.attempt_generation
               AND invocation.lease_expires_at > now()
          )
          AND EXISTS (
            SELECT 1
              FROM plugin_workload_sdk_invocation_attempts receipt
             WHERE receipt.invocation_id = ticket.invocation_id
               AND receipt.recipe_namespace = ticket.recipe_namespace
               AND receipt.recipe_name = ticket.recipe_name
               AND receipt.attempt_generation = ticket.attempt_generation
               AND receipt.method = 'promptBridge'
               AND receipt.status = 'in_progress'
               AND receipt.lease_expires_at > now()
          )
          AND EXISTS (
            SELECT 1
              FROM plugin_workload_sdk_provider_attempts attempt
             WHERE attempt.id = ticket.provider_attempt_id
               AND attempt.invocation_id = ticket.invocation_id
               AND attempt.recipe_namespace = ticket.recipe_namespace
               AND attempt.recipe_name = ticket.recipe_name
               AND attempt.attempt_generation = ticket.attempt_generation
               AND attempt.target_ref = ticket.target_ref
               AND attempt.status = 'in_progress'
          )`,
      [
        input.jti,
        input.recipeNamespace,
        input.recipeName,
        input.invocationId,
        input.targetRef,
        input.attemptGeneration,
        input.providerAttemptId,
      ]
    )
    return (result.rowCount ?? 0) === 1
  })
}

export async function updateInvocationStatus(
  id: string,
  status: PluginWorkloadSdkInvocationStatus,
  opts: {
    completed?: boolean
    recipeNamespace?: string
    recipeName?: string
    expectedAttemptGeneration?: number
    leaseSeconds?: number
    /**
     * Optimistic-concurrency guard: when set, the UPDATE only applies if the
     * row is currently in this status. Used to transition accepted → delivered
     * exactly once without clobbering a terminal 'failed'.
     */
    expectedCurrentStatus?: PluginWorkloadSdkInvocationStatus
  } = {}
): Promise<boolean> {
  // Every in-progress invocation must carry a lease. Without this guard an
  // older rolling-update writer can create a v2 row that the stale sweep can
  // never identify, leaving the idempotency key permanently wedged.
  // The terminal branch below also makes identical completion reports
  // idempotent while preserving the expected-status CAS for new transitions.
  const leaseSeconds = opts.leaseSeconds
  if (
    status === 'in_progress' &&
    (typeof leaseSeconds !== 'number' || !Number.isInteger(leaseSeconds) || leaseSeconds <= 0)
  ) {
    return false
  }
  const values: unknown[] = [id, status, opts.completed ?? false, leaseSeconds ?? 0]
  let bindingClause = ''
  if (opts.recipeNamespace !== undefined && opts.recipeName !== undefined) {
    values.push(opts.recipeNamespace, opts.recipeName)
    bindingClause = ` AND recipe_namespace = $${values.length - 1} AND recipe_name = $${values.length}`
  }
  let expectedStatusPlaceholder = ''
  if (opts.expectedCurrentStatus !== undefined) {
    values.push(opts.expectedCurrentStatus)
    expectedStatusPlaceholder = `$${values.length}`
  }
  let generationGuardClause = ''
  if (opts.expectedAttemptGeneration !== undefined) {
    values.push(opts.expectedAttemptGeneration)
    generationGuardClause = ` AND attempt_generation = $${values.length}`
  }
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE plugin_workload_sdk_invocations
       SET status = $2,
           updated_at = now(),
           lease_expires_at = CASE
             WHEN $2 = 'in_progress' AND $4 > 0
               THEN now() + interval '1 second' * $4
             ELSE NULL
           END,
           completed_at = CASE WHEN $3 THEN now() ELSE NULL END
       WHERE id = $1${bindingClause}
         AND (
           ${expectedStatusPlaceholder ? `status = ${expectedStatusPlaceholder}` : 'TRUE'}
           OR (status = $2 AND $2 NOT IN ('in_progress', 'accepted'))
         )${generationGuardClause}`,
      values
    )
    if ((result.rowCount ?? 0) === 0) return false
    const generation =
      opts.expectedAttemptGeneration ??
      Number(
        (
          (
            await db.query(
              `SELECT attempt_generation FROM plugin_workload_sdk_invocations WHERE id = $1`,
              [id]
            )
          ).rows[0] as { attempt_generation?: unknown } | undefined
        )?.attempt_generation ?? 1
      )
    await db.query(
      `UPDATE plugin_workload_sdk_invocation_attempts
          SET status = $3,
              lease_expires_at = CASE
                WHEN $3 = 'in_progress' AND $4 > 0
                  THEN now() + interval '1 second' * $4
                ELSE NULL
              END,
              completed_at = CASE WHEN $2 THEN now() ELSE NULL END
        WHERE invocation_id = $1 AND attempt_generation = $5`,
      [id, opts.completed ?? false, status, opts.leaseSeconds ?? 0, generation]
    )
    return true
  })
}

/**
 * Atomically claims the next physical attempt for a failed invocation. The
 * generation is the fencing token: every ticket, usage receipt, and terminal
 * status update must carry it, so a late result from an earlier attempt cannot
 * close a newer retry (ABA protection).
 */
export async function reviveFailedInvocation(input: {
  id: string
  recipeNamespace: string
  recipeName: string
  leaseSeconds: number
}): Promise<number | null> {
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE plugin_workload_sdk_invocations
          SET status = 'in_progress',
              attempt_generation = attempt_generation + 1,
              updated_at = now(),
              lease_expires_at = now() + interval '1 second' * $4,
              completed_at = NULL
        WHERE id = $1
          AND recipe_namespace = $2
          AND recipe_name = $3
          AND status = 'failed'
        RETURNING *`,
      [input.id, input.recipeNamespace, input.recipeName, input.leaseSeconds]
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    const invocation = mapInvocationRow(row)
    await insertAttemptReceipt(db, invocation)
    return invocation.attemptGeneration
  })
}

/**
 * Close stale in_progress invocations conservatively as provider_unavailable
 * (mcp-host restart recovery — plan §2.4). A provider call may have executed
 * before the host disappeared, so marking the row failed would allow the
 * idempotency authorizer to revive it and create a second billable call. The
 * terminal provider_unavailable state is intentionally not auto-revivable;
 * callers must choose a fresh idempotency key after an operator investigates.
 * Returns the number of rows transitioned.
 */
export async function failStaleInvocations(olderThanSeconds: number): Promise<number> {
  return withTransaction(db => failStaleInvocationsInTransaction(olderThanSeconds, db))
}

/**
 * Transaction-scoped stale recovery primitive. Keeping the transaction
 * injectable makes the row-lock/ledger race testable against a real database
 * and lets callers that already own a control-plane transaction preserve the
 * same atomic fencing boundary as the scheduled sweeper.
 */
export async function failStaleInvocationsInTransaction(
  olderThanSeconds: number,
  db: DbClient
): Promise<number> {
  const timeoutSeconds = Math.max(1, Math.floor(olderThanSeconds))
  const result = await db.query(
    `UPDATE plugin_workload_sdk_invocations
       SET status = 'provider_unavailable', updated_at = now(), completed_at = now()
         WHERE status = 'in_progress'
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at < now())
           OR (
             lease_expires_at IS NULL
             AND updated_at < now() - interval '1 second' * $1
           )
         )
       RETURNING id, attempt_generation`,
    [timeoutSeconds]
  )
  for (const row of result.rows as Array<{ id: string; attempt_generation: number }>) {
    const physicalAttempts = await db.query(
      `SELECT id, recipe_namespace, recipe_name, attempt_generation,
                attempt_index, target_ref, provider, model, credential_slot
           FROM plugin_workload_sdk_provider_attempts
          WHERE invocation_id = $1
            AND attempt_generation = $2
            AND status IN ('reserved', 'in_progress', 'complete', 'failed')
          FOR UPDATE`,
      [row.id, row.attempt_generation]
    )
    for (const attempt of physicalAttempts.rows as Array<Record<string, unknown>>) {
      // The host has disappeared, so no current JWT can prove a host_ref.
      // Persist an unattributed unknown outcome instead of inventing one
      // from recipe names; the physical-attempt PK makes this idempotent.
      await db.query(
        `INSERT INTO plugin_workload_sdk_spend_outcomes
             (provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
              attempt_generation, attempt_index, target_ref, host_ref, provider, model,
              credential_slot, outcome, reason, input_tokens, output_tokens, usage_request_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, 'unknown',
                   'stale_lease', NULL, NULL, NULL)
           ON CONFLICT (provider_attempt_id) DO NOTHING`,
        [
          String(attempt.id),
          row.id,
          String(attempt.recipe_namespace),
          String(attempt.recipe_name),
          Number(attempt.attempt_generation),
          Number(attempt.attempt_index),
          String(attempt.target_ref),
          String(attempt.provider),
          String(attempt.model),
          String(attempt.credential_slot),
        ]
      )
    }
    await db.query(
      `UPDATE plugin_workload_sdk_invocation_attempts
            SET status = 'provider_unavailable', lease_expires_at = NULL, completed_at = now()
          WHERE invocation_id = $1 AND attempt_generation = $2`,
      [row.id, row.attempt_generation]
    )
    await db.query(
      `UPDATE plugin_workload_sdk_provider_attempts
            SET status = 'provider_unavailable', lease_expires_at = NULL, completed_at = now()
          WHERE invocation_id = $1
            AND attempt_generation = $2
            AND status IN ('reserved', 'in_progress')`,
      [row.id, row.attempt_generation]
    )
  }
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
export async function prunePluginWorkloadSdkExpiredIdempotencyInTransaction(
  db: DbClient
): Promise<number> {
  // Child receipts and one-shot JTIs have no useful life once the parent
  // idempotency reservation expires. Delete them in one transaction so
  // usage and ticket lookups cannot observe orphaned authority.
  await db.query(
    `DELETE FROM plugin_workload_sdk_credential_ticket_jtis jt
        USING plugin_workload_sdk_invocations inv
       WHERE jt.invocation_id = inv.id
         AND inv.created_at < now() - interval '1 hour' * $1
         AND inv.status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  await db.query(
    `DELETE FROM plugin_workload_sdk_invocation_attempts attempts
        USING plugin_workload_sdk_invocations inv
       WHERE attempts.invocation_id = inv.id
         AND inv.created_at < now() - interval '1 hour' * $1
         AND inv.status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  // Unlink the durable Codex ledger before deleting SDK attempt rows.
  // 0108 also SET NULLs the FK on delete; this UPDATE keeps prune from
  // depending on that constraint name and never CASCADE-deletes spend.
  await db.query(
    `UPDATE llm_provider_attempts a
          SET plugin_workload_sdk_provider_attempt_id = NULL
         FROM plugin_workload_sdk_provider_attempts attempts
         JOIN plugin_workload_sdk_invocations inv
           ON attempts.invocation_id = inv.id
        WHERE a.plugin_workload_sdk_provider_attempt_id = attempts.id
          AND inv.created_at < now() - interval '1 hour' * $1
          AND inv.status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  await db.query(
    `DELETE FROM plugin_workload_sdk_provider_attempts attempts
        USING plugin_workload_sdk_invocations inv
       WHERE attempts.invocation_id = inv.id
         AND inv.created_at < now() - interval '1 hour' * $1
         AND inv.status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  const result = await db.query(
    `DELETE FROM plugin_workload_sdk_invocations
       WHERE created_at < now() - interval '1 hour' * $1
         AND status <> 'in_progress'`,
    [IDEMPOTENCY_TTL_HOURS]
  )
  return result.rowCount ?? 0
}

export async function prunePluginWorkloadSdkExpiredIdempotency(): Promise<number> {
  return withTransaction(prunePluginWorkloadSdkExpiredIdempotencyInTransaction)
}

// ─── Quota counters (historical-only, issue #348) ────────────────────────
// Per-run/period quota enforcement was removed (issue #348): nothing writes
// plugin_workload_sdk_quota_counters anymore (the enforcement writers
// consumePeriodQuota / resolveQuotaPeriodStart / getPeriodQuotaUsage and the
// eager epoch sentinel were deleted so a future re-wire cannot resurrect the
// never-resetting epoch bucket). Existing rows — including stale epoch
// sentinels — are inert historical data; getQuotaCounters keeps serving them
// to the admin read path. Hard removal of the table is a separate follow-up.

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

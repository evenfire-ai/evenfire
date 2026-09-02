import type { DbClient } from '../db.js'
import {
  type LlmProviderAttemptRow,
  isLinkedCodexInFlightWithoutUsage,
  linkedCodexExactUsage,
  loadLlmProviderAttemptBySdkAttemptId,
} from './llmProviderAttemptStore.js'
import {
  type PersistableSpend,
  type SpendOutcomeRow,
  insertSpendOutcomeFloor,
  isOauthBrokerProvider,
  loadSpendOutcomeRow,
  settlePriorProviderAttemptFloors,
  spendFloor,
} from './pluginWorkloadSdkSpendLedger.js'
import { withTraceIngestTransaction } from './tracing/pools.js'
import { projectAcceptedUsageEvents } from './tracing/usageProjection.js'
import { ingestUsageEventsInTransaction } from './usageEvents.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PromptBridgeFinalizationStatus = 'complete' | 'failed' | 'provider_unavailable'

export type PromptBridgeFinalizationUsage = {
  llmSecretName: string
  callerRef: string
  fallbackUsed: boolean
  attemptCount: number
  inputTokens: number
  outputTokens: number
}

export type PromptBridgeFinalizationInput = {
  invocationId: string
  recipeNamespace: string
  recipeName: string
  hostRef: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  status: PromptBridgeFinalizationStatus
  target: {
    targetRef: string
    provider: string
    model: string
    credentialSlot: string
  }
  reason: string
  usage?: PromptBridgeFinalizationUsage
}

export type PromptBridgeFinalizationResult = {
  invocationId: string
  providerAttemptId: string
  status: PromptBridgeFinalizationStatus
  outcome: 'exact' | 'unknown' | 'not_executed'
  idempotent: boolean
  usageAccepted: boolean
}

export type PromptBridgeFinalizationErrorCode =
  | 'not_found'
  | 'binding_mismatch'
  | 'stale_attempt'
  | 'conflict'
  | 'ledger_pending'
  | 'invalid_request'

export class PromptBridgeFinalizationError extends Error {
  constructor(
    readonly code: PromptBridgeFinalizationErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'PromptBridgeFinalizationError'
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new PromptBridgeFinalizationError('invalid_request', `${field} must be a UUID`, 400)
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new PromptBridgeFinalizationError('invalid_request', `${field} is required`, 400)
  }
}

function validateUsageFields(usage: PromptBridgeFinalizationUsage): void {
  requireNonEmpty(usage.callerRef, 'usage.callerRef')
  if (!Number.isInteger(usage.attemptCount) || usage.attemptCount < 1 || usage.attemptCount > 4) {
    throw new PromptBridgeFinalizationError('invalid_request', 'usage.attemptCount is invalid', 400)
  }
  if (
    !Number.isInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    throw new PromptBridgeFinalizationError(
      'invalid_request',
      'usage token counts must be non-negative integers',
      400
    )
  }
}

/**
 * Credential-slot and secret-name emptiness follow the persisted attempt
 * provider. The request body must not choose whether those checks run.
 */
function assertPersistedAuthModeCredentialRules(
  persistedProvider: string,
  input: PromptBridgeFinalizationInput
): void {
  if (isOauthBrokerProvider(persistedProvider)) return
  requireNonEmpty(input.target.credentialSlot, 'target.credentialSlot')
  if (input.usage) {
    requireNonEmpty(input.usage.llmSecretName, 'usage.llmSecretName')
  }
}

function validateInput(input: PromptBridgeFinalizationInput): void {
  requireUuid(input.invocationId, 'invocationId')
  requireUuid(input.providerAttemptId, 'providerAttemptId')
  requireNonEmpty(input.recipeNamespace, 'recipeNamespace')
  requireNonEmpty(input.recipeName, 'recipeName')
  requireNonEmpty(input.hostRef, 'hostRef')
  requireNonEmpty(input.reason, 'reason')
  if (!Number.isInteger(input.attemptGeneration) || input.attemptGeneration < 1) {
    throw new PromptBridgeFinalizationError('invalid_request', 'attemptGeneration is required', 400)
  }
  if (!Number.isInteger(input.providerAttemptIndex) || input.providerAttemptIndex < 1) {
    throw new PromptBridgeFinalizationError(
      'invalid_request',
      'providerAttemptIndex is required',
      400
    )
  }
  requireNonEmpty(input.target.targetRef, 'target.targetRef')
  requireNonEmpty(input.target.provider, 'target.provider')
  requireNonEmpty(input.target.model, 'target.model')
  if (input.usage) validateUsageFields(input.usage)
  if (input.status === 'complete') {
    if (!input.usage) {
      throw new PromptBridgeFinalizationError(
        'invalid_request',
        'complete finalization requires exact usage',
        400
      )
    }
  } else if (input.usage) {
    throw new PromptBridgeFinalizationError(
      'invalid_request',
      'non-complete finalization cannot claim exact usage',
      400
    )
  }
}

/**
 * The floor this finalization may freeze. A usage-ready Codex row always wins
 * for an oauth-broker attempt regardless of the status the host declared
 * (Addendum A.4 "best-floor writers"): the subscription was already billed and
 * the exact token pair is the strongest fact available at write time.
 */
function resolvePersistableSpend(
  status: PromptBridgeFinalizationStatus,
  oauthBroker: boolean,
  linked: Pick<
    LlmProviderAttemptRow,
    'status' | 'outcome' | 'usageInputTokens' | 'usageOutputTokens'
  > | null,
  usage: PromptBridgeFinalizationUsage | undefined
): PersistableSpend {
  if (!oauthBroker) {
    if (status === 'complete') {
      // validateInput already guarantees this; the throw is a fail-loud guard,
      // never a fallback that would fabricate a token pair.
      if (!usage) {
        throw new PromptBridgeFinalizationError(
          'invalid_request',
          'complete finalization requires exact usage',
          400
        )
      }
      return { outcome: 'exact', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    }
    return spendFloor(status === 'failed' ? 'not_executed' : 'unknown')
  }
  const exact = linkedCodexExactUsage(linked)
  if (exact) return { outcome: 'exact', ...exact }
  if (status === 'failed' && !linked) return spendFloor('not_executed')
  return spendFloor('unknown')
}

function replayOutcomeCompatible(
  input: PromptBridgeFinalizationInput,
  row: SpendOutcomeRow
): boolean {
  const oauthBroker = isOauthBrokerProvider(row.provider)
  if (!oauthBroker) {
    const expectedOutcome =
      input.status === 'complete' ? 'exact' : input.status === 'failed' ? 'not_executed' : 'unknown'
    if (row.outcome !== expectedOutcome) return false
    return (
      expectedOutcome !== 'exact' ||
      (Number(row.input_tokens) === input.usage?.inputTokens &&
        Number(row.output_tokens) === input.usage?.outputTokens)
    )
  }
  // The host is not the source of truth for oauth-broker spend (Codex is), so
  // its declared status cannot contradict an `exact` floor. Only a
  // `not_executed` floor — which proves no Codex row ever existed — can
  // contradict a host that claims the provider ran.
  if (input.status === 'failed') return true
  return row.outcome === 'exact' || row.outcome === 'unknown'
}

function spendBindingMatches(row: SpendOutcomeRow, input: PromptBridgeFinalizationInput): boolean {
  return (
    row.invocation_id === input.invocationId &&
    row.recipe_namespace === input.recipeNamespace &&
    row.recipe_name === input.recipeName &&
    Number(row.attempt_generation) === input.attemptGeneration &&
    Number(row.attempt_index) === input.providerAttemptIndex &&
    row.target_ref === input.target.targetRef &&
    (row.host_ref === null || row.host_ref === input.hostRef) &&
    row.provider === input.target.provider &&
    row.model === input.target.model &&
    row.credential_slot === input.target.credentialSlot
  )
}

export type SpendOutcomeView = {
  /** The immutable floor exactly as it sits in the table. */
  persisted: SpendOutcomeRow
  /** Linked Codex row, or null for a non-oauth provider / no link. */
  linked: LlmProviderAttemptRow | null
  /** Truth derived from the floor plus the linked Codex usage. */
  effective: PersistableSpend
}

/**
 * Derive the effective spend from the immutable floor plus the linked Codex
 * row. Only `unknown` is derivable: `exact` and `not_executed` are terminal
 * facts. The derivation is monotone — a floor can only ever be improved by a
 * Codex row that has already landed — so a verdict taken over the floor stays
 * stable across replays while the reported outcome catches up.
 */
export function deriveEffectiveSpend(
  persisted: Pick<SpendOutcomeRow, 'provider' | 'outcome' | 'input_tokens' | 'output_tokens'>,
  linked: Pick<LlmProviderAttemptRow, 'outcome' | 'usageInputTokens' | 'usageOutputTokens'> | null
): PersistableSpend {
  if (persisted.outcome === 'exact') {
    if (persisted.input_tokens == null || persisted.output_tokens == null) {
      // token_pair_check makes this impossible; if it happens the table is
      // corrupt and silently reporting `exact` with no tokens would undercount.
      throw new Error('exact spend outcome persisted without a token pair')
    }
    return {
      outcome: 'exact',
      inputTokens: Number(persisted.input_tokens),
      outputTokens: Number(persisted.output_tokens),
    }
  }
  if (persisted.outcome === 'unknown' && isOauthBrokerProvider(persisted.provider)) {
    const exact = linkedCodexExactUsage(linked)
    if (exact) return { outcome: 'exact', ...exact }
  }
  return spendFloor(persisted.outcome)
}

/** The single reader of the spend ledger. */
export async function loadSpendOutcome(
  db: DbClient,
  providerAttemptId: string
): Promise<SpendOutcomeView | null> {
  const persisted = await loadSpendOutcomeRow(db, providerAttemptId)
  if (!persisted) return null
  const linked = isOauthBrokerProvider(persisted.provider)
    ? await loadLlmProviderAttemptBySdkAttemptId(db, providerAttemptId)
    : null
  return { persisted, linked, effective: deriveEffectiveSpend(persisted, linked) }
}

/**
 * The only idempotent return point. Purely read-only: the floor is never
 * rewritten, so a replay can neither double-bill nor invalidate a verdict it
 * already received.
 */
function replayExistingOutcome(
  view: SpendOutcomeView,
  input: PromptBridgeFinalizationInput
): PromptBridgeFinalizationResult {
  const { persisted, linked } = view
  assertPersistedAuthModeCredentialRules(persisted.provider, input)
  // N-07: re-anchoring to the JWT's recipe binding runs BEFORE any state
  // oracle, so a foreign caller cannot learn ledger_pending/exact/unknown.
  if (!spendBindingMatches(persisted, input)) {
    throw new PromptBridgeFinalizationError(
      'conflict',
      'provider attempt was finalized with a different immutable outcome',
      409
    )
  }
  // Decided from the floor plus the linked Codex row, never from the
  // caller-chosen finalize status.
  if (persisted.outcome === 'unknown' && linked && isLinkedCodexInFlightWithoutUsage(linked)) {
    throw new PromptBridgeFinalizationError(
      'ledger_pending',
      'linked Codex attempt has not finalized usage yet',
      409,
      true
    )
  }
  // N-05: judged against the immutable floor, so the verdict cannot change
  // between two replays of the same request.
  if (!replayOutcomeCompatible(input, persisted)) {
    throw new PromptBridgeFinalizationError(
      'conflict',
      'provider attempt was finalized with a different immutable outcome',
      409
    )
  }
  return {
    invocationId: input.invocationId,
    providerAttemptId: input.providerAttemptId,
    status: input.status,
    outcome: view.effective.outcome,
    idempotent: true,
    usageAccepted: persisted.outcome === 'exact' && !isOauthBrokerProvider(persisted.provider),
  }
}

/**
 * Finalize one physical promptBridge attempt and its logical invocation in a
 * single trace-ingest transaction. Exact usage is inserted through the same
 * receipt binder as the normal usage endpoint.
 *
 * The spend row written here is an immutable FLOOR — the least spend provable
 * at write time — and is never updated. For an oauth-broker attempt the
 * effective outcome is derived at read time from the linked
 * `llm_provider_attempts` usage, so an `unknown` floor whose Codex usage lands
 * later reports `exact` without any write. A `failed`/`provider_unavailable`
 * finalization can therefore legitimately report `exact`: the host's own
 * account of the attempt is preserved in the row's `reason`.
 */
export async function finalizePromptBridge(
  input: PromptBridgeFinalizationInput
): Promise<PromptBridgeFinalizationResult> {
  validateInput(input)
  return withTraceIngestTransaction(db => finalizePromptBridgeInTransaction(input, db))
}

export async function finalizePromptBridgeInTransaction(
  input: PromptBridgeFinalizationInput,
  db: DbClient
): Promise<PromptBridgeFinalizationResult> {
  validateInput(input)

  const recipeLock = `plugin_workload_sdk:${input.recipeNamespace}/${input.recipeName}`
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [recipeLock])

  const existing = await loadSpendOutcome(db, input.providerAttemptId)
  if (existing) return replayExistingOutcome(existing, input)

  const invocationResult = await db.query(
    `SELECT id, recipe_namespace, recipe_name, method, status, attempt_generation
       FROM plugin_workload_sdk_invocations
      WHERE id = $1
        AND recipe_namespace = $2
        AND recipe_name = $3
      FOR UPDATE`,
    [input.invocationId, input.recipeNamespace, input.recipeName]
  )
  const invocation = invocationResult.rows[0] as Record<string, unknown> | undefined
  if (!invocation) {
    throw new PromptBridgeFinalizationError('not_found', 'invocation not found', 404)
  }
  if (invocation.method !== 'promptBridge') {
    throw new PromptBridgeFinalizationError('binding_mismatch', 'invocation method mismatch', 403)
  }
  if (Number(invocation.attempt_generation) !== input.attemptGeneration) {
    throw new PromptBridgeFinalizationError('stale_attempt', 'attempt generation is stale', 409)
  }

  const receiptResult = await db.query(
    `SELECT invocation_id, recipe_namespace, recipe_name, attempt_generation, method, status
       FROM plugin_workload_sdk_invocation_attempts
      WHERE invocation_id = $1
        AND recipe_namespace = $2
        AND recipe_name = $3
        AND attempt_generation = $4
      FOR UPDATE`,
    [input.invocationId, input.recipeNamespace, input.recipeName, input.attemptGeneration]
  )
  const receipt = receiptResult.rows[0] as Record<string, unknown> | undefined
  if (!receipt || receipt.method !== 'promptBridge') {
    throw new PromptBridgeFinalizationError(
      'not_found',
      'promptBridge attempt receipt not found',
      404
    )
  }

  const providerResult = await db.query(
    `SELECT id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
            attempt_index, target_ref, provider, model, credential_slot, status
       FROM plugin_workload_sdk_provider_attempts
      WHERE id = $1
      FOR UPDATE`,
    [input.providerAttemptId]
  )
  const providerAttempt = providerResult.rows[0] as Record<string, unknown> | undefined
  if (!providerAttempt) {
    throw new PromptBridgeFinalizationError('not_found', 'provider attempt not found', 404)
  }
  // N-19: shape before binding, matching `replayExistingOutcome`. A non-oauth
  // finalization that omits `target.credentialSlot` is a malformed request, and
  // both paths must classify it as 400 `invalid_request`. Running the binding
  // comparison first would report the same body as 403 `binding_mismatch` here
  // and 400 on replay, so the same defect got two different verdicts.
  assertPersistedAuthModeCredentialRules(String(providerAttempt.provider), input)
  if (
    String(providerAttempt.invocation_id) !== input.invocationId ||
    String(providerAttempt.recipe_namespace) !== input.recipeNamespace ||
    String(providerAttempt.recipe_name) !== input.recipeName ||
    Number(providerAttempt.attempt_generation) !== input.attemptGeneration ||
    Number(providerAttempt.attempt_index) !== input.providerAttemptIndex ||
    String(providerAttempt.target_ref) !== input.target.targetRef ||
    String(providerAttempt.provider) !== input.target.provider ||
    String(providerAttempt.model) !== input.target.model ||
    String(providerAttempt.credential_slot) !== input.target.credentialSlot
  ) {
    throw new PromptBridgeFinalizationError(
      'binding_mismatch',
      'provider attempt binding mismatch',
      403
    )
  }

  const currentInvocationStatus = String(invocation.status)
  const currentReceiptStatus = String(receipt.status)
  const currentProviderStatus = String(providerAttempt.status)
  const compatibleStatuses = new Set(['in_progress', input.status])
  // SDK-only success is finalized atomically by this service, so the normal
  // path leaves the physical attempt in_progress until usage/outcome commit.
  // Accept terminal provider states on the unknown path as a recovery fence:
  // older hosts and an ACK race may have marked the physical row complete (or
  // provider_unavailable) before the durable spend row was inserted.  The
  // unknown ledger entry is then the only honest accounting result and still
  // prevents replay.
  const compatibleProviderStatuses =
    input.status === 'complete'
      ? new Set(['in_progress', 'complete'])
      : input.status === 'failed'
        ? new Set(['reserved', 'in_progress', 'failed'])
        : new Set(['reserved', 'in_progress', 'provider_unavailable', 'complete', 'failed'])
  if (
    !compatibleStatuses.has(currentInvocationStatus) ||
    !compatibleStatuses.has(currentReceiptStatus) ||
    !compatibleProviderStatuses.has(currentProviderStatus)
  ) {
    throw new PromptBridgeFinalizationError(
      'conflict',
      'attempt already has a conflicting terminal outcome',
      409
    )
  }

  const oauthBroker = isOauthBrokerProvider(String(providerAttempt.provider))
  const linkedCodex = oauthBroker
    ? await loadLlmProviderAttemptBySdkAttemptId(db, input.providerAttemptId)
    : null
  if (oauthBroker && input.status === 'complete' && linkedCodex) {
    if (isLinkedCodexInFlightWithoutUsage(linkedCodex)) {
      throw new PromptBridgeFinalizationError(
        'ledger_pending',
        'linked Codex attempt has not finalized usage yet',
        409,
        true
      )
    }
  }
  const spend = resolvePersistableSpend(input.status, oauthBroker, linkedCodex, input.usage)
  // N-17: only point a usage_request_id at a usage_events row that is really
  // written. Codex spend is ingested by the proxy finalize, not here.
  const willIngestUsage = input.status === 'complete' && !oauthBroker
  // Codex already billed this attempt, so closing the invocation `failed`
  // would leave it revivable (reviveFailedInvocation gates only on
  // status = 'failed') and the same idempotency key could launch a second
  // billable Codex call. provider_unavailable is the non-revivable terminal
  // state for exactly this situation. The RESULT still echoes input.status:
  // mcp-host's controlApiClient requires result.status === body.status.
  const expectedStatus: PromptBridgeFinalizationStatus =
    oauthBroker && spend.outcome === 'exact' && input.status === 'failed'
      ? 'provider_unavailable'
      : input.status
  let usageAccepted = false

  // Promote the immutable physical and attempt receipts before exact usage is
  // passed through the normal binder. The enclosing transaction rolls these
  // transitions back if usage validation/projection fails.
  await db.query(
    `UPDATE plugin_workload_sdk_provider_attempts
        SET status = $2,
            completed_at = now(),
            lease_expires_at = NULL,
            usage_request_id = CASE WHEN $3 THEN $1 ELSE usage_request_id END
      WHERE id = $1`,
    [input.providerAttemptId, expectedStatus, willIngestUsage]
  )
  await db.query(
    `UPDATE plugin_workload_sdk_invocation_attempts
        SET status = $2, completed_at = now(), lease_expires_at = NULL
      WHERE invocation_id = $1 AND attempt_generation = $3`,
    [input.invocationId, expectedStatus, input.attemptGeneration]
  )

  if (willIngestUsage) {
    const usage = input.usage!
    const event = {
      request_id: input.providerAttemptId,
      ts: new Date().toISOString(),
      run_id: null,
      host_ref: input.hostRef,
      context_ref: null,
      team_id: null,
      provider: input.target.provider,
      model: input.target.model,
      llm_secret_name: usage.llmSecretName,
      source_kind: 'plugin_workload_sdk',
      user_id: null,
      sender: usage.callerRef,
      channel_type: 'plugin_workload_sdk',
      recipe_name: input.recipeName,
      cron_job_id: null,
      task_id: null,
      iteration: null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_tokens_reported: false,
      prompt_bridge_metadata: {
        invocation_id: input.invocationId,
        target_ref: input.target.targetRef,
        credential_slot: input.target.credentialSlot,
        fallback_used: usage.fallbackUsed,
        attempt_count: usage.attemptCount,
        attempt_generation: input.attemptGeneration,
        provider_attempt_id: input.providerAttemptId,
        provider_attempt_index: input.providerAttemptIndex,
      },
    }
    const ingest = await ingestUsageEventsInTransaction([event], db, {
      recipeNamespace: input.recipeNamespace,
      recipeName: input.recipeName,
    })
    if (
      ingest.bindingViolation ||
      ingest.result.rejected > 0 ||
      ingest.result.accepted + ingest.result.duplicates !== 1
    ) {
      throw new PromptBridgeFinalizationError(
        'conflict',
        'exact provider usage could not be bound to its physical receipt',
        409
      )
    }
    if (ingest.acceptedEvents.length > 0) {
      await projectAcceptedUsageEvents(db, ingest.acceptedEvents, new Map(), {
        recipeNamespace: input.recipeNamespace,
        recipeName: input.recipeName,
        hostRef: input.hostRef,
      })
    }
    usageAccepted = true
  }

  await db.query(
    `UPDATE plugin_workload_sdk_invocations
        SET status = $2, updated_at = now(), completed_at = now(), lease_expires_at = NULL
      WHERE id = $1 AND attempt_generation = $3`,
    [input.invocationId, expectedStatus, input.attemptGeneration]
  )
  const insertedFloor = await insertSpendOutcomeFloor(
    db,
    {
      providerAttemptId: input.providerAttemptId,
      invocationId: input.invocationId,
      recipeNamespace: input.recipeNamespace,
      recipeName: input.recipeName,
      attemptGeneration: input.attemptGeneration,
      attemptIndex: input.providerAttemptIndex,
      targetRef: input.target.targetRef,
      hostRef: input.hostRef,
      provider: input.target.provider,
      model: input.target.model,
      credentialSlot: input.target.credentialSlot,
      reason: input.reason,
      usageRequestId: willIngestUsage ? input.providerAttemptId : null,
    },
    spend
  )

  // RP-539-003: a successful failover finalizes only its winner, so the
  // attempts it displaced would never reach this endpoint. They are terminal
  // and immutable by the reservation fence, so they can be discovered and
  // settled here without trusting the host to declare them.
  //
  // The index-1 skip is NOT a defensive optimization: `attempt_index < 1`
  // matches nothing by construction, because attempt_index starts at 1 and
  // UNIQUE (invocation_id, attempt_generation, attempt_index) forbids gaps.
  // The query is skipped because it is provably empty, not because it might be.
  if (input.providerAttemptIndex > 1) {
    await settlePriorProviderAttemptFloors(db, {
      invocationId: input.invocationId,
      attemptGeneration: input.attemptGeneration,
      attemptIndex: input.providerAttemptIndex,
      hostRef: input.hostRef,
    })
  }

  // The stale-lease sweeper can win the physical-attempt race between our
  // initial ledger lookup and this insert. Treat an identical existing outcome
  // as an idempotent replay and surface a stable conflict for incompatible
  // accounting, never a raw unique_violation/500.
  if (!insertedFloor) {
    const raced = await loadSpendOutcome(db, input.providerAttemptId)
    if (!raced) {
      throw new PromptBridgeFinalizationError(
        'conflict',
        'provider attempt outcome was concurrently finalized but is not readable',
        409
      )
    }
    return replayExistingOutcome(raced, input)
  }

  return {
    invocationId: input.invocationId,
    providerAttemptId: input.providerAttemptId,
    status: input.status,
    outcome: deriveEffectiveSpend(insertedFloor, linkedCodex).outcome,
    idempotent: false,
    usageAccepted,
  }
}

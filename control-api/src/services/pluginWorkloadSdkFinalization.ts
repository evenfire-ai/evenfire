import { PROVIDER_AUTH_MODE, isLlmProviderId } from '@clerum/llm-providers'
import type { DbClient } from '../db.js'
import {
  type LlmProviderAttemptRow,
  isLinkedCodexInFlightWithoutUsage,
  isLinkedCodexUsageReady,
  loadLlmProviderAttemptBySdkAttemptId,
} from './llmProviderAttemptStore.js'
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

function isOauthBrokerProvider(provider: string): boolean {
  return isLlmProviderId(provider) && PROVIDER_AUTH_MODE[provider] === 'oauth-broker'
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

function resolvePromptBridgeOutcome(
  status: PromptBridgeFinalizationStatus,
  oauthBroker: boolean,
  linked: Pick<
    LlmProviderAttemptRow,
    'status' | 'outcome' | 'usageInputTokens' | 'usageOutputTokens'
  > | null
): 'exact' | 'unknown' | 'not_executed' {
  if (!oauthBroker) {
    return status === 'complete' ? 'exact' : status === 'failed' ? 'not_executed' : 'unknown'
  }
  if (status === 'complete' && linked && isLinkedCodexUsageReady(linked)) {
    return 'exact'
  }
  if (status === 'failed' && !linked) return 'not_executed'
  return 'unknown'
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
  if (input.status === 'complete') return row.outcome === 'exact' || row.outcome === 'unknown'
  if (input.status === 'failed') {
    return row.outcome === 'not_executed' || row.outcome === 'unknown'
  }
  return row.outcome === 'unknown'
}

type SpendOutcomeRow = {
  provider_attempt_id: string
  invocation_id: string
  recipe_namespace: string
  recipe_name: string
  attempt_generation: number | string
  attempt_index: number | string
  target_ref: string
  host_ref: string | null
  provider: string
  model: string
  credential_slot: string
  outcome: 'exact' | 'unknown' | 'not_executed'
  input_tokens: number | string | null
  output_tokens: number | string | null
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

async function upgradeUnknownOauthSpendToExact(
  db: DbClient,
  existing: SpendOutcomeRow,
  input: PromptBridgeFinalizationInput,
  linked: Pick<LlmProviderAttemptRow, 'usageInputTokens' | 'usageOutputTokens'>
): Promise<PromptBridgeFinalizationResult> {
  assertPersistedAuthModeCredentialRules(existing.provider, input)
  if (!spendBindingMatches(existing, input)) {
    throw new PromptBridgeFinalizationError(
      'conflict',
      'provider attempt was finalized with a different immutable outcome',
      409
    )
  }
  const updated = await db.query(
    `UPDATE plugin_workload_sdk_spend_outcomes
        SET outcome = 'exact',
            input_tokens = $2,
            output_tokens = $3,
            usage_request_id = COALESCE(usage_request_id, $1)
      WHERE provider_attempt_id = $1
        AND outcome = 'unknown'
      RETURNING provider_attempt_id`,
    [input.providerAttemptId, linked.usageInputTokens, linked.usageOutputTokens]
  )
  if ((updated.rowCount ?? updated.rows.length) !== 1) {
    const raced = await db.query(
      `SELECT provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
              attempt_generation, attempt_index, target_ref, host_ref, provider,
              model, credential_slot, outcome, input_tokens, output_tokens
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [input.providerAttemptId]
    )
    const existingOutcome = raced.rows[0] as SpendOutcomeRow | undefined
    if (!existingOutcome) {
      throw new PromptBridgeFinalizationError(
        'conflict',
        'provider attempt outcome was concurrently finalized but is not readable',
        409
      )
    }
    return mapExistingOutcome(existingOutcome, input)
  }
  return {
    invocationId: input.invocationId,
    providerAttemptId: input.providerAttemptId,
    status: input.status,
    outcome: 'exact',
    idempotent: false,
    usageAccepted: false,
  }
}

function mapExistingOutcome(
  row: SpendOutcomeRow,
  input: PromptBridgeFinalizationInput
): PromptBridgeFinalizationResult {
  assertPersistedAuthModeCredentialRules(row.provider, input)
  if (!spendBindingMatches(row, input) || !replayOutcomeCompatible(input, row)) {
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
    outcome: row.outcome,
    idempotent: true,
    usageAccepted: row.outcome === 'exact' && !isOauthBrokerProvider(row.provider),
  }
}

/**
 * Finalize one physical promptBridge attempt and its logical invocation in a
 * single trace-ingest transaction. Exact usage is inserted through the same
 * receipt binder as the normal usage endpoint; unknown provider spend and
 * proven no-execution failures get immutable ledger rows instead of
 * disappearing behind a public provider_unavailable response.
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

  const existingResult = await db.query(
    `SELECT provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
            attempt_generation, attempt_index, target_ref, provider, model,
            credential_slot, host_ref, outcome, input_tokens, output_tokens
       FROM plugin_workload_sdk_spend_outcomes
      WHERE provider_attempt_id = $1`,
    [input.providerAttemptId]
  )
  const existing = existingResult.rows[0] as SpendOutcomeRow | undefined
  if (existing) {
    if (isOauthBrokerProvider(existing.provider)) {
      const linkedCodex = await loadLlmProviderAttemptBySdkAttemptId(db, input.providerAttemptId)
      // Upgrade and ledger_pending are decided from persisted spend + the
      // linked Codex row, not from the caller-chosen finalize status.
      if (
        existing.outcome === 'unknown' &&
        linkedCodex &&
        isLinkedCodexInFlightWithoutUsage(linkedCodex)
      ) {
        throw new PromptBridgeFinalizationError(
          'ledger_pending',
          'linked Codex attempt has not finalized usage yet',
          409,
          true
        )
      }
      if (existing.outcome === 'unknown' && linkedCodex && isLinkedCodexUsageReady(linkedCodex)) {
        return upgradeUnknownOauthSpendToExact(db, existing, input, linkedCodex)
      }
      if (
        existing.outcome === 'exact' &&
        linkedCodex &&
        isLinkedCodexUsageReady(linkedCodex) &&
        (Number(existing.input_tokens) !== Number(linkedCodex.usageInputTokens) ||
          Number(existing.output_tokens) !== Number(linkedCodex.usageOutputTokens))
      ) {
        throw new PromptBridgeFinalizationError(
          'conflict',
          'provider attempt was finalized with a different immutable outcome',
          409
        )
      }
    }
    return mapExistingOutcome(existing, input)
  }

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
  assertPersistedAuthModeCredentialRules(String(providerAttempt.provider), input)

  const expectedStatus = input.status
  const currentInvocationStatus = String(invocation.status)
  const currentReceiptStatus = String(receipt.status)
  const currentProviderStatus = String(providerAttempt.status)
  const compatibleStatuses = new Set(['in_progress', expectedStatus])
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
  const outcome = resolvePromptBridgeOutcome(input.status, oauthBroker, linkedCodex)
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
    [input.providerAttemptId, expectedStatus, input.status === 'complete']
  )
  await db.query(
    `UPDATE plugin_workload_sdk_invocation_attempts
        SET status = $2, completed_at = now(), lease_expires_at = NULL
      WHERE invocation_id = $1 AND attempt_generation = $3`,
    [input.invocationId, expectedStatus, input.attemptGeneration]
  )

  if (input.status === 'complete' && !oauthBroker) {
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
  const spendOutcomeInsert = await db.query(
    `INSERT INTO plugin_workload_sdk_spend_outcomes
       (provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
        attempt_generation, attempt_index, target_ref, host_ref, provider, model,
        credential_slot, outcome, reason, input_tokens, output_tokens, usage_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (provider_attempt_id) DO NOTHING
     RETURNING provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
               attempt_generation, attempt_index, target_ref, host_ref, provider,
               model, credential_slot, outcome, input_tokens, output_tokens`,
    [
      input.providerAttemptId,
      input.invocationId,
      input.recipeNamespace,
      input.recipeName,
      input.attemptGeneration,
      input.providerAttemptIndex,
      input.target.targetRef,
      input.hostRef,
      input.target.provider,
      input.target.model,
      input.target.credentialSlot,
      outcome,
      input.reason,
      oauthBroker ? (linkedCodex?.usageInputTokens ?? null) : (input.usage?.inputTokens ?? null),
      oauthBroker ? (linkedCodex?.usageOutputTokens ?? null) : (input.usage?.outputTokens ?? null),
      input.status === 'complete' ? input.providerAttemptId : null,
    ]
  )

  // The stale-lease sweeper can win the physical-attempt race between our
  // initial ledger lookup and this insert. Treat an identical existing outcome
  // as an idempotent replay and surface a stable conflict for incompatible
  // accounting, never a raw unique_violation/500.
  if ((spendOutcomeInsert.rowCount ?? spendOutcomeInsert.rows.length) === 0) {
    const raced = await db.query(
      `SELECT provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
              attempt_generation, attempt_index, target_ref, host_ref, provider,
              model, credential_slot, outcome, input_tokens, output_tokens
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [input.providerAttemptId]
    )
    const existingOutcome = raced.rows[0] as SpendOutcomeRow | undefined
    if (!existingOutcome) {
      throw new PromptBridgeFinalizationError(
        'conflict',
        'provider attempt outcome was concurrently finalized but is not readable',
        409
      )
    }
    return mapExistingOutcome(existingOutcome, input)
  }

  return {
    invocationId: input.invocationId,
    providerAttemptId: input.providerAttemptId,
    status: input.status,
    outcome,
    idempotent: false,
    usageAccepted,
  }
}

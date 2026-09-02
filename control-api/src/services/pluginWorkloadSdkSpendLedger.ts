import { PROVIDER_AUTH_MODE, isLlmProviderId } from '@clerum/llm-providers'
import type { DbClient } from '../db.js'
import {
  linkedCodexExactUsage,
  loadLlmProviderAttemptBySdkAttemptId,
} from './llmProviderAttemptStore.js'

// ─── Plugin Workload SDK — immutable spend floor ─────────────────────────
// `plugin_workload_sdk_spend_outcomes` rows are an append-only FLOOR: the
// least spend provable at write time. They are never updated (the runtime role
// holds SELECT/INSERT only). The effective truth of an oauth-broker attempt is
// derived at read time from the linked `llm_provider_attempts` usage — see
// `deriveEffectiveSpend` in pluginWorkloadSdkFinalization.ts.
//
// This module owns the ONLY INSERT statement against the table so that both
// writers (finalize and the stale-lease sweeper) share one shape and
// `token_pair_check` is guaranteed by the `PersistableSpend` type rather than
// by tests.

export type SpendOutcomeRow = {
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

/**
 * A spend value that can be persisted. The union makes the database's
 * `token_pair_check` unrepresentable to violate: `exact` always carries both
 * token counts, `unknown`/`not_executed` never carry either.
 */
export type PersistableSpend =
  | { outcome: 'exact'; inputTokens: number; outputTokens: number }
  | { outcome: 'unknown' | 'not_executed'; inputTokens: null; outputTokens: null }

export function spendFloor(outcome: 'unknown' | 'not_executed'): PersistableSpend {
  return { outcome, inputTokens: null, outputTokens: null }
}

export function isOauthBrokerProvider(provider: string): boolean {
  return isLlmProviderId(provider) && PROVIDER_AUTH_MODE[provider] === 'oauth-broker'
}

export const SPEND_OUTCOME_COLUMNS = `provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
       attempt_generation, attempt_index, target_ref, host_ref, provider,
       model, credential_slot, outcome, input_tokens, output_tokens`

const SPEND_OUTCOME_SELECT = `SELECT ${SPEND_OUTCOME_COLUMNS}
  FROM plugin_workload_sdk_spend_outcomes
 WHERE provider_attempt_id = $1`

export async function loadSpendOutcomeRow(
  db: DbClient,
  providerAttemptId: string
): Promise<SpendOutcomeRow | null> {
  const result = await db.query(SPEND_OUTCOME_SELECT, [providerAttemptId])
  return (result.rows[0] as SpendOutcomeRow | undefined) ?? null
}

export type SpendOutcomeFloorInput = {
  providerAttemptId: string
  invocationId: string
  recipeNamespace: string
  recipeName: string
  attemptGeneration: number
  attemptIndex: number
  targetRef: string
  /** NULL when no runtime JWT proves the host (stale-lease recovery). */
  hostRef: string | null
  provider: string
  model: string
  credentialSlot: string
  reason: string
  /** Set only when this finalization actually ingested a `usage_events` row. */
  usageRequestId: string | null
}

/**
 * The single INSERT into the spend ledger. `ON CONFLICT DO NOTHING` on the
 * physical-attempt primary key makes every writer idempotent against the
 * others; a null return means another writer already froze this attempt's
 * floor and the caller must re-read it.
 */
export async function insertSpendOutcomeFloor(
  db: DbClient,
  row: SpendOutcomeFloorInput,
  spend: PersistableSpend
): Promise<SpendOutcomeRow | null> {
  const inserted = await db.query(
    `INSERT INTO plugin_workload_sdk_spend_outcomes
       (provider_attempt_id, invocation_id, recipe_namespace, recipe_name,
        attempt_generation, attempt_index, target_ref, host_ref, provider, model,
        credential_slot, outcome, reason, input_tokens, output_tokens, usage_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (provider_attempt_id) DO NOTHING
     RETURNING ${SPEND_OUTCOME_COLUMNS}`,
    [
      row.providerAttemptId,
      row.invocationId,
      row.recipeNamespace,
      row.recipeName,
      row.attemptGeneration,
      row.attemptIndex,
      row.targetRef,
      row.hostRef,
      row.provider,
      row.model,
      row.credentialSlot,
      spend.outcome,
      row.reason,
      spend.inputTokens,
      spend.outputTokens,
      row.usageRequestId,
    ]
  )
  if ((inserted.rowCount ?? inserted.rows.length) === 0) return null
  return inserted.rows[0] as SpendOutcomeRow
}

const TERMINAL_PRIOR_ATTEMPT_STATUSES = new Set(['skipped', 'failed', 'provider_unavailable'])

/**
 * Best floor provable for a physical attempt that was already closed before
 * the one being finalized. A ready Codex row wins regardless of the physical
 * status (the subscription was billed), otherwise the status decides.
 */
async function resolvePriorAttemptSpend(
  db: DbClient,
  attemptId: string,
  provider: string,
  status: string
): Promise<PersistableSpend> {
  if (!TERMINAL_PRIOR_ATTEMPT_STATUSES.has(status)) {
    // reservePluginWorkloadSdkProviderAttempt refuses to hand out index k+1
    // unless attempt k is already terminal, and no writer moves a terminal
    // attempt back. Reaching this means that fence broke: fail loudly rather
    // than freeze a floor over a still-running provider call.
    throw new Error(
      `prior provider attempt ${attemptId} is not terminal (status=${status}); the reservation fence is broken`
    )
  }
  if (isOauthBrokerProvider(provider)) {
    const exact = linkedCodexExactUsage(await loadLlmProviderAttemptBySdkAttemptId(db, attemptId))
    if (exact) return { outcome: 'exact', ...exact }
  }
  return spendFloor(status === 'provider_unavailable' ? 'unknown' : 'not_executed')
}

/**
 * RP-539-003: on a successful failover only the winning attempt reaches
 * `finalize`, so every attempt it displaced would stay terminal without a
 * spend row — the legacy status endpoint does not touch the ledger and the
 * sweeper only visits `in_progress` invocations. Discover those attempts from
 * the database instead of trusting the host to declare them, and freeze one
 * floor each. Invocation and receipt rows are deliberately untouched: the
 * winning attempt already owns their transition.
 */
export async function settlePriorProviderAttemptFloors(
  db: DbClient,
  scope: {
    invocationId: string
    attemptGeneration: number
    attemptIndex: number
    hostRef: string
  }
): Promise<void> {
  const priors = await db.query(
    `SELECT id, recipe_namespace, recipe_name, attempt_index, target_ref,
            provider, model, credential_slot, status
       FROM plugin_workload_sdk_provider_attempts
      WHERE invocation_id = $1
        AND attempt_generation = $2
        AND attempt_index < $3
      ORDER BY attempt_index
      FOR UPDATE`,
    [scope.invocationId, scope.attemptGeneration, scope.attemptIndex]
  )
  for (const prior of priors.rows as Array<Record<string, unknown>>) {
    const attemptId = String(prior.id)
    const provider = String(prior.provider)
    const spend = await resolvePriorAttemptSpend(db, attemptId, provider, String(prior.status))
    await insertSpendOutcomeFloor(
      db,
      {
        providerAttemptId: attemptId,
        invocationId: scope.invocationId,
        recipeNamespace: String(prior.recipe_namespace),
        recipeName: String(prior.recipe_name),
        attemptGeneration: scope.attemptGeneration,
        attemptIndex: Number(prior.attempt_index),
        targetRef: String(prior.target_ref),
        hostRef: scope.hostRef,
        provider,
        model: String(prior.model),
        credentialSlot: String(prior.credential_slot),
        reason: `prior_attempt_${String(prior.status)}`,
        usageRequestId: null,
      },
      spend
    )
  }
}

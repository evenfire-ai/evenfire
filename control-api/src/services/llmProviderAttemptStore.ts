import type { DbClient } from '../db.js'

export const LLM_PROVIDER_ATTEMPT_PROVIDER = 'codex-subscription' as const

export type LlmProviderAttemptStatus = 'authorized' | 'redeemed' | 'finalized'
export type LlmProviderAttemptTicketStatus = 'issued' | 'redeemed' | 'finalized'
export type LlmProviderAttemptOutcome = 'success' | 'canceled' | 'error' | 'unknown'

export type LlmProviderAttemptInsert = {
  callerKind: 'host' | 'recipe'
  hostRef: string
  recipeNamespace?: string | null
  recipeName?: string | null
  invocationId: string
  attemptGeneration: number
  providerAttemptIndex: number
  model: string
  requestHash: string
  policyRevision: number
  policyHash: string
  budgetReservationId: string
  connectionRevision: number
  correlationId?: string | null
}

export type LlmProviderAttemptRow = LlmProviderAttemptInsert & {
  id: string
  provider: typeof LLM_PROVIDER_ATTEMPT_PROVIDER
  status: LlmProviderAttemptStatus
  outcome: LlmProviderAttemptOutcome | null
  createdAt: Date
}

export async function applyLlmProviderAttemptSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS llm_provider_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      caller_kind TEXT NOT NULL CHECK (caller_kind IN ('host', 'recipe')),
      host_ref TEXT NOT NULL,
      recipe_namespace TEXT,
      recipe_name TEXT,
      invocation_id TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      provider_attempt_index INTEGER NOT NULL CHECK (provider_attempt_index >= 1),
      provider TEXT NOT NULL CHECK (provider = 'codex-subscription'),
      model TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      policy_revision BIGINT NOT NULL,
      policy_hash TEXT NOT NULL,
      budget_reservation_id TEXT NOT NULL,
      connection_revision BIGINT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('authorized', 'redeemed', 'finalized')),
      outcome TEXT CHECK (outcome IN ('success', 'canceled', 'error', 'unknown')),
      usage_input_tokens INTEGER,
      usage_output_tokens INTEGER,
      correlation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finalized_at TIMESTAMPTZ,
      CONSTRAINT llm_provider_attempts_invocation_unique
        UNIQUE (invocation_id, attempt_generation, provider_attempt_index),
      CONSTRAINT llm_provider_attempts_recipe_binding CHECK (
        (caller_kind = 'host' AND recipe_namespace IS NULL AND recipe_name IS NULL)
        OR (
          caller_kind = 'recipe'
          AND recipe_namespace IS NOT NULL
          AND recipe_name IS NOT NULL
        )
      )
    );

    REVOKE ALL PRIVILEGES ON TABLE llm_provider_attempts FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE llm_provider_attempts
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE llm_provider_attempts TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE llm_provider_attempts FROM control_api_runtime;
  `)
}

export async function applyLlmProviderAttemptTicketSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS llm_provider_attempt_tickets (
      jti UUID PRIMARY KEY,
      provider_attempt_id UUID NOT NULL REFERENCES llm_provider_attempts(id),
      status TEXT NOT NULL CHECK (status IN ('issued', 'redeemed', 'finalized')),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ,
      finalized_at TIMESTAMPTZ,
      receipt_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    REVOKE ALL PRIVILEGES ON TABLE llm_provider_attempt_tickets FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE llm_provider_attempt_tickets
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE llm_provider_attempt_tickets TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE llm_provider_attempt_tickets FROM control_api_runtime;
  `)
}

export async function insertLlmProviderAttempt(
  db: DbClient,
  input: LlmProviderAttemptInsert
): Promise<LlmProviderAttemptRow> {
  const result = await db.query(
    `INSERT INTO llm_provider_attempts (
       caller_kind, host_ref, recipe_namespace, recipe_name, invocation_id,
       attempt_generation, provider_attempt_index, provider, model, request_hash,
       policy_revision, policy_hash, budget_reservation_id, connection_revision,
       status, correlation_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'codex-subscription', $8, $9, $10, $11, $12, $13,
       'authorized', $14
     )
     RETURNING id, caller_kind, host_ref, recipe_namespace, recipe_name, invocation_id,
               attempt_generation, provider_attempt_index, provider, model, request_hash,
               policy_revision, policy_hash, budget_reservation_id, connection_revision,
               status, outcome, created_at`,
    [
      input.callerKind,
      input.hostRef,
      input.recipeNamespace ?? null,
      input.recipeName ?? null,
      input.invocationId,
      input.attemptGeneration,
      input.providerAttemptIndex,
      input.model,
      input.requestHash,
      input.policyRevision,
      input.policyHash,
      input.budgetReservationId,
      input.connectionRevision,
      input.correlationId ?? null,
    ]
  )
  const row = result.rows[0] as Record<string, unknown>
  return {
    id: String(row.id),
    callerKind: row.caller_kind as 'host' | 'recipe',
    hostRef: String(row.host_ref),
    recipeNamespace: (row.recipe_namespace as string | null) ?? null,
    recipeName: (row.recipe_name as string | null) ?? null,
    invocationId: String(row.invocation_id),
    attemptGeneration: Number(row.attempt_generation),
    providerAttemptIndex: Number(row.provider_attempt_index),
    provider: LLM_PROVIDER_ATTEMPT_PROVIDER,
    model: String(row.model),
    requestHash: String(row.request_hash),
    policyRevision: Number(row.policy_revision),
    policyHash: String(row.policy_hash),
    budgetReservationId: String(row.budget_reservation_id),
    connectionRevision: Number(row.connection_revision),
    status: row.status as LlmProviderAttemptStatus,
    outcome: (row.outcome as LlmProviderAttemptOutcome | null) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  }
}

export async function registerLlmProviderAttemptTicket(
  db: DbClient,
  input: { jti: string; providerAttemptId: string; expiresAt: Date }
): Promise<void> {
  await db.query(
    `INSERT INTO llm_provider_attempt_tickets (
       jti, provider_attempt_id, status, expires_at
     ) VALUES ($1, $2, 'issued', $3)`,
    [input.jti, input.providerAttemptId, input.expiresAt]
  )
}

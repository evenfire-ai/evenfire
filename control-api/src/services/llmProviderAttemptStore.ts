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
  connectionId?: string | null
  correlationId?: string | null
  pluginWorkloadSdkProviderAttemptId?: string | null
}

export type LlmProviderAttemptRow = LlmProviderAttemptInsert & {
  id: string
  provider: typeof LLM_PROVIDER_ATTEMPT_PROVIDER
  status: LlmProviderAttemptStatus
  outcome: LlmProviderAttemptOutcome | null
  usageInputTokens?: number | null
  usageOutputTokens?: number | null
  createdAt: Date
}

export function isLinkedCodexUsageReady(
  row: Pick<LlmProviderAttemptRow, 'outcome' | 'usageInputTokens' | 'usageOutputTokens'>
): boolean {
  return row.outcome === 'success' && row.usageInputTokens != null && row.usageOutputTokens != null
}

/**
 * Exact token pair of a usage-ready Codex row, or null. Shared by both SDK
 * spend-floor writers (finalize and the stale-lease sweeper) so a ready Codex
 * row always freezes the same `exact` floor. Never fabricates 0/0: the null
 * re-check narrows the type without a cast and keeps a partially reported
 * usage frame out of the ledger.
 */
export function linkedCodexExactUsage(
  row: Pick<LlmProviderAttemptRow, 'outcome' | 'usageInputTokens' | 'usageOutputTokens'> | null
): { inputTokens: number; outputTokens: number } | null {
  if (!row || !isLinkedCodexUsageReady(row)) return null
  if (row.usageInputTokens == null || row.usageOutputTokens == null) return null
  return { inputTokens: row.usageInputTokens, outputTokens: row.usageOutputTokens }
}

/**
 * How long an authorized/redeemed Codex row may block SDK spend freeze.
 * After this, usage is treated as never arriving so the sweeper can close
 * the invocation. `finalized` is always terminal: ingest will not add tokens.
 */
export const CODEX_IN_FLIGHT_USAGE_GRACE_MS = 15 * 60 * 1000

/** Linked Codex still owns exact usage; sweepers must not freeze SDK spend. */
export function isLinkedCodexInFlightWithoutUsage(
  row: Pick<
    LlmProviderAttemptRow,
    'status' | 'outcome' | 'usageInputTokens' | 'usageOutputTokens'
  > & {
    createdAt?: Date | string | null
  },
  nowMs = Date.now()
): boolean {
  if (isLinkedCodexUsageReady(row)) return false
  // Finalized rows never receive a later usage frame. Treating usage-less
  // success as in-flight wedges complete behind ledger_pending forever.
  if (row.status === 'finalized') return false
  if (row.status !== 'authorized' && row.status !== 'redeemed') return false
  const created =
    row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : row.createdAt
        ? Date.parse(String(row.createdAt))
        : Number.NaN
  if (!Number.isFinite(created)) {
    // An unreadable created_at used to default to "still in flight",
    // which wedges the invocation behind ledger_pending forever and silently
    // hides a corrupt/absent timestamp. The grace window is undecidable here,
    // so fail loudly instead of guessing.
    throw new Error(
      'llm_provider_attempts.created_at is missing or unparseable; the Codex in-flight grace cannot be evaluated'
    )
  }
  if (nowMs - created > CODEX_IN_FLIGHT_USAGE_GRACE_MS) {
    return false
  }
  return true
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

export async function applyLlmProviderAttemptConnectionIdSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE llm_provider_attempts
      ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES codex_subscription_connections(id);

    UPDATE llm_provider_attempts a
       SET connection_id = c.id
      FROM codex_subscription_connections c
     WHERE a.connection_id IS NULL
       AND c.connection_key = 'deployment-default';
  `)
}

export async function applyLlmProviderAttemptSdkLinkSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE llm_provider_attempts
      ADD COLUMN IF NOT EXISTS plugin_workload_sdk_provider_attempt_id UUID
        REFERENCES plugin_workload_sdk_provider_attempts(id);

    CREATE UNIQUE INDEX IF NOT EXISTS llm_provider_attempts_sdk_attempt_uidx
      ON llm_provider_attempts (plugin_workload_sdk_provider_attempt_id)
      WHERE plugin_workload_sdk_provider_attempt_id IS NOT NULL;
  `)
}

export async function applyLlmProviderAttemptSdkLinkOnDeleteSetNullSchema(
  db: DbClient
): Promise<void> {
  await db.query(`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      SELECT c.conname INTO constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = 'llm_provider_attempts'
         AND c.contype = 'f'
         AND a.attname = 'plugin_workload_sdk_provider_attempt_id'
       LIMIT 1;
      IF constraint_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE llm_provider_attempts DROP CONSTRAINT %I',
          constraint_name
        );
      END IF;
    END $$;

    ALTER TABLE llm_provider_attempts
      ADD CONSTRAINT llm_provider_attempts_plugin_workload_sdk_provider_attempt_id_fkey
      FOREIGN KEY (plugin_workload_sdk_provider_attempt_id)
      REFERENCES plugin_workload_sdk_provider_attempts(id)
      ON DELETE SET NULL;
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
       connection_id, plugin_workload_sdk_provider_attempt_id, status, correlation_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'codex-subscription', $8, $9, $10, $11, $12, $13,
       $14, $15, 'authorized', $16
     )
     RETURNING id, caller_kind, host_ref, recipe_namespace, recipe_name, invocation_id,
               attempt_generation, provider_attempt_index, provider, model, request_hash,
               policy_revision, policy_hash, budget_reservation_id, connection_revision,
               connection_id, plugin_workload_sdk_provider_attempt_id, status, outcome,
               usage_input_tokens, usage_output_tokens, created_at`,
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
      input.connectionId ?? null,
      input.pluginWorkloadSdkProviderAttemptId ?? null,
      input.correlationId ?? null,
    ]
  )
  const row = result.rows[0] as Record<string, unknown>
  return mapLlmProviderAttemptRow(row)
}

function mapLlmProviderAttemptRow(row: Record<string, unknown>): LlmProviderAttemptRow {
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
    connectionId: row.connection_id ? String(row.connection_id) : null,
    pluginWorkloadSdkProviderAttemptId: row.plugin_workload_sdk_provider_attempt_id
      ? String(row.plugin_workload_sdk_provider_attempt_id)
      : null,
    status: row.status as LlmProviderAttemptStatus,
    outcome: (row.outcome as LlmProviderAttemptOutcome | null) ?? null,
    usageInputTokens: row.usage_input_tokens == null ? null : Number(row.usage_input_tokens),
    usageOutputTokens: row.usage_output_tokens == null ? null : Number(row.usage_output_tokens),
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

export type LlmProviderAttemptTicketRow = {
  jti: string
  providerAttemptId: string
  status: LlmProviderAttemptTicketStatus
  expiresAt: Date
  receiptHash: string | null
}

export async function loadLlmProviderAttempt(
  db: DbClient,
  id: string
): Promise<LlmProviderAttemptRow | null> {
  const result = await db.query(
    `SELECT id, caller_kind, host_ref, recipe_namespace, recipe_name, invocation_id,
            attempt_generation, provider_attempt_index, provider, model, request_hash,
            policy_revision, policy_hash, budget_reservation_id, connection_revision,
            connection_id, plugin_workload_sdk_provider_attempt_id, status, outcome,
            usage_input_tokens, usage_output_tokens, created_at
       FROM llm_provider_attempts
      WHERE id = $1`,
    [id]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapLlmProviderAttemptRow(row) : null
}

export async function loadLlmProviderAttemptBySdkAttemptId(
  db: DbClient,
  pluginWorkloadSdkProviderAttemptId: string
): Promise<LlmProviderAttemptRow | null> {
  const result = await db.query(
    `SELECT id, caller_kind, host_ref, recipe_namespace, recipe_name, invocation_id,
            attempt_generation, provider_attempt_index, provider, model, request_hash,
            policy_revision, policy_hash, budget_reservation_id, connection_revision,
            connection_id, plugin_workload_sdk_provider_attempt_id, status, outcome,
            usage_input_tokens, usage_output_tokens, created_at
       FROM llm_provider_attempts
      WHERE plugin_workload_sdk_provider_attempt_id = $1`,
    [pluginWorkloadSdkProviderAttemptId]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? mapLlmProviderAttemptRow(row) : null
}

export async function lockLlmProviderAttemptTicket(
  db: DbClient,
  jti: string
): Promise<LlmProviderAttemptTicketRow | null> {
  const result = await db.query(
    `SELECT jti::text, provider_attempt_id::text, status, expires_at, receipt_hash
       FROM llm_provider_attempt_tickets
      WHERE jti = $1
      FOR UPDATE`,
    [jti]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    jti: String(row.jti),
    providerAttemptId: String(row.provider_attempt_id),
    status: row.status as LlmProviderAttemptTicketStatus,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at)),
    receiptHash: (row.receipt_hash as string | null) ?? null,
  }
}

export async function markLlmProviderAttemptTicketRedeemed(
  db: DbClient,
  jti: string
): Promise<boolean> {
  const ticket = await db.query(
    `UPDATE llm_provider_attempt_tickets
        SET status = 'redeemed', redeemed_at = now()
      WHERE jti = $1
        AND status = 'issued'
        AND expires_at > now()`,
    [jti]
  )
  if ((ticket.rowCount ?? 0) !== 1) return false
  await db.query(
    `UPDATE llm_provider_attempts
        SET status = 'redeemed'
      WHERE id = (
        SELECT provider_attempt_id FROM llm_provider_attempt_tickets WHERE jti = $1
      )
        AND status = 'authorized'`,
    [jti]
  )
  return true
}

export async function markLlmProviderAttemptFinalized(
  db: DbClient,
  input: {
    providerAttemptId: string
    receiptHash: string
    outcome: LlmProviderAttemptOutcome
    usageInputTokens?: number
    usageOutputTokens?: number
  }
): Promise<'applied' | 'duplicate' | 'conflict' | 'missing'> {
  const current = await db.query(
    `SELECT status, receipt_hash
       FROM llm_provider_attempt_tickets
      WHERE provider_attempt_id = $1
      FOR UPDATE`,
    [input.providerAttemptId]
  )
  const ticket = current.rows[0] as { status: string; receipt_hash: string | null } | undefined
  if (!ticket) return 'missing'
  if (ticket.status === 'finalized') {
    return ticket.receipt_hash === input.receiptHash ? 'duplicate' : 'conflict'
  }
  if (ticket.status !== 'redeemed') return 'conflict'

  const ticketUpdate = await db.query(
    `UPDATE llm_provider_attempt_tickets
        SET status = 'finalized', finalized_at = now(), receipt_hash = $2
      WHERE provider_attempt_id = $1
        AND status = 'redeemed'`,
    [input.providerAttemptId, input.receiptHash]
  )
  if ((ticketUpdate.rowCount ?? 0) !== 1) return 'conflict'

  const attemptUpdate = await db.query(
    `UPDATE llm_provider_attempts
        SET status = 'finalized',
            outcome = $2,
            usage_input_tokens = $3,
            usage_output_tokens = $4,
            finalized_at = now()
      WHERE id = $1
        AND status = 'redeemed'`,
    [
      input.providerAttemptId,
      input.outcome,
      input.usageInputTokens ?? null,
      input.usageOutputTokens ?? null,
    ]
  )
  if ((attemptUpdate.rowCount ?? 0) !== 1) return 'conflict'
  return 'applied'
}

export async function getMaxLlmProviderAttemptGeneration(
  db: DbClient,
  invocationId: string
): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(MAX(attempt_generation), 0) AS max_generation
       FROM llm_provider_attempts
      WHERE invocation_id = $1`,
    [invocationId]
  )
  return Number((result.rows[0] as { max_generation?: unknown } | undefined)?.max_generation ?? 0)
}

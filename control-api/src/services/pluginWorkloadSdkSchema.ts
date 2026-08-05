import type { DbClient } from '../db.js'

// ─── Plugin Workload SDK — schema (migration 0034_plugin_workload_sdk) ──
// Lives apart from pluginWorkloadSdkDb.ts so db.ts can import it without a
// runtime import cycle (this module only has a type-only dependency on db).

export async function applyPluginWorkloadSdkSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      capability_family TEXT NOT NULL CHECK (capability_family IN ('promptBridge','clientNotifications')),
      -- Explicit provider bound to a promptBridge grant (R1: credentials resolve
      -- per-provider, not per-model). NULLABLE: rows written before migration
      -- 0050 carry NULL and remain legacy/unreviewed until an operator
      -- explicitly resaves an ordered target policy. clientNotifications
      -- grants leave it NULL.
      provider TEXT,
      allowed_models JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_target_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_user_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_callers JSONB NOT NULL DEFAULT '[]'::jsonb,
      quota_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- Ordered operator-authorized promptBridge routing policy. This stays
      -- separate from legacy provider/allowed_models so old rows can be
      -- inventoried without accidentally becoming a routable policy.
      prompt_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      default_target_ref TEXT NULL,
      policy_revision INTEGER NOT NULL DEFAULT 1,
      policy_state TEXT NOT NULL DEFAULT 'active'
        CHECK (policy_state IN ('active', 'legacy_unreviewed', 'revoking', 'disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (recipe_namespace, recipe_name, capability_family)
    );

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_invocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      caller_ref TEXT NOT NULL,
      correlation_id TEXT NULL,
      method TEXT NOT NULL CHECK (method IN ('promptBridge','clientNotifications')),
      detail TEXT NOT NULL,
      purpose TEXT NULL,
      idempotency_key_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('in_progress','complete','failed','provider_unavailable','accepted','delivered')),
      quota_consumed BOOLEAN NOT NULL DEFAULT true,
      authorization_decision TEXT NOT NULL,
      contract_version INTEGER NOT NULL DEFAULT 2 CHECK (contract_version IN (1, 2)),
      -- Persisted, non-secret prompt authorization snapshot used to mint a
      -- fresh fallback ticket without trusting caller-supplied target lists.
      prompt_authorization JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Tracks the most recent lifecycle transition, including a failed
      -- idempotent retry revived by CAS. Stale recovery must not use the
      -- original reservation time for an active retry.
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempt_generation INTEGER NOT NULL DEFAULT 1 CHECK (attempt_generation >= 1),
      lease_expires_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_credential_ticket_jtis (
      jti UUID PRIMARY KEY,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      invocation_id UUID NOT NULL,
      target_ref TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL DEFAULT 1 CHECK (attempt_generation >= 1),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ NULL
    );
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_credential_ticket_jtis_expiry
      ON plugin_workload_sdk_credential_ticket_jtis (expires_at);

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_invocation_attempts (
      invocation_id UUID NOT NULL,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      method TEXT NOT NULL CHECK (method IN ('promptBridge','clientNotifications')),
      target_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      policy_revision INTEGER NULL,
      policy_hash TEXT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','complete','failed','provider_unavailable','accepted','delivered')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_expires_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      PRIMARY KEY (invocation_id, attempt_generation)
    );
    ALTER TABLE plugin_workload_sdk_invocation_attempts
      ADD COLUMN IF NOT EXISTS recipe_namespace TEXT,
      ADD COLUMN IF NOT EXISTS recipe_name TEXT;
    UPDATE plugin_workload_sdk_invocation_attempts attempts
       SET recipe_namespace = invocations.recipe_namespace,
           recipe_name = invocations.recipe_name
      FROM plugin_workload_sdk_invocations invocations
     WHERE attempts.invocation_id = invocations.id
       AND (attempts.recipe_namespace IS NULL OR attempts.recipe_name IS NULL);
    ALTER TABLE plugin_workload_sdk_invocation_attempts
      ALTER COLUMN recipe_namespace SET NOT NULL,
      ALTER COLUMN recipe_name SET NOT NULL;
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_invocation_attempts_status_idx
      ON plugin_workload_sdk_invocation_attempts (status, lease_expires_at);

    -- Idempotency uniqueness scoped per recipe + method (OQ-5). Rows older
    -- than the 24h TTL are pruned by prunePluginWorkloadSdkExpiredIdempotency
    -- so keys become reusable in a new invocation period.
    CREATE UNIQUE INDEX IF NOT EXISTS plugin_workload_sdk_invocations_idem
      ON plugin_workload_sdk_invocations (recipe_namespace, recipe_name, method, idempotency_key_hash);

    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_invocations_recipe_created
      ON plugin_workload_sdk_invocations (recipe_namespace, recipe_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_quota_counters (
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      prompt_bridge_count INTEGER NOT NULL DEFAULT 0,
      notification_count INTEGER NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (recipe_namespace, recipe_name, period_start)
    );
  `)
}

/** Drops the retired super-admin approval column from existing clusters. */
export async function dropPluginWorkloadSdkSuperAdminApprovedColumn(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      DROP COLUMN IF EXISTS super_admin_approved;
  `)
}

/**
 * Adds the explicit `provider` column to promptBridge grants (R1). Idempotent
 * (IF NOT EXISTS) so it is a no-op on fresh clusters that already created the
 * column via applyPluginWorkloadSdkSchema. Existing rows keep NULL and remain
 * legacy/unreviewed; no provider is inferred from their model list.
 */
export async function addPluginWorkloadSdkProviderColumn(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      ADD COLUMN IF NOT EXISTS provider TEXT;
  `)
}

/**
 * Adds the explicit ordered promptBridge target policy. JSONB arrays retain
 * operator-authored order; the writer updates every policy field together in
 * one transaction and increments the revision on every replacement.
 */
export async function addPluginWorkloadSdkPromptTargetPolicyColumns(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      ADD COLUMN IF NOT EXISTS prompt_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS default_target_ref TEXT NULL,
      ADD COLUMN IF NOT EXISTS policy_revision INTEGER NOT NULL DEFAULT 1;
  `)
}

/**
 * Persists the original target suffix for JIT fallback ticket issuance and
 * makes every ticket jti redeemable exactly once at credential introspection.
 */
export async function addPluginWorkloadSdkJitCredentialTicketColumns(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_invocations
      ADD COLUMN IF NOT EXISTS prompt_authorization JSONB NULL;

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_credential_ticket_jtis (
      jti UUID PRIMARY KEY,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      invocation_id UUID NOT NULL,
      target_ref TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ NULL
    );
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_credential_ticket_jtis_expiry
      ON plugin_workload_sdk_credential_ticket_jtis (expires_at);
  `)
}

/**
 * Monotonic follow-up for the attempt/lease contract. Existing migrations are
 * never edited because long-lived databases intentionally skip versions that
 * are already recorded. Existing promptBridge rows are marked legacy without
 * inferring provider, model, credential slot, default, or ordering.
 */
export async function addPluginWorkloadSdkAttemptLedgerColumns(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      ADD COLUMN IF NOT EXISTS policy_state TEXT NOT NULL DEFAULT 'active';
    DO $$ BEGIN
      ALTER TABLE plugin_workload_sdk_grants
        ADD CONSTRAINT plugin_workload_sdk_grants_policy_state_check
        CHECK (policy_state IN ('active', 'legacy_unreviewed'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_invocation_attempts (
      invocation_id UUID NOT NULL,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      method TEXT NOT NULL CHECK (method IN ('promptBridge','clientNotifications')),
      target_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      policy_revision INTEGER NULL,
      policy_hash TEXT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','complete','failed','provider_unavailable','accepted','delivered')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_expires_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      PRIMARY KEY (invocation_id, attempt_generation)
    );
    ALTER TABLE plugin_workload_sdk_invocation_attempts
      ADD COLUMN IF NOT EXISTS recipe_namespace TEXT,
      ADD COLUMN IF NOT EXISTS recipe_name TEXT;
    UPDATE plugin_workload_sdk_invocation_attempts attempts
       SET recipe_namespace = invocations.recipe_namespace,
           recipe_name = invocations.recipe_name
      FROM plugin_workload_sdk_invocations invocations
     WHERE attempts.invocation_id = invocations.id
       AND (attempts.recipe_namespace IS NULL OR attempts.recipe_name IS NULL);
    ALTER TABLE plugin_workload_sdk_invocation_attempts
      ALTER COLUMN recipe_namespace SET NOT NULL,
      ALTER COLUMN recipe_name SET NOT NULL;
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_invocation_attempts_status_idx
      ON plugin_workload_sdk_invocation_attempts (status, lease_expires_at);

    ALTER TABLE plugin_workload_sdk_invocations
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS attempt_generation INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL;
    UPDATE plugin_workload_sdk_invocations
       SET updated_at = COALESCE(updated_at, created_at),
           attempt_generation = GREATEST(COALESCE(attempt_generation, 1), 1)
     WHERE updated_at IS NULL OR attempt_generation IS NULL OR attempt_generation < 1;
    DO $$ BEGIN
      ALTER TABLE plugin_workload_sdk_invocations
        ADD CONSTRAINT plugin_workload_sdk_invocations_attempt_generation_check
        CHECK (attempt_generation >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    ALTER TABLE plugin_workload_sdk_credential_ticket_jtis
      ADD COLUMN IF NOT EXISTS attempt_generation INTEGER NOT NULL DEFAULT 1;
    DO $$ BEGIN
      ALTER TABLE plugin_workload_sdk_credential_ticket_jtis
        ADD CONSTRAINT plugin_workload_sdk_credential_ticket_jtis_attempt_generation_check
        CHECK (attempt_generation >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- Rows that predate the attempt ledger still need an immutable receipt.
    -- Backfill from the parent snapshot without inferring a new policy: legacy
    -- promptBridge grants are blocked below until an operator explicitly
    -- reviews them. A malformed/absent policyRevision remains NULL rather
    -- than making the migration fail for an otherwise valid audit row.
    INSERT INTO plugin_workload_sdk_invocation_attempts
      (invocation_id, recipe_namespace, recipe_name, attempt_generation, method,
       target_refs, policy_revision, policy_hash, status, started_at,
       lease_expires_at, completed_at)
    SELECT inv.id,
           inv.recipe_namespace,
           inv.recipe_name,
           GREATEST(COALESCE(inv.attempt_generation, 1), 1),
           inv.method,
           COALESCE(inv.prompt_authorization->'authorizedTargetRefs', '[]'::jsonb),
           CASE
             WHEN jsonb_typeof(inv.prompt_authorization->'policyRevision') = 'number'
             THEN (inv.prompt_authorization->>'policyRevision')::integer
             ELSE NULL
           END,
           CASE
             WHEN jsonb_typeof(inv.prompt_authorization->'policyHash') = 'string'
             THEN inv.prompt_authorization->>'policyHash'
             ELSE NULL
           END,
           inv.status,
           inv.created_at,
           CASE WHEN inv.status = 'in_progress' THEN inv.lease_expires_at ELSE NULL END,
           inv.completed_at
      FROM plugin_workload_sdk_invocations inv
     WHERE NOT EXISTS (
       SELECT 1
         FROM plugin_workload_sdk_invocation_attempts existing
        WHERE existing.invocation_id = inv.id
          AND existing.attempt_generation = GREATEST(COALESCE(inv.attempt_generation, 1), 1)
     )
    ON CONFLICT (invocation_id, attempt_generation) DO NOTHING;

    -- Every promptBridge row that predates this migration is unreviewed. Do
    -- not infer a routable policy from legacy provider/model/slot columns;
    -- only an explicit operator upsert/resave may move it to active.
    UPDATE plugin_workload_sdk_grants
       SET policy_state = 'legacy_unreviewed',
           policy_revision = 0
     WHERE capability_family = 'promptBridge';

    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_invocations_lease_idx
      ON plugin_workload_sdk_invocations (status, lease_expires_at)
      WHERE status = 'in_progress';
  `)
}

/** Adds the explicit usage source used by SDK-only promptBridge receipts. */
export async function addPluginWorkloadSdkUsageSourceKind(db: DbClient): Promise<void> {
  await db.query(`ALTER TYPE usage_source_kind ADD VALUE IF NOT EXISTS 'plugin_workload_sdk';`)
}

/**
 * Establishes the dual wire-contract and revocation state without rewriting
 * any previously applied migration. Existing invocation rows are explicitly
 * classified as legacy v1 and abandoned in-progress rows are terminalized so
 * the new lease/sweep contract cannot inherit an unbounded old reservation.
 */
export async function addPluginWorkloadSdkProtocolAndRevocation(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      DROP CONSTRAINT IF EXISTS plugin_workload_sdk_grants_policy_state_check;
    ALTER TABLE plugin_workload_sdk_grants
      ADD CONSTRAINT plugin_workload_sdk_grants_policy_state_check
      CHECK (policy_state IN ('active', 'legacy_unreviewed', 'revoking', 'disabled'));

    ALTER TABLE plugin_workload_sdk_invocations
      ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 2;
    -- Keep the default at v1 during the rolling-update compatibility window.
    -- New writers send contract_version=2 explicitly; an older pod that omits
    -- the column is therefore identifiable and can be swept conservatively.
    ALTER TABLE plugin_workload_sdk_invocations
      ALTER COLUMN contract_version SET DEFAULT 1;
    DO $$ BEGIN
      ALTER TABLE plugin_workload_sdk_invocations
        ADD CONSTRAINT plugin_workload_sdk_invocations_contract_version_check
        CHECK (contract_version IN (1, 2));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- Rows written before this migration used the pre-v2 endpoint. Preserve
    -- that fact for status compatibility and operational inventory rather than
    -- pretending they negotiated the target-aware/JIT contract.
    UPDATE plugin_workload_sdk_invocations
       SET contract_version = 1
     WHERE contract_version = 2;

    -- Old rows had no lease. They cannot be safely resumed after a rollout;
    -- close them deterministically and fence any matching attempt receipt.
    UPDATE plugin_workload_sdk_invocations
       SET status = 'failed',
           authorization_decision = CASE
             WHEN authorization_decision = 'authorized' THEN 'migration_interrupted'
             ELSE authorization_decision
           END,
           updated_at = now(),
           completed_at = COALESCE(completed_at, now()),
           lease_expires_at = NULL
     WHERE contract_version = 1
       AND status = 'in_progress'
       AND lease_expires_at IS NULL;
    UPDATE plugin_workload_sdk_invocation_attempts attempts
       SET status = 'failed',
           completed_at = COALESCE(attempts.completed_at, now()),
           lease_expires_at = NULL
      FROM plugin_workload_sdk_invocations invocations
     WHERE attempts.invocation_id = invocations.id
       AND attempts.attempt_generation = invocations.attempt_generation
       AND invocations.contract_version = 1
       AND invocations.status = 'failed';

    DO $$ BEGIN
      ALTER TABLE plugin_workload_sdk_invocations
        ADD CONSTRAINT plugin_workload_sdk_invocations_v2_lease_check
        CHECK (
          contract_version = 1
          OR status <> 'in_progress'
          OR lease_expires_at IS NOT NULL
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_invocations_contract_idx
      ON plugin_workload_sdk_invocations (recipe_namespace, recipe_name, contract_version, created_at DESC);
  `)
}

/** Adds one immutable ledger row for every physical provider attempt. */
export async function addPluginWorkloadSdkProviderAttemptLedger(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_provider_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invocation_id UUID NOT NULL,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      attempt_index INTEGER NOT NULL CHECK (attempt_index BETWEEN 1 AND 4),
      target_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      credential_slot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved','in_progress','complete','failed','provider_unavailable','skipped')),
      credential_jti UUID NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_expires_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      usage_request_id UUID NULL,
      UNIQUE (invocation_id, attempt_generation, attempt_index)
    );
    ALTER TABLE plugin_workload_sdk_credential_ticket_jtis
      ADD COLUMN IF NOT EXISTS provider_attempt_id UUID NULL;
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_provider_attempts_invocation_idx
      ON plugin_workload_sdk_provider_attempts (invocation_id, attempt_generation, attempt_index);
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_provider_attempts_status_idx
      ON plugin_workload_sdk_provider_attempts (status, lease_expires_at);
    -- Existing clusters created the ledger before circuit-breaker skips became
    -- auditable. Replace the inline constraint idempotently so those clusters
    -- accept the same terminal status as fresh installs.
    ALTER TABLE plugin_workload_sdk_provider_attempts
      DROP CONSTRAINT IF EXISTS plugin_workload_sdk_provider_attempts_status_check;
    ALTER TABLE plugin_workload_sdk_provider_attempts
      ADD CONSTRAINT plugin_workload_sdk_provider_attempts_status_check
      CHECK (status IN ('reserved','in_progress','complete','failed','provider_unavailable','skipped'));
  `)
}

/**
 * Adds the recipe-scoped revocation epoch used by the teardown kill-switch.
 * A receipt is deliberately separate from policy_revision: policy revisions
 * describe operator edits, while revocation_id is a one-shot CAS capability
 * that prevents a stale reconciler from disabling a newly-authorized policy.
 */
export async function addPluginWorkloadSdkRevocationEpoch(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_grants
      ADD COLUMN IF NOT EXISTS revocation_id UUID NULL;
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_grants_revocation_idx
      ON plugin_workload_sdk_grants (recipe_namespace, recipe_name, revocation_id)
      WHERE revocation_id IS NOT NULL;
  `)
}

/** Applies the runtime ACL for the attempt-ledger tables added after the
 * original runtime-role migration. The control API owns their lifecycle and
 * retention; no workflow or maintenance runtime should be able to mutate or
 * read these provider-attempt receipts. */
export async function addPluginWorkloadSdkRuntimeAccess(db: DbClient): Promise<void> {
  await db.query(`
    REVOKE ALL ON TABLE
      plugin_workload_sdk_invocation_attempts,
      plugin_workload_sdk_provider_attempts
      FROM PUBLIC, trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      plugin_workload_sdk_invocation_attempts,
      plugin_workload_sdk_provider_attempts
      TO control_api_runtime;
  `)
}

/**
 * Durable spend outcome for a physical promptBridge attempt.  The provider
 * attempt ledger prevents a second execution, while this table preserves the
 * accounting truth when the provider response is known only to have possibly
 * executed (for example, a timeout or a lost completion acknowledgement).
 * Rows are immutable and keyed by the physical attempt id so retries of the
 * finalization request are safe.
 */
export async function addPluginWorkloadSdkSpendOutcomeLedger(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_workload_sdk_spend_outcomes (
      provider_attempt_id UUID PRIMARY KEY,
      invocation_id UUID NOT NULL,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      attempt_index INTEGER NOT NULL CHECK (attempt_index BETWEEN 1 AND 4),
      target_ref TEXT NOT NULL,
      -- A normal finalization is bound to the runtime JWT host_ref.  A stale
      -- lease can be detected only after mcp-host has disappeared, however,
      -- so that recovery row is intentionally unattributed rather than
      -- fabricating a host identity from recipe names.
      host_ref TEXT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      credential_slot TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('exact', 'unknown')),
      reason TEXT NOT NULL,
      input_tokens INTEGER NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
      usage_request_id UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT plugin_workload_sdk_spend_outcomes_token_pair_check
        CHECK ((outcome = 'exact' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
            OR (outcome = 'unknown' AND input_tokens IS NULL AND output_tokens IS NULL))
    );
    CREATE INDEX IF NOT EXISTS plugin_workload_sdk_spend_outcomes_recipe_idx
      ON plugin_workload_sdk_spend_outcomes (recipe_namespace, recipe_name, created_at DESC);
    REVOKE ALL ON TABLE plugin_workload_sdk_spend_outcomes
      FROM PUBLIC, trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT ON TABLE plugin_workload_sdk_spend_outcomes TO control_api_runtime;
  `)
}

/**
 * The spend ledger was initially shipped with a required host_ref.  Stale
 * lease recovery has no bearer token from which to prove that binding, so
 * existing clusters must converge to the same nullable shape as fresh ones.
 */
export async function relaxPluginWorkloadSdkSpendOutcomeHostRef(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE plugin_workload_sdk_spend_outcomes
      ALTER COLUMN host_ref DROP NOT NULL;
  `)
}

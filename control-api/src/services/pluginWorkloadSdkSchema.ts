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
      -- 0050 carry NULL and are read back with a provider inferred from the
      -- model list (control-ui fallback). clientNotifications grants leave it NULL.
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
      -- Persisted, non-secret prompt authorization snapshot used to mint a
      -- fresh fallback ticket without trusting caller-supplied target lists.
      prompt_authorization JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ NULL
    );

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
 * column via applyPluginWorkloadSdkSchema. Existing rows keep NULL — the read
 * path (control-ui) falls back to inferring the provider from the model list.
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

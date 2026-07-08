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
      allowed_models JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_target_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_user_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_callers JSONB NOT NULL DEFAULT '[]'::jsonb,
      quota_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ NULL
    );

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

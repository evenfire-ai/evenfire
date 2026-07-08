import { Pool, type PoolClient } from 'pg'
import { config } from './config.js'
import {
  applyPluginWorkloadSdkSchema,
  dropPluginWorkloadSdkSuperAdminApprovedColumn,
} from './services/pluginWorkloadSdkSchema.js'

export type DbClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
}

type DbSessionClient = DbClient & {
  release: () => void
}

type DbConnector = {
  connect: () => Promise<DbSessionClient>
}

const INIT_DB_LOCK_KEY_SQL = "hashtext('control-api-init-db-v1')::bigint"

type DbMigration = {
  version: string
  apply: (db: DbClient) => Promise<void>
}

export const pool = new Pool({
  connectionString: config.pgConnectionString,
})

async function applyBaselineSchema(db: DbClient): Promise<void> {
  // Baseline includes additive Phase 0 workflow-trigger tables for fresh
  // clusters. Existing clusters receive the same tables through migration 0016;
  // that migration also remains responsible for backfill and preflight checks.
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT,
      channels JSONB NOT NULL DEFAULT '{"emails":[],"slackUserNames":[],"telegramIds":[]}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
      accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      invitee_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'accepted', 'revoked')),
      purpose TEXT NOT NULL DEFAULT 'member_invitation' CHECK (purpose IN ('member_invitation', 'password_reset', 'admin_desktop_access')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_invitations_email_status ON invitations(email, status);

    CREATE TABLE IF NOT EXISTS invitation_teams (
      invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (invitation_id, team_id)
    );

    CREATE INDEX IF NOT EXISTS idx_invitation_teams_team
      ON invitation_teams(team_id, invitation_id);

    CREATE TABLE IF NOT EXISTS user_contexts (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, context_id)
    );

    CREATE TABLE IF NOT EXISTS team_contexts (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, context_id)
    );

    CREATE TABLE IF NOT EXISTS user_agents (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, agent_name)
    );

    CREATE TABLE IF NOT EXISTS team_agents (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, agent_name)
    );

    CREATE TABLE IF NOT EXISTS control_admin_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_users_email_unique
      ON control_admin_users (lower(email))
      WHERE email IS NOT NULL AND email <> '';

    CREATE TABLE IF NOT EXISTS control_admin_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      invited_by_admin_id UUID REFERENCES control_admin_users(id) ON DELETE SET NULL,
      accepted_admin_id UUID REFERENCES control_admin_users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'opened', 'accepted', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_invitations_pending_email
      ON control_admin_invitations (lower(email))
      WHERE status IN ('pending', 'opened');

    CREATE TABLE IF NOT EXISTS control_admin_email_change_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES control_admin_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_email_change_requests_pending_admin
      ON control_admin_email_change_requests (admin_id)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_email_change_requests_pending_email
      ON control_admin_email_change_requests (lower(email))
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS control_admin_revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_control_admin_revoked_tokens_expires_at ON control_admin_revoked_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS control_admin_deletion_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_admin_id UUID,
      actor_username TEXT,
      actor_email TEXT,
      target_admin_id UUID NOT NULL,
      target_username TEXT NOT NULL,
      target_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_control_admin_deletion_audit_target
      ON control_admin_deletion_audit (target_admin_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_control_admin_deletion_audit_actor
      ON control_admin_deletion_audit (actor_admin_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS control_admin_password_reset_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES control_admin_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_password_resets_pending_admin
      ON control_admin_password_reset_requests (admin_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_control_admin_password_resets_lookup
      ON control_admin_password_reset_requests (email, id, created_at DESC);

    -- ─── Workflow Approval Requests ────────────────────────────────────

    CREATE TABLE IF NOT EXISTS workflow_approval_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled','consumed')),
      target_user_id UUID NULL,
      target_team_id UUID NULL,
      payload JSONB NOT NULL,
      decision_maker JSONB NULL,
      idempotency_key TEXT NOT NULL,
      correlation JSONB NULL,
      payload_hash TEXT NOT NULL DEFAULT '',
      CHECK ((target_user_id IS NULL) <> (target_team_id IS NULL))
    );
    -- Backfill column for clusters that already have the table without payload_hash
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';

    -- ─── Gap #2: promote JSONB audit fields to columns ──────────────────
    -- Dual-write window: writers populate both JSONB decision_maker and
    -- these columns. Readers fall back to JSONB for legacy rows.
    -- FKs to users(id)/teams(id) are NOT added - per audit scope, FK work
    -- was excluded to avoid scope creep; orphan handling stays as-is.
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS decided_by_user_id TEXT;
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS client_ip TEXT;
    ALTER TABLE workflow_approval_requests
      ADD COLUMN IF NOT EXISTS user_agent TEXT;

    -- Idempotent backfill from the existing JSONB audit blob.
    UPDATE workflow_approval_requests
       SET decided_at = (decision_maker->>'decidedAt')::timestamptz
     WHERE decided_at IS NULL
       AND decision_maker IS NOT NULL
       AND decision_maker ? 'decidedAt'
       AND (decision_maker->>'decidedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}';
    UPDATE workflow_approval_requests
       SET decided_by_user_id = decision_maker->>'userId'
     WHERE decided_by_user_id IS NULL
       AND decision_maker IS NOT NULL
       AND decision_maker ? 'userId';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_war_idempotency ON workflow_approval_requests (recipe_namespace, recipe_name, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_war_recipe_status ON workflow_approval_requests (recipe_namespace, recipe_name, status);
    CREATE INDEX IF NOT EXISTS idx_war_user_status ON workflow_approval_requests (target_user_id, status) WHERE target_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_war_team_status ON workflow_approval_requests (target_team_id, status) WHERE target_team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_war_expires ON workflow_approval_requests (expires_at) WHERE status = 'pending';
    -- Archival cron uses decided_at + status filter; partial index keeps it cheap.
    CREATE INDEX IF NOT EXISTS idx_war_decided_at ON workflow_approval_requests (decided_at);

    -- ─── Gap #2: archive table for terminal approvals ───────────────────
    CREATE TABLE IF NOT EXISTS workflow_approval_requests_archive (
      id UUID PRIMARY KEY,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      target_user_id UUID NULL,
      target_team_id UUID NULL,
      payload JSONB NOT NULL,
      decision_maker JSONB NULL,
      idempotency_key TEXT NOT NULL,
      correlation JSONB NULL,
      payload_hash TEXT NOT NULL DEFAULT '',
      decided_at TIMESTAMPTZ NULL,
      decided_by_user_id TEXT NULL,
      cancelled_at TIMESTAMPTZ NULL,
      cancelled_by TEXT NULL,
      client_ip TEXT NULL,
      user_agent TEXT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_war_archive_archived_at ON workflow_approval_requests_archive(archived_at);
    CREATE INDEX IF NOT EXISTS idx_war_archive_recipe ON workflow_approval_requests_archive(recipe_namespace, recipe_name);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      trigger_namespace TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      trigger_caller_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wati_trigger
      ON workflow_approval_trigger_intents(trigger_namespace, trigger_name, trigger_caller_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents_archive (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests_archive(id) ON DELETE CASCADE,
      trigger_namespace TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      trigger_caller_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watia_trigger
      ON workflow_approval_trigger_intents_archive(trigger_namespace, trigger_name, trigger_caller_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watri_idempotency
      ON workflow_approval_trigger_run_intents(idempotency_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents_archive (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests_archive(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watria_idempotency
      ON workflow_approval_trigger_run_intents_archive(idempotency_key);

    -- ─── Gap #4: PG-backed rate limiter buckets ─────────────────────────
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      bucket_key TEXT NOT NULL,
      window_start_ms BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_key, window_start_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_buckets(window_start_ms);

    -- ─── Workflow Recipe Allowlists ────────────────────────────────────

    CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_users (
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      user_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (recipe_namespace, recipe_name, user_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams (
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (recipe_namespace, recipe_name, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_team
      ON workflow_recipe_allowed_teams(team_id);

    -- ─── Revoked Refresh Token JTIs ─────────────────────────────────────

    CREATE TABLE IF NOT EXISTS workflow_revoked_refresh_jtis (
      jti TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rrj_expires ON workflow_revoked_refresh_jtis (expires_at);

    -- ─── Notification Deliveries (hook para notification-service) ──────

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      audience JSONB NOT NULL,
      payload JSONB NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','retrying','cancelled','skipped_no_bot')),
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nd_dedupe ON notification_deliveries (dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_nd_status_next ON notification_deliveries (status, next_attempt_at) WHERE status IN ('queued', 'retrying');
  `)

  await db.query(`
    ALTER TABLE notification_deliveries
      ADD COLUMN IF NOT EXISTS delivered_medium TEXT NULL;

    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferred_medium TEXT NULL CHECK (preferred_medium IS NULL OR preferred_medium IN ('telegram', 'slack')),
      channel_fallback_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await applyWorkflowApprovalMediumSchema(db)

  await db.query(`
    CREATE OR REPLACE FUNCTION notify_notification_queued() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('notification_queued', NEW.id::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS notification_deliveries_notify ON notification_deliveries;
    CREATE TRIGGER notification_deliveries_notify
      AFTER INSERT ON notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION notify_notification_queued();
  `)

  // ── STEP 1: Add global role column to users table ──
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
      CHECK (role IN ('admin', 'operator', 'reviewer', 'finance', 'user'));
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE role != 'user';
  `)

  // ── STEP 2: Trigger-grant table (user → recipe mapping) ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_workflow_triggers (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, recipe_namespace, recipe_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_workflow_triggers_user
      ON user_workflow_triggers(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_workflow_triggers_recipe
      ON user_workflow_triggers(recipe_namespace, recipe_name);

    CREATE TABLE IF NOT EXISTS team_workflow_triggers (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, recipe_namespace, recipe_name)
    );
    CREATE INDEX IF NOT EXISTS idx_team_workflow_triggers_team
      ON team_workflow_triggers(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_workflow_triggers_recipe
      ON team_workflow_triggers(recipe_namespace, recipe_name);
  `)

  // ── STEP 4: Audit log tables (trigger grants, role changes) ──
  //
  // NOTE (2026-04-23): `instantiation_audit_log` was previously defined here
  // but had zero writers and zero readers across the repo — it was never wired
  // into any product path. It was removed from the baseline to stop shipping
  // dead schema to fresh clusters. Clusters that had already bootstrapped
  // prior to this edit retain the orphan table; run
  // `scripts/drop-orphan-instantiation-audit-log.sh` once per such cluster to
  // clean it up. This intentionally deviates from the "do not edit shipped
  // migrations" rule because the end state (table absent on every cluster)
  // converges regardless of migration history.
  //
  // `trigger_grants_audit.action` enum deliberately keeps `'replace_set'`
  // even though `setWorkflowGrants` emits per-user `'grant'`/`'revoke'` rows
  // (forced by `target_user_id NOT NULL`). `'replace_set'` is reserved as an
  // affordance for a future bulk-audit shape where `target_user_id` is made
  // nullable; removing it from the CHECK now would require another migration
  // later if that shape is adopted.
  await db.query(`
    -- operator_user_id is NOT FK'd to users(id) because the operator can be
    -- either a real user (users.id) or a bootstrap/password admin
    -- (control_admin_users.id) — two independent UUID spaces. Audit logs
    -- are append-only history; referential integrity on the operator side
    -- would force coupling the bootstrap admin flow to users, which is out
    -- of scope for this PR. Target_user_id IS FK'd because grantees are
    -- always real users (enforced at the API boundary).
    CREATE TABLE IF NOT EXISTS trigger_grants_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_user_id UUID NOT NULL,
      target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('grant', 'revoke', 'replace_set')),
      payload_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- For clusters that bootstrapped with the original FK (pre-2026-04-23),
    -- drop it so the operator_user_id can accept control_admin_users UUIDs.
    ALTER TABLE trigger_grants_audit
      DROP CONSTRAINT IF EXISTS trigger_grants_audit_operator_user_id_fkey;
    CREATE INDEX IF NOT EXISTS idx_trigger_grants_audit_target
      ON trigger_grants_audit (target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trigger_grants_audit_recipe
      ON trigger_grants_audit (recipe_namespace, recipe_name, created_at DESC);

    -- actor_user_id is the caller recorded by the admin workflow lane. It can
    -- be either a real user UUID or a bootstrap/password admin UUID from
    -- control_admin_users, so it must not FK to users(id). target_team_id stays
    -- FK'd because granted teams are always real teams.
    CREATE TABLE IF NOT EXISTS team_workflow_grants_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE team_workflow_grants_audit
      DROP CONSTRAINT IF EXISTS team_workflow_grants_audit_actor_user_id_fkey;
    CREATE INDEX IF NOT EXISTS idx_team_workflow_grants_audit_team
      ON team_workflow_grants_audit (target_team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_team_workflow_grants_audit_recipe
      ON team_workflow_grants_audit (recipe_namespace, recipe_name, created_at DESC);

    -- Separate audit trail for approval-target allowlists. These rows are not
    -- trigger grants, so keep them out of team_workflow_grants_audit.
    CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('allow', 'revoke')),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_team
      ON workflow_recipe_allowed_teams_audit (target_team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_recipe
      ON workflow_recipe_allowed_teams_audit (recipe_namespace, recipe_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS role_changes_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      old_role TEXT NOT NULL,
      new_role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (operator_user_id != target_user_id OR old_role = 'admin')
    );
    CREATE INDEX IF NOT EXISTS idx_role_changes_audit_target
      ON role_changes_audit (target_user_id, created_at DESC);
  `)

  // ── STEP 5: Persistent run audit trail (survives CRD garbage collection) ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_runs_audit (
      run_id UUID PRIMARY KEY,
      run_namespace TEXT NOT NULL,
      run_name TEXT NOT NULL,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      triggerer_team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      usage_team_id TEXT NULL,
      triggerer_admin_user_id UUID NULL,
      triggerer_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      triggerer_actor_type TEXT NOT NULL CHECK (triggerer_actor_type IN ('user', 'admin', 'autonomous', 'scheduled')),
      triggerer_host_ref TEXT,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      triggered_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ NOT NULL,
      duration_ms BIGINT,
      final_phase TEXT NOT NULL CHECK (final_phase IN ('Succeeded', 'Failed', 'Canceled')),
      step_count INT NOT NULL CHECK (step_count >= 0),
      error_message TEXT,
      output_summary JSONB,
      snapshot_sha TEXT NOT NULL,
      template_ref TEXT,
      template_sha TEXT,
      reaped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_triggerer
      ON workflow_runs_audit (triggerer_user_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_recipe
      ON workflow_runs_audit (recipe_namespace, recipe_name, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_idempotency
      ON workflow_runs_audit (idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_phase_completed
      ON workflow_runs_audit (final_phase, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_retention
      ON workflow_runs_audit (completed_at) WHERE reaped_at IS NOT NULL;
    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS triggerer_team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;
    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS usage_team_id TEXT NULL;
    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS triggerer_admin_user_id UUID NULL;

    CREATE TABLE IF NOT EXISTS workflow_run_step_audit (
      run_id UUID NOT NULL REFERENCES workflow_runs_audit(run_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      step_phase TEXT NOT NULL CHECK (step_phase IN ('Succeeded', 'Failed', 'Skipped', 'Canceled')),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_ms BIGINT,
      tools_called TEXT[] NOT NULL DEFAULT '{}',
      output_files TEXT[] NOT NULL DEFAULT '{}',
      approval_request_id UUID REFERENCES workflow_approval_requests(id) ON DELETE SET NULL,
      error_message TEXT,
      PRIMARY KEY (run_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_run_step_audit_approval
      ON workflow_run_step_audit (approval_request_id) WHERE approval_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_run_step_audit_phase
      ON workflow_run_step_audit (step_phase, completed_at DESC);
  `)
  // ── STEP 6: DB-first workflow runs (source of truth; replaces WorkflowRun CRD) ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('Pending','Running','Succeeded','Failed','Canceled')),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      usage_team_id TEXT NULL,
      actor_id UUID NULL,
      idempotency_key TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      child_recipe_name TEXT NULL,
      child_recipe_namespace TEXT NULL,
      owner_instance_id TEXT NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000,
      approval_request_id UUID NULL REFERENCES workflow_approval_requests(id) ON DELETE SET NULL,
      idempotency_payload_hash TEXT NULL,
      started_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      last_reconciled_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE workflow_runs
      ALTER COLUMN started_at DROP DEFAULT;
    ALTER TABLE workflow_runs
      ALTER COLUMN started_at DROP NOT NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS approval_request_id UUID NULL REFERENCES workflow_approval_requests(id) ON DELETE SET NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS usage_team_id TEXT NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000;
    ALTER TABLE workflow_runs
      ALTER COLUMN ttl_seconds_after_finished SET DEFAULT 2592000;
    UPDATE workflow_runs
       SET ttl_seconds_after_finished = 2592000
     WHERE ttl_seconds_after_finished IS NULL;
    ALTER TABLE workflow_runs
      ALTER COLUMN ttl_seconds_after_finished SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_phase
      ON workflow_runs(phase) WHERE phase IN ('Pending','Running');
    CREATE INDEX IF NOT EXISTS idx_wr_owner
      ON workflow_runs(owner_instance_id) WHERE phase = 'Running';
    CREATE INDEX IF NOT EXISTS idx_wr_recipe
      ON workflow_runs(recipe_namespace, recipe_name);
    CREATE INDEX IF NOT EXISTS idx_wr_recipe_created_started
      ON workflow_runs(recipe_namespace, recipe_name, created_at DESC, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wr_completed
      ON workflow_runs(completed_at) WHERE completed_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wr_idempotency
      ON workflow_runs(recipe_namespace, recipe_name, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_approval_request
      ON workflow_runs(approval_request_id) WHERE approval_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_team
      ON workflow_runs(team_id) WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_usage_team
      ON workflow_runs(usage_team_id) WHERE usage_team_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      run_id UUID NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('Pending','Running','Succeeded','Failed','Skipped','Canceled')),
      started_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      output TEXT NULL,
      tools_called JSONB NULL,
      error TEXT NULL,
      PRIMARY KEY (run_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wrs_phase
      ON workflow_run_steps(run_id, phase);

    CREATE TABLE IF NOT EXISTS workflow_schedules (
      schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      next_fire_at TIMESTAMPTZ NOT NULL,
      last_fire_at TIMESTAMPTZ NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      input_template JSONB NULL,
      allowed_actors JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (recipe_namespace, recipe_name)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_next_fire
      ON workflow_schedules(next_fire_at) WHERE enabled = TRUE;
    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS allowed_actors JSONB NULL;
    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS max_duration_seconds INT NULL;
    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000;
    ALTER TABLE workflow_schedules
      ALTER COLUMN ttl_seconds_after_finished SET DEFAULT 2592000;
    UPDATE workflow_schedules
       SET ttl_seconds_after_finished = 2592000
     WHERE ttl_seconds_after_finished IS NULL;
    ALTER TABLE workflow_schedules
      ALTER COLUMN ttl_seconds_after_finished SET NOT NULL;
    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;
  `)

  await applyWorkflowRunCompletedNotificationTrigger(db)

  await db.query(
    `INSERT INTO control_admin_users(username, password_hash, email, role, status)
     SELECT $1, $2, NULLIF($3, ''), 'admin', 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM control_admin_users WHERE status = 'active'
      )
     ON CONFLICT (username) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         email = COALESCE(EXCLUDED.email, control_admin_users.email),
         role = 'admin',
         status = 'active',
         updated_at = NOW()
      WHERE NOT EXISTS (
        SELECT 1
         FROM control_admin_users
         WHERE status = 'active'
           AND username <> EXCLUDED.username
      )`,
    [config.adminBootstrapUsername, config.adminBootstrapPasswordHash, config.adminBootstrapEmail]
  )

  // gfs (Global File System) permission store — created for fresh clusters as
  // part of the baseline; existing clusters receive the same tables through
  // migration 0048_gfs_permission_store.
  await applyGfsPermissionStoreSchema(db)
}

export async function applyWorkflowRunCompletedNotificationTrigger(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workflow_run_update() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
         AND OLD.phase IS DISTINCT FROM NEW.phase
         AND NEW.phase IN ('Succeeded', 'Failed', 'Canceled')
         AND NEW.approval_request_id IS NOT NULL THEN
        INSERT INTO notification_deliveries
          (event_type, dedupe_key, audience, payload, priority, status, expires_at)
        SELECT
          'workflow.run.completed',
          'workflow.run.completed:' || NEW.run_id::text || ':' || NEW.phase,
          CASE
            WHEN war.target_user_id IS NOT NULL THEN jsonb_build_object('userId', war.target_user_id::text)
            ELSE jsonb_build_object('teamId', war.target_team_id::text)
          END,
          jsonb_build_object(
            'workflowRunId', NEW.run_id::text,
            'approvalRequestId', war.id::text,
            'recipeNamespace', NEW.recipe_namespace,
            'recipeName', NEW.recipe_name,
            'phase', NEW.phase,
            'completedAt', COALESCE(NEW.completed_at, NEW.updated_at, now()),
            'providerMedium', war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}',
            'providerChannelId', war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}',
            'providerWorkspaceId', war.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}',
            'providerThreadId', war.payload #>> '{metadata,workflowTrigger,providerBinding,providerThreadId}',
            'message', CASE
              WHEN NEW.phase = 'Succeeded' THEN 'Workflow ' || NEW.recipe_name || ' completed. Results are ready. Reply: download result'
              ELSE 'Workflow ' || NEW.recipe_name || ' finished with status ' || NEW.phase || '. Reply: download result to check available results.'
            END
          ),
          'normal',
          'queued',
          NOW() + INTERVAL '7 days'
        FROM workflow_approval_requests war
        JOIN workflow_approval_trigger_intents wati
          ON wati.approval_request_id = war.id
        WHERE war.id = NEW.approval_request_id
          AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' IN ('telegram', 'slack')
          AND NULLIF(war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}', '') IS NOT NULL
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;

      PERFORM pg_notify('workflow_run_update', NEW.run_id::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS workflow_runs_notify ON workflow_runs;
    CREATE TRIGGER workflow_runs_notify
      AFTER INSERT OR UPDATE OF phase ON workflow_runs
      FOR EACH ROW EXECUTE FUNCTION notify_workflow_run_update();
  `)
}

async function applyWorkflowRunRecipeCreatedStartedIndex(db: DbClient): Promise<void> {
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wr_recipe_created_started
      ON workflow_runs(recipe_namespace, recipe_name, created_at DESC, started_at DESC);
  `)
}

async function applyControlAdminEmailAndInvitationsSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE control_admin_users
      ADD COLUMN IF NOT EXISTS email TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_users_email_unique
      ON control_admin_users (lower(email))
      WHERE email IS NOT NULL AND email <> '';

    CREATE TABLE IF NOT EXISTS control_admin_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      invited_by_admin_id UUID REFERENCES control_admin_users(id) ON DELETE SET NULL,
      accepted_admin_id UUID REFERENCES control_admin_users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'opened', 'accepted', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_invitations_pending_email
      ON control_admin_invitations (lower(email))
      WHERE status IN ('pending', 'opened');
  `)
}

async function applyControlAdminEmailChangeRequestsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS control_admin_email_change_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES control_admin_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_email_change_requests_pending_admin
      ON control_admin_email_change_requests (admin_id)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_email_change_requests_pending_email
      ON control_admin_email_change_requests (lower(email))
      WHERE status = 'pending';
  `)
}

async function applyControlAdminDeletionAuditSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS control_admin_deletion_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_admin_id UUID,
      actor_username TEXT,
      actor_email TEXT,
      target_admin_id UUID NOT NULL,
      target_username TEXT NOT NULL,
      target_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_control_admin_deletion_audit_target
      ON control_admin_deletion_audit (target_admin_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_control_admin_deletion_audit_actor
      ON control_admin_deletion_audit (actor_admin_id, created_at DESC);
  `)
}

async function applyControlAdminPasswordResetRequestsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS control_admin_password_reset_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES control_admin_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_admin_password_resets_pending_admin
      ON control_admin_password_reset_requests (admin_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_control_admin_password_resets_lookup
      ON control_admin_password_reset_requests (email, id, created_at DESC);
  `)
}

async function applyControlAdminSessionVersionSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE control_admin_users
      ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  `)
}

async function applyUserDeleteAuditSetNullSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE trigger_grants_audit
      ALTER COLUMN target_user_id DROP NOT NULL;
    ALTER TABLE trigger_grants_audit
      DROP CONSTRAINT IF EXISTS trigger_grants_audit_target_user_id_fkey;
    ALTER TABLE trigger_grants_audit
      ADD CONSTRAINT trigger_grants_audit_target_user_id_fkey
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE role_changes_audit
      ALTER COLUMN operator_user_id DROP NOT NULL;
    ALTER TABLE role_changes_audit
      ALTER COLUMN target_user_id DROP NOT NULL;
    ALTER TABLE role_changes_audit
      DROP CONSTRAINT IF EXISTS role_changes_audit_operator_user_id_fkey;
    ALTER TABLE role_changes_audit
      DROP CONSTRAINT IF EXISTS role_changes_audit_target_user_id_fkey;
    ALTER TABLE role_changes_audit
      ADD CONSTRAINT role_changes_audit_operator_user_id_fkey
      FOREIGN KEY (operator_user_id) REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE role_changes_audit
      ADD CONSTRAINT role_changes_audit_target_user_id_fkey
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE workflow_runs_audit
      DROP CONSTRAINT IF EXISTS workflow_runs_audit_triggerer_user_id_fkey;
    ALTER TABLE workflow_runs_audit
      ADD CONSTRAINT workflow_runs_audit_triggerer_user_id_fkey
      FOREIGN KEY (triggerer_user_id) REFERENCES users(id) ON DELETE SET NULL;
  `)
}

async function applyWorkflowApprovalMediumSchema(db: DbClient): Promise<void> {
  await db.query(`
    -- ─── Workflow approval third-party medium binding ─────────────────────

    CREATE TABLE IF NOT EXISTS workflow_approval_medium_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      medium TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_workspace_id TEXT NULL,
      provider_channel_id TEXT NULL,
      communication_channel_ref TEXT NULL,
      verified_at TIMESTAMPTZ NOT NULL,
      disabled_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    DROP INDEX IF EXISTS idx_wama_active_provider_identity;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wama_active_provider_identity
      ON workflow_approval_medium_accounts (
        medium,
        provider_user_id,
        COALESCE(provider_workspace_id, ''),
        COALESCE(provider_channel_id, '')
      )
      WHERE disabled_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_wama_user_active
      ON workflow_approval_medium_accounts(user_id, medium)
      WHERE disabled_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_wama_channel_ref
      ON workflow_approval_medium_accounts(communication_channel_ref)
      WHERE disabled_at IS NULL;

    CREATE TABLE IF NOT EXISTS workflow_approval_medium_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      medium TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_workspace_id TEXT NULL,
      provider_channel_id TEXT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_wamc_user_medium
      ON workflow_approval_medium_challenges(user_id, medium, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wamc_expires
      ON workflow_approval_medium_challenges(expires_at)
      WHERE consumed_at IS NULL;

    CREATE TABLE IF NOT EXISTS workflow_approval_reader_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      medium TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      approval_request_id UUID NOT NULL REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
      processed_at TIMESTAMPTZ NULL,
      result TEXT NOT NULL DEFAULT 'received',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ware_provider_event
      ON workflow_approval_reader_events(medium, provider_event_id);
    CREATE INDEX IF NOT EXISTS idx_ware_approval
      ON workflow_approval_reader_events(approval_request_id, created_at DESC);
  `)
}

async function applyWorkflowApprovalProviderEventsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_approval_provider_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      medium TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      approval_request_id UUID NOT NULL REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
      processed_at TIMESTAMPTZ NULL,
      result TEXT NOT NULL DEFAULT 'received',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wape_provider_event
      ON workflow_approval_provider_events(medium, provider_event_id);
    CREATE INDEX IF NOT EXISTS idx_wape_approval
      ON workflow_approval_provider_events(approval_request_id, created_at DESC);
  `)
}

async function applyWorkflowApprovalMediumAccountChannelIdentityIndex(db: DbClient): Promise<void> {
  await db.query(`
    DROP INDEX IF EXISTS idx_wama_active_provider_identity;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wama_active_provider_identity
      ON workflow_approval_medium_accounts (
        medium,
        provider_user_id,
        COALESCE(provider_workspace_id, ''),
        COALESCE(provider_channel_id, '')
      )
      WHERE disabled_at IS NULL;
  `)
}

async function disableLegacyNullChannelMediumAccounts(db: DbClient): Promise<void> {
  await db.query(`
    UPDATE workflow_approval_medium_accounts legacy
       SET disabled_at = COALESCE(legacy.disabled_at, NOW()),
           updated_at = NOW()
     WHERE legacy.provider_channel_id IS NULL
       AND legacy.disabled_at IS NULL
       AND EXISTS (
         SELECT 1
           FROM workflow_approval_medium_accounts current
          WHERE current.id <> legacy.id
            AND current.disabled_at IS NULL
            AND current.medium = legacy.medium
            AND current.provider_user_id = legacy.provider_user_id
            AND COALESCE(current.provider_workspace_id, '') = COALESCE(legacy.provider_workspace_id, '')
            AND current.provider_channel_id IS NOT NULL
       );
  `)
}

async function alignWorkflowRunsAuditRecipeIndex(db: DbClient): Promise<void> {
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_recipe_triggered_at
      ON workflow_runs_audit (recipe_namespace, recipe_name, triggered_at DESC);
    DROP INDEX IF EXISTS idx_workflow_runs_audit_recipe;
  `)
}

/**
 * Drop the `trigger_grants_audit.operator_user_id_fkey` foreign key on
 * clusters that bootstrapped before commit 68c81bea.
 *
 * Context: the baseline migration (0001) originally declared this FK as
 * `REFERENCES users(id)`. Commit 68c81bea edited the baseline body in place
 * to add an `ALTER TABLE … DROP CONSTRAINT IF EXISTS …` — but baseline was
 * already recorded in `schema_migrations` on every long-lived cluster, so
 * the runner skipped it. The FK therefore survived on those clusters,
 * breaking `PUT /admin/workflows/:ns/:name/grants` with HTTP 500
 * (FK violation on the `trigger_grants_audit` INSERT) for every admin-ui
 * caller whose UUID lives in `control_admin_users` — a disjoint UUID space
 * from `users`.
 *
 * Fix-forward: a dedicated, versioned migration that every cluster (old or
 * new) runs exactly once. Idempotent via `DROP CONSTRAINT IF EXISTS`, so
 * fresh clusters that already dropped the constraint during baseline
 * simply no-op.
 *
 * Rediscovered end-to-end by the Desktop App competitive-intel happy-path
 * E2E running against clerum-dev on 2026-04-24.
 */
async function dropTriggerGrantsAuditOperatorFk(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE trigger_grants_audit
      DROP CONSTRAINT IF EXISTS trigger_grants_audit_operator_user_id_fkey;
  `)
}

async function dropTeamWorkflowGrantsAuditActorFk(db: DbClient): Promise<void> {
  await db.query(`
    -- actor_user_id records the admin workflow caller and may reference either
    -- users.id or control_admin_users.id, so it intentionally has no FK.
    ALTER TABLE team_workflow_grants_audit
      DROP CONSTRAINT IF EXISTS team_workflow_grants_audit_actor_user_id_fkey;
  `)
}

async function enforceWorkflowRecipeAllowedTeamsTeamFk(db: DbClient): Promise<void> {
  await db.query(`
    DELETE FROM workflow_recipe_allowed_teams wat
     WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = wat.team_id);

    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_team
      ON workflow_recipe_allowed_teams(team_id);

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'workflow_recipe_allowed_teams'::regclass
           AND conname = 'workflow_recipe_allowed_teams_team_id_fkey'
      ) THEN
        ALTER TABLE workflow_recipe_allowed_teams
          ADD CONSTRAINT workflow_recipe_allowed_teams_team_id_fkey
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `)
}

async function applyWorkflowRecipeAllowedTeamsAuditSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE team_workflow_grants_audit
      DROP CONSTRAINT IF EXISTS team_workflow_grants_audit_target_team_id_fkey;
    ALTER TABLE team_workflow_grants_audit
      ADD CONSTRAINT team_workflow_grants_audit_target_team_id_fkey
      FOREIGN KEY (target_team_id) REFERENCES teams(id) ON DELETE RESTRICT;

    CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('allow', 'revoke')),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_team
      ON workflow_recipe_allowed_teams_audit (target_team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_recipe
      ON workflow_recipe_allowed_teams_audit (recipe_namespace, recipe_name, created_at DESC);
  `)
}

async function applyUsageTrackingBaseline(db: DbClient): Promise<void> {
  await db.query(`
    DO $$ BEGIN
      CREATE TYPE usage_source_kind AS ENUM ('channel','desktop','workflow','cron','unknown');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS usage_events (
      request_id        UUID         PRIMARY KEY,
      ts                TIMESTAMPTZ  NOT NULL,
      host_ref          TEXT         NOT NULL,
      context_ref       TEXT,
      team_id           TEXT,
      provider          TEXT         NOT NULL,
      model             TEXT         NOT NULL,
      llm_secret_name   TEXT,
      source_kind       usage_source_kind NOT NULL,
      user_id           TEXT,
      sender            TEXT,
      channel_type      TEXT,
      recipe_name       TEXT,
      cron_job_id       TEXT,
      task_id           TEXT,
      iteration         INT,
      input_tokens      INT          NOT NULL,
      output_tokens     INT          NOT NULL,
      total_tokens      INT          GENERATED ALWAYS AS (input_tokens + output_tokens) STORED
    );

    CREATE INDEX IF NOT EXISTS usage_events_ts_idx
      ON usage_events (ts);
    CREATE INDEX IF NOT EXISTS usage_events_host_ref_ts_idx
      ON usage_events (host_ref, ts);
    CREATE INDEX IF NOT EXISTS usage_events_recipe_name_ts_idx
      ON usage_events (recipe_name, ts) WHERE recipe_name IS NOT NULL;
    CREATE INDEX IF NOT EXISTS usage_events_model_ts_idx
      ON usage_events (model, ts);
    CREATE INDEX IF NOT EXISTS usage_events_user_id_ts_idx
      ON usage_events (user_id, ts) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS usage_events_llm_secret_ts_idx
      ON usage_events (llm_secret_name, ts) WHERE llm_secret_name IS NOT NULL;
    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS team_id TEXT;
    CREATE INDEX IF NOT EXISTS usage_events_team_id_ts_idx
      ON usage_events (team_id, ts) WHERE team_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS usage_5min (
      bucket            TIMESTAMPTZ  NOT NULL,
      host_ref          TEXT         NOT NULL,
      context_ref       TEXT,
      team_id           TEXT,
      llm_secret_name   TEXT,
      user_id           TEXT,
      sender            TEXT,
      channel_type      TEXT,
      recipe_name       TEXT,
      cron_job_id       TEXT,
      provider          TEXT         NOT NULL,
      model             TEXT         NOT NULL,
      source_kind       usage_source_kind NOT NULL,
      context_ref_key   TEXT         GENERATED ALWAYS AS (COALESCE(context_ref, ''))     STORED,
      team_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(team_id, ''))         STORED,
      llm_secret_key    TEXT         GENERATED ALWAYS AS (COALESCE(llm_secret_name, '')) STORED,
      user_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(user_id, ''))         STORED,
      sender_key        TEXT         GENERATED ALWAYS AS (COALESCE(sender, ''))          STORED,
      channel_type_key  TEXT         GENERATED ALWAYS AS (COALESCE(channel_type, ''))    STORED,
      recipe_name_key   TEXT         GENERATED ALWAYS AS (COALESCE(recipe_name, ''))     STORED,
      cron_job_id_key   TEXT         GENERATED ALWAYS AS (COALESCE(cron_job_id, ''))     STORED,
      input_tokens      BIGINT       NOT NULL,
      output_tokens     BIGINT       NOT NULL,
      total_tokens      BIGINT       NOT NULL,
      request_count     BIGINT       NOT NULL,
      PRIMARY KEY (bucket, host_ref, context_ref_key, team_id_key,
                   provider, model, llm_secret_key, source_kind,
                   user_id_key, sender_key, channel_type_key,
                   recipe_name_key, cron_job_id_key)
    );

    CREATE INDEX IF NOT EXISTS usage_5min_bucket_idx
      ON usage_5min (bucket);
    CREATE INDEX IF NOT EXISTS usage_5min_team_idx
      ON usage_5min (team_id, bucket) WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS usage_5min_recipe_idx
      ON usage_5min (recipe_name, bucket) WHERE recipe_name IS NOT NULL;

    CREATE TABLE IF NOT EXISTS usage_hourly (
      bucket            TIMESTAMPTZ  NOT NULL,
      host_ref          TEXT         NOT NULL,
      context_ref       TEXT,
      team_id           TEXT,
      llm_secret_name   TEXT,
      user_id           TEXT,
      sender            TEXT,
      channel_type      TEXT,
      recipe_name       TEXT,
      cron_job_id       TEXT,
      provider          TEXT         NOT NULL,
      model             TEXT         NOT NULL,
      source_kind       usage_source_kind NOT NULL,
      context_ref_key   TEXT         GENERATED ALWAYS AS (COALESCE(context_ref, ''))     STORED,
      team_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(team_id, ''))         STORED,
      llm_secret_key    TEXT         GENERATED ALWAYS AS (COALESCE(llm_secret_name, '')) STORED,
      user_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(user_id, ''))         STORED,
      sender_key        TEXT         GENERATED ALWAYS AS (COALESCE(sender, ''))          STORED,
      channel_type_key  TEXT         GENERATED ALWAYS AS (COALESCE(channel_type, ''))    STORED,
      recipe_name_key   TEXT         GENERATED ALWAYS AS (COALESCE(recipe_name, ''))     STORED,
      cron_job_id_key   TEXT         GENERATED ALWAYS AS (COALESCE(cron_job_id, ''))     STORED,
      input_tokens      BIGINT       NOT NULL,
      output_tokens     BIGINT       NOT NULL,
      total_tokens      BIGINT       NOT NULL,
      request_count     BIGINT       NOT NULL,
      PRIMARY KEY (bucket, host_ref, context_ref_key, team_id_key,
                   provider, model, llm_secret_key, source_kind,
                   user_id_key, sender_key, channel_type_key,
                   recipe_name_key, cron_job_id_key)
    );

    CREATE INDEX IF NOT EXISTS usage_hourly_bucket_idx
      ON usage_hourly (bucket);
    CREATE INDEX IF NOT EXISTS usage_hourly_team_idx
      ON usage_hourly (team_id, bucket) WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS usage_hourly_recipe_idx
      ON usage_hourly (recipe_name, bucket) WHERE recipe_name IS NOT NULL;

    CREATE TABLE IF NOT EXISTS usage_daily (
      bucket            TIMESTAMPTZ  NOT NULL,
      host_ref          TEXT         NOT NULL,
      context_ref       TEXT,
      team_id           TEXT,
      llm_secret_name   TEXT,
      user_id           TEXT,
      sender            TEXT,
      channel_type      TEXT,
      recipe_name       TEXT,
      cron_job_id       TEXT,
      provider          TEXT         NOT NULL,
      model             TEXT         NOT NULL,
      source_kind       usage_source_kind NOT NULL,
      context_ref_key   TEXT         GENERATED ALWAYS AS (COALESCE(context_ref, ''))     STORED,
      team_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(team_id, ''))         STORED,
      llm_secret_key    TEXT         GENERATED ALWAYS AS (COALESCE(llm_secret_name, '')) STORED,
      user_id_key       TEXT         GENERATED ALWAYS AS (COALESCE(user_id, ''))         STORED,
      sender_key        TEXT         GENERATED ALWAYS AS (COALESCE(sender, ''))          STORED,
      channel_type_key  TEXT         GENERATED ALWAYS AS (COALESCE(channel_type, ''))    STORED,
      recipe_name_key   TEXT         GENERATED ALWAYS AS (COALESCE(recipe_name, ''))     STORED,
      cron_job_id_key   TEXT         GENERATED ALWAYS AS (COALESCE(cron_job_id, ''))     STORED,
      input_tokens      BIGINT       NOT NULL,
      output_tokens     BIGINT       NOT NULL,
      total_tokens      BIGINT       NOT NULL,
      request_count     BIGINT       NOT NULL,
      PRIMARY KEY (bucket, host_ref, context_ref_key, team_id_key,
                   provider, model, llm_secret_key, source_kind,
                   user_id_key, sender_key, channel_type_key,
                   recipe_name_key, cron_job_id_key)
    );

    CREATE INDEX IF NOT EXISTS usage_daily_bucket_idx
      ON usage_daily (bucket);
    CREATE INDEX IF NOT EXISTS usage_daily_team_idx
      ON usage_daily (team_id, bucket) WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS usage_daily_recipe_idx
      ON usage_daily (recipe_name, bucket) WHERE recipe_name IS NOT NULL;
  `)
}

async function applyWorkflowUsageAttributionSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_team
      ON workflow_runs(team_id) WHERE team_id IS NOT NULL;

    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS triggerer_team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;

    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;

    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS team_id TEXT;
    CREATE INDEX IF NOT EXISTS usage_events_team_id_ts_idx
      ON usage_events (team_id, ts) WHERE team_id IS NOT NULL;
  `)
}

async function applyWorkflowAdminUsageAttributionSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_runs
      DROP CONSTRAINT IF EXISTS workflow_runs_actor_type_check;
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_actor_type_check
      CHECK (actor_type IN ('user','admin','autonomous','scheduled'));
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS usage_team_id TEXT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_usage_team
      ON workflow_runs(usage_team_id) WHERE usage_team_id IS NOT NULL;

    ALTER TABLE workflow_runs_audit
      DROP CONSTRAINT IF EXISTS workflow_runs_audit_triggerer_actor_type_check;
    ALTER TABLE workflow_runs_audit
      ADD CONSTRAINT workflow_runs_audit_triggerer_actor_type_check
      CHECK (triggerer_actor_type IN ('user','admin','autonomous','scheduled'));
    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS usage_team_id TEXT NULL;
    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS triggerer_admin_user_id UUID NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit_triggerer_admin
      ON workflow_runs_audit (triggerer_admin_user_id, completed_at DESC)
      WHERE triggerer_admin_user_id IS NOT NULL;
  `)
}

async function applyInvitationAndUserPasswordMigration(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;

    ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

    ALTER TABLE invitations
      ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '48 hours');

    UPDATE invitations
       SET expires_at = COALESCE(expires_at, created_at + INTERVAL '48 hours')
     WHERE expires_at IS NULL;

    ALTER TABLE invitations
      ALTER COLUMN expires_at SET NOT NULL;

    ALTER TABLE invitations
      ALTER COLUMN token SET DEFAULT gen_random_uuid()::text;

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_status_check;

    ALTER TABLE invitations
      ADD CONSTRAINT invitations_status_check
      CHECK (status IN ('draft', 'pending', 'accepted', 'revoked'));

    ALTER TABLE invitations
      DROP COLUMN IF EXISTS invited_by;
  `)
}

async function applyInvitationInviteeNameMigration(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS invitee_name TEXT;
  `)
}

async function allowTeamlessInvitations(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE invitations
      ALTER COLUMN team_id DROP NOT NULL;
  `)
}

async function applyWorkflowRunApprovalBindingMigration(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS approval_request_id UUID NULL REFERENCES workflow_approval_requests(id) ON DELETE SET NULL;
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT NULL;
    CREATE INDEX IF NOT EXISTS idx_wr_approval_request
      ON workflow_runs(approval_request_id) WHERE approval_request_id IS NOT NULL;
  `)
}

async function applyWorkflowRunRetentionColumnsMigration(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000;
    ALTER TABLE workflow_runs
      ALTER COLUMN ttl_seconds_after_finished SET DEFAULT 2592000;
    UPDATE workflow_runs
       SET ttl_seconds_after_finished = 2592000
     WHERE ttl_seconds_after_finished IS NULL;
    ALTER TABLE workflow_runs
      ALTER COLUMN ttl_seconds_after_finished SET NOT NULL;

    ALTER TABLE workflow_schedules
      ADD COLUMN IF NOT EXISTS ttl_seconds_after_finished INT NOT NULL DEFAULT 2592000;
    ALTER TABLE workflow_schedules
      ALTER COLUMN ttl_seconds_after_finished SET DEFAULT 2592000;
    UPDATE workflow_schedules
       SET ttl_seconds_after_finished = 2592000
     WHERE ttl_seconds_after_finished IS NULL;
    ALTER TABLE workflow_schedules
      ALTER COLUMN ttl_seconds_after_finished SET NOT NULL;
  `)
}

async function applyWorkflowTriggerSharedFoundationSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      trigger_namespace TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      trigger_caller_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wati_trigger
      ON workflow_approval_trigger_intents(trigger_namespace, trigger_name, trigger_caller_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_intents_archive (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests_archive(id) ON DELETE CASCADE,
      trigger_namespace TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      trigger_caller_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watia_trigger
      ON workflow_approval_trigger_intents_archive(trigger_namespace, trigger_name, trigger_caller_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watri_idempotency
      ON workflow_approval_trigger_run_intents(idempotency_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents_archive (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests_archive(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watria_idempotency
      ON workflow_approval_trigger_run_intents_archive(idempotency_key);

    -- Team trigger grants are intentionally not backfilled from
    -- workflow_recipe_allowed_teams or team_members. Approval target allowlists
    -- and trigger grants are separate contracts; conflating them would widen
    -- trigger authority during migration.
    CREATE TABLE IF NOT EXISTS team_workflow_triggers (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, recipe_namespace, recipe_name)
    );
    CREATE INDEX IF NOT EXISTS idx_team_workflow_triggers_team
      ON team_workflow_triggers(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_workflow_triggers_recipe
      ON team_workflow_triggers(recipe_namespace, recipe_name);

    -- actor_user_id records the admin workflow caller and may reference either
    -- users.id or control_admin_users.id, so it intentionally has no FK.
    CREATE TABLE IF NOT EXISTS team_workflow_grants_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE team_workflow_grants_audit
      DROP CONSTRAINT IF EXISTS team_workflow_grants_audit_actor_user_id_fkey;
    CREATE INDEX IF NOT EXISTS idx_team_workflow_grants_audit_team
      ON team_workflow_grants_audit (target_team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_team_workflow_grants_audit_recipe
      ON team_workflow_grants_audit (recipe_namespace, recipe_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_recipe_allowed_teams_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('allow', 'revoke')),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_team
      ON workflow_recipe_allowed_teams_audit (target_team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_recipe_allowed_teams_audit_recipe
      ON workflow_recipe_allowed_teams_audit (recipe_namespace, recipe_name, created_at DESC);
  `)

  const malformedLive = await db.query(`
    SELECT id::text AS id,
           COUNT(*) OVER ()::int AS total
      FROM workflow_approval_requests
     WHERE status IN ('pending', 'approved')
       AND expires_at > NOW()
       AND payload->'metadata' ? 'workflowTrigger'
       AND NOT (
         jsonb_typeof(payload->'metadata'->'workflowTrigger') = 'object'
         AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'namespace') = 'string'
         AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'name') = 'string'
         AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'caller') = 'string'
         AND btrim(payload->'metadata'->'workflowTrigger'->>'namespace') <> ''
         AND btrim(payload->'metadata'->'workflowTrigger'->>'name') <> ''
         AND btrim(payload->'metadata'->'workflowTrigger'->>'caller') <> ''
       )
     ORDER BY id
  `)
  if ((malformedLive.rowCount ?? 0) > 0) {
    const ids = malformedLive.rows.map(row => String((row as { id: string }).id)).join(', ')
    const total = Number(
      (malformedLive.rows[0] as { total?: number | string }).total ?? malformedLive.rows.length
    )
    throw new Error(
      `Cannot migrate ${total} live trigger-bound workflow approvals with malformed workflowTrigger metadata: ${ids}`
    )
  }

  await db.query(`
    INSERT INTO workflow_approval_trigger_intents (
      approval_request_id,
      trigger_namespace,
      trigger_name,
      trigger_caller_key,
      created_at
    )
    SELECT id,
           btrim(payload->'metadata'->'workflowTrigger'->>'namespace'),
           btrim(payload->'metadata'->'workflowTrigger'->>'name'),
           btrim(payload->'metadata'->'workflowTrigger'->>'caller'),
           requested_at
      FROM workflow_approval_requests
     WHERE status IN ('pending', 'approved')
       AND expires_at > NOW()
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger') = 'object'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'namespace') = 'string'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'name') = 'string'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'caller') = 'string'
       AND btrim(payload->'metadata'->'workflowTrigger'->>'namespace') <> ''
       AND btrim(payload->'metadata'->'workflowTrigger'->>'name') <> ''
       AND btrim(payload->'metadata'->'workflowTrigger'->>'caller') <> ''
    ON CONFLICT (approval_request_id) DO NOTHING;

    INSERT INTO workflow_approval_trigger_intents_archive (
      approval_request_id,
      trigger_namespace,
      trigger_name,
      trigger_caller_key,
      created_at,
      archived_at
    )
    SELECT id,
           btrim(payload->'metadata'->'workflowTrigger'->>'namespace'),
           btrim(payload->'metadata'->'workflowTrigger'->>'name'),
           btrim(payload->'metadata'->'workflowTrigger'->>'caller'),
           requested_at,
           archived_at
      FROM workflow_approval_requests_archive
     WHERE jsonb_typeof(payload->'metadata'->'workflowTrigger') = 'object'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'namespace') = 'string'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'name') = 'string'
       AND jsonb_typeof(payload->'metadata'->'workflowTrigger'->'caller') = 'string'
       AND btrim(payload->'metadata'->'workflowTrigger'->>'namespace') <> ''
       AND btrim(payload->'metadata'->'workflowTrigger'->>'name') <> ''
       AND btrim(payload->'metadata'->'workflowTrigger'->>'caller') <> ''
    ON CONFLICT (approval_request_id) DO NOTHING;
  `)
}

async function applyWorkflowApprovalTriggerRunIntentSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watri_idempotency
      ON workflow_approval_trigger_run_intents(idempotency_key);

    CREATE TABLE IF NOT EXISTS workflow_approval_trigger_run_intents_archive (
      approval_request_id UUID PRIMARY KEY REFERENCES workflow_approval_requests_archive(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','autonomous','scheduled')),
      actor_id UUID NULL,
      team_id UUID NULL,
      usage_team_id TEXT NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('onDemand', 'schedule', 'autonomous')),
      idempotency_key TEXT NOT NULL,
      inputs JSONB NULL,
      intermediate_parameters JSONB NULL,
      output_overrides JSONB NULL,
      max_duration_seconds INT NULL,
      ttl_seconds_after_finished INT NULL,
      idempotency_payload_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_watria_idempotency
      ON workflow_approval_trigger_run_intents_archive(idempotency_key);
  `)
}

async function seedSentinelAllowlistForExistingAdmins(db: DbClient): Promise<void> {
  // Grants every existing admin user the sentinel binding (mcp-host/standalone)
  // so 1st-party host approvals work end-to-end after a fresh deploy. Future
  // mutations (new admins, non-admin grants) flow through control-ui admin surfaces.
  await db.query(`
    INSERT INTO workflow_recipe_allowed_users (recipe_namespace, recipe_name, user_id)
    SELECT 'mcp-host', 'standalone', id FROM users WHERE role = 'admin'
    ON CONFLICT DO NOTHING;
  `)
}

async function removeTeamOwnerRole(db: DbClient): Promise<void> {
  await db.query(`
    UPDATE team_members
       SET role = 'admin',
           updated_at = NOW()
     WHERE role = 'owner';

    ALTER TABLE team_members
      DROP CONSTRAINT IF EXISTS team_members_role_check;

    ALTER TABLE team_members
      ADD CONSTRAINT team_members_role_check
      CHECK (role IN ('admin', 'inviter', 'member'));
  `)
}

async function applyInvitationTeamsAndPurposeSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'member_invitation';

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_purpose_check;

    ALTER TABLE invitations
      ADD CONSTRAINT invitations_purpose_check
      CHECK (purpose IN ('member_invitation', 'password_reset', 'admin_desktop_access'));

    CREATE TABLE IF NOT EXISTS invitation_teams (
      invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (invitation_id, team_id)
    );

    CREATE INDEX IF NOT EXISTS idx_invitation_teams_team
      ON invitation_teams(team_id, invitation_id);

    INSERT INTO invitation_teams(invitation_id, team_id, role, created_at)
    SELECT id, team_id, role, created_at
      FROM invitations
     WHERE team_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `)
}

async function applyAdminDesktopAccessInvitationPurpose(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_purpose_check;

    ALTER TABLE invitations
      ADD CONSTRAINT invitations_purpose_check
      CHECK (purpose IN ('member_invitation', 'password_reset', 'admin_desktop_access'));
  `)
}

async function applyControlAdminInvitationOpenedStatus(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE control_admin_invitations
      DROP CONSTRAINT IF EXISTS control_admin_invitations_status_check;

    ALTER TABLE control_admin_invitations
      ADD CONSTRAINT control_admin_invitations_status_check
      CHECK (status IN ('pending', 'opened', 'accepted', 'revoked'));

    -- Accepted invitations for deleted admins can have accepted_admin_id nulled by FK.
    -- Keep those rows accepted so they do not re-enter active invitation uniqueness.
    UPDATE control_admin_invitations
       SET status = 'opened'
     WHERE status = 'accepted'
       AND accepted_admin_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM control_admin_deletion_audit audit
          WHERE lower(audit.target_email) = lower(control_admin_invitations.email)
       );

    -- Idempotent startup cleanup before rebuilding the pending/opened partial unique index.
    UPDATE control_admin_invitations
       SET status = 'revoked'
     WHERE status IN ('pending', 'opened')
       AND expires_at <= NOW();

    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY lower(email)
               ORDER BY
                 CASE WHEN status = 'opened' THEN 0 ELSE 1 END,
                 accepted_at DESC NULLS LAST,
                 created_at DESC,
                 id DESC
             ) AS duplicate_rank
        FROM control_admin_invitations
       WHERE status IN ('pending', 'opened')
    )
    UPDATE control_admin_invitations invitations
       SET status = 'revoked'
      FROM ranked
     WHERE invitations.id = ranked.id
       AND ranked.duplicate_rank > 1;

    DROP INDEX IF EXISTS idx_control_admin_invitations_pending_email;
    CREATE UNIQUE INDEX idx_control_admin_invitations_pending_email
      ON control_admin_invitations (lower(email))
      WHERE status IN ('pending', 'opened');
  `)
}

// `notification_deliveries.delivered_medium` was added to the baseline schema
// (applyBaselineSchema) but never as a versioned migration, so long-lived
// clusters that already had `0001_control_api_baseline` recorded never received
// the column. The terminal/ack delivery path
// (notificationDeliveryTerminalService, notificationAckService) writes this
// column, so its absence raised `column "delivered_medium" ... does not exist`
// 500s on every Figure D delivery. Self-contained + idempotent (ADD COLUMN IF
// NOT EXISTS): a no-op on fresh DBs that already got it from baseline.
async function applyNotificationDeliveriesDeliveredMedium(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE notification_deliveries
      ADD COLUMN IF NOT EXISTS delivered_medium TEXT NULL;
  `)
}

// Figure D multi-bot: bind every verified medium account to the
// CommunicationChannel it was verified through (`communication_channel_ref` =
// "namespace/name"). The delivery worker resolves the per-channel bot from that
// channel's credentials Secret (mirroring Figure C), and the authorization
// query filters by it so a user verified on bot A cannot approve via bot B
// (cross-bot identity confusion — the Telegram user id is global).
//
// Also extends notification_deliveries.status with `skipped_no_bot`: the worker
// marks a delivery skipped (NOT sent, NOT retried) when no bot credential can be
// resolved for its channel, instead of silently swallowing it.
//
// Legacy rows have no channel ref. Per owner decision, only `telegram` rows are
// force-disabled (so the user re-verifies and populates the ref) — Slack and any
// other model keep their NULL ref untouched, so Figure C delivery is not broken.
// Self-contained + idempotent: ADD COLUMN/INDEX IF NOT EXISTS, DROP+ADD
// CONSTRAINT IF EXISTS, and the disable UPDATE only touches still-NULL active
// telegram rows (a no-op on re-run once every active telegram row has a ref).
async function applyWorkflowApprovalMediumChannelRef(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_approval_medium_accounts
      ADD COLUMN IF NOT EXISTS communication_channel_ref TEXT NULL;

    CREATE INDEX IF NOT EXISTS idx_wama_channel_ref
      ON workflow_approval_medium_accounts(communication_channel_ref)
      WHERE disabled_at IS NULL;

    ALTER TABLE notification_deliveries
      DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_status_check
      CHECK (status IN ('queued','sent','failed','retrying','cancelled','skipped_no_bot'));

    UPDATE workflow_approval_medium_accounts
       SET disabled_at = now()
     WHERE medium = 'telegram'
       AND communication_channel_ref IS NULL
       AND disabled_at IS NULL;
  `)
}

// Preferred delivery instance: a single verified medium account a user picks to
// receive non-conversational deliveries (push notifications + approvals that did
// not originate from a chat). NULL = automatic default (most-recently-verified).
// ON DELETE SET NULL covers a physical row delete; the soft-disable path clears
// it explicitly in disableVerifiedMediumAccount so a disabled preferred account
// degrades to the default instead of silently blocking delivery.
async function applyUserNotificationPreferencesPreferredAccount(db: DbClient): Promise<void> {
  // Self-contained: user_notification_preferences was added to the BASELINE
  // schema, so clusters that ran 0001 before that table existed (e.g. clerum-dev)
  // never created it — and the baseline does not re-run. Create it idempotently
  // (exact baseline shape) before the ALTER so this migration succeeds on both
  // fresh clusters (no-op; table already exists) and pre-existing clusters.
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferred_medium TEXT NULL CHECK (preferred_medium IS NULL OR preferred_medium IN ('telegram', 'slack')),
      channel_fallback_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE user_notification_preferences
      ADD COLUMN IF NOT EXISTS preferred_account_id UUID NULL
        REFERENCES workflow_approval_medium_accounts(id) ON DELETE SET NULL;
  `)
}

async function applyGfsPermissionStoreSchema(db: DbClient): Promise<void> {
  // Global File System (gfs) permission store — the governance plane's source
  // of truth for resource metadata, folder grants, URI-bound shares, and the
  // append-only hash-chained audit log. File bytes live flat by resource_id in
  // the gfsc-mounted volume; the human path is metadata here (path_cache),
  // never mirrored on disk. There is deliberately NO tenant_id column —
  // multi-tenancy is the managed edition (P6), not the open core.
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    -- Resource records: one row per file/directory. resource_id is immutable
    -- across rename/move; a move is a pure DB reparent (parent_resource_id +
    -- name + path_cache change, resource_id never does, shares never invalidate).
    CREATE TABLE IF NOT EXISTS gfs_resources (
      resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      drive TEXT NOT NULL,
      parent_resource_id UUID NULL REFERENCES gfs_resources(resource_id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file','directory')),
      path_cache TEXT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ NULL
    );

    -- Sibling uniqueness among non-deleted rows. name is NFC-normalized by the
    -- application and case-sensitive (Report.md <> report.md); uniqueness does
    -- not depend on filesystem case behavior because the on-disk blob is keyed
    -- by resource_id, not name.
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_resources_sibling_uniq
      ON gfs_resources (drive, parent_resource_id, name)
      WHERE deleted_at IS NULL;

    -- Exactly ONE synthetic root per drive (parent_resource_id IS NULL). The
    -- sibling index above does NOT dedupe roots because NULL <> NULL in a unique
    -- index; with the synthetic-root layout only the root has a NULL parent, so
    -- this partial index enforces a single live root per drive.
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_resources_root_uniq
      ON gfs_resources (drive)
      WHERE parent_resource_id IS NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS gfs_resources_parent_idx
      ON gfs_resources (drive, parent_resource_id)
      WHERE deleted_at IS NULL;

    -- Folder grants (Layer 1/2). A grant gives a subject a set of permission
    -- bits on a resource. The subject is the spec's structured {type, id?}:
    -- subject_type ∈ operator|user|team|host|context; subject_id is the UUID
    -- (user/team/context), the host binding (host), or '' for the whole
    -- operator group (no per-row id). Per spec §Inheritance, a grant does NOT
    -- inherit to descendants unless inherit = true; it always applies to its own
    -- resource. granted_by records the grantor for the no-escalation and audit
    -- invariants. Grants are RETAINED on tombstone so gfsc can still decide
    -- 410-vs-404 for a deleted resource.
    CREATE TABLE IF NOT EXISTS gfs_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      drive TEXT NOT NULL,
      resource_id UUID NOT NULL REFERENCES gfs_resources(resource_id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('operator','user','team','host','context')),
      subject_id TEXT NOT NULL DEFAULT '',
      permissions TEXT[] NOT NULL,
      inherit BOOLEAN NOT NULL DEFAULT false,
      granted_by TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT gfs_grants_permissions_valid
        CHECK (permissions <@ ARRAY['read','write','delete','manage_acl','share']::text[]),
      CONSTRAINT gfs_grants_subject_resource_uniq
        UNIQUE (drive, resource_id, subject_type, subject_id)
    );

    CREATE INDEX IF NOT EXISTS gfs_grants_subject_idx
      ON gfs_grants (drive, subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS gfs_grants_resource_idx ON gfs_grants (drive, resource_id);

    -- URI-bound shares (Layer 3): a grant on a single resource_id for subjects
    -- without folder access. The subject uses the same structured {type, id?}
    -- encoding as gfs_grants. include_descendants authorizes by parent-chain
    -- traversal (the share-side equivalent of a grant's inherit). Revocable any
    -- time (immediate) by deleting the row.
    CREATE TABLE IF NOT EXISTS gfs_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      drive TEXT NOT NULL,
      resource_id UUID NOT NULL REFERENCES gfs_resources(resource_id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('operator','user','team','host','context')),
      subject_id TEXT NOT NULL DEFAULT '',
      permissions TEXT[] NOT NULL,
      include_descendants BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT gfs_shares_permissions_valid
        CHECK (permissions <@ ARRAY['read','write','delete','manage_acl','share']::text[]),
      CONSTRAINT gfs_shares_subject_resource_uniq
        UNIQUE (drive, resource_id, subject_type, subject_id)
    );

    CREATE INDEX IF NOT EXISTS gfs_shares_subject_idx
      ON gfs_shares (drive, subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS gfs_shares_resource_idx ON gfs_shares (drive, resource_id);

    -- Immediate revocation (spec §Governance controls): any grant/share mutation
    -- emits NOTIFY on the gfs_perm_invalidate channel so every gfsc reader flushes
    -- its decision cache at once — revocation is NOT TTL-bound. A statement-level
    -- trigger is writer-agnostic: it fires even if a future path mutates the rows
    -- outside the application emitter. Re-created idempotently on every apply.
    CREATE OR REPLACE FUNCTION gfs_notify_perm_invalidate() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('gfs_perm_invalidate', '');
      RETURN NULL;
    END;
    $$;
    DROP TRIGGER IF EXISTS gfs_grants_perm_invalidate ON gfs_grants;
    CREATE TRIGGER gfs_grants_perm_invalidate
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON gfs_grants
      FOR EACH STATEMENT EXECUTE FUNCTION gfs_notify_perm_invalidate();
    DROP TRIGGER IF EXISTS gfs_shares_perm_invalidate ON gfs_shares;
    CREATE TRIGGER gfs_shares_perm_invalidate
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON gfs_shares
      FOR EACH STATEMENT EXECUTE FUNCTION gfs_notify_perm_invalidate();
    DROP TRIGGER IF EXISTS gfs_resources_perm_invalidate ON gfs_resources;
    CREATE TRIGGER gfs_resources_perm_invalidate
      AFTER UPDATE OF parent_resource_id, deleted_at OR DELETE OR TRUNCATE ON gfs_resources
      FOR EACH STATEMENT EXECUTE FUNCTION gfs_notify_perm_invalidate();

    -- Append-only, hash-chained audit log. Every mutation AND every authz
    -- denial / break-glass is written INSERT-only. sequence_no is monotonic and
    -- bound into the hash chain (prev_hash -> row_hash) so reordering or an
    -- in-band row edit breaks verification. Insert-only is enforced both by the
    -- gfsc role grants below and by the hash chain itself.
    CREATE TABLE IF NOT EXISTS gfs_audit (
      sequence_no BIGSERIAL PRIMARY KEY,
      event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
      subject TEXT NOT NULL,
      actor_on_behalf_of TEXT NULL,
      op TEXT NOT NULL,
      gfs_uri TEXT NULL,
      outcome TEXT NOT NULL,
      bytes BIGINT NULL,
      duration_ms INTEGER NULL,
      source_ip TEXT NULL,
      request_id TEXT NULL,
      prev_hash TEXT NULL,
      row_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS gfs_audit_subject_time_idx ON gfs_audit (subject, event_time);
    CREATE INDEX IF NOT EXISTS gfs_audit_uri_time_idx ON gfs_audit (gfs_uri, event_time);
  `)

  // DB-level least privilege for the gfsc service role. gfsc re-checks the
  // permission store on every op (read path in P1) and appends audit rows, but
  // it must NEVER write the grant/share tables — those are mutated only by the
  // governance plane (control-api). The role is created NOLOGIN here purely as a
  // GRANT target; deploy/secret provisioning attaches LOGIN + password, so no
  // credential ever lives in code. gfs_resources is writable only for the gfsc
  // writer data plane; readers do not register write handlers.
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gfs_controller') THEN
        CREATE ROLE gfs_controller NOLOGIN;
      END IF;
    END
    $$;

    GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller;
    -- gfsc's write data plane creates/replaces/soft-deletes resources (P4): it
    -- needs INSERT + UPDATE on gfs_resources (create row; bump version/bytes;
    -- set deleted_at). It NEVER hard-DELETEs or TRUNCATEs (erasure is a separate
    -- governance path), and NEVER writes the ACL tables (grants/shares).
    GRANT INSERT, UPDATE ON gfs_resources TO gfs_controller;
    GRANT INSERT ON gfs_audit TO gfs_controller;
    GRANT USAGE, SELECT ON SEQUENCE gfs_audit_sequence_no_seq TO gfs_controller;

    -- gfsc resolves a verified token's principal into its subject set at check
    -- time (spec §Subjects): it probes control_admin_users to tell an operator
    -- from a user (disjoint UUID pools) and team_members to expand a user into
    -- its active teams. COLUMN-level SELECT only — never the password hash / PII
    -- columns of control_admin_users; read-only, no escalation.
    GRANT SELECT (id, status) ON control_admin_users TO gfs_controller;
    GRANT SELECT (team_id, user_id, status) ON team_members TO gfs_controller;

    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_grants FROM gfs_controller;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_shares FROM gfs_controller;
    REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit FROM gfs_controller;
    REVOKE DELETE, TRUNCATE ON gfs_resources FROM gfs_controller;
  `)
}

const CONTROL_API_MIGRATIONS: DbMigration[] = [
  {
    // Keep auto-migrations strictly additive / non-destructive. If we ever
    // need a destructive cleanup (DROP column/table, rewrite data, etc.), it
    // must ship as an explicitly reviewed migration step rather than being
    // hidden inside the baseline bootstrap.
    // Important: once a migration ships, do not edit its body in place. Add a
    // new versioned step instead so already-migrated clusters stay consistent.
    version: '0001_control_api_baseline',
    apply: applyBaselineSchema,
  },
  {
    version: '0002_workflow_runs_audit_recipe_triggered_at_index',
    apply: alignWorkflowRunsAuditRecipeIndex,
  },
  {
    version: '0003_drop_trigger_grants_audit_operator_fk',
    apply: dropTriggerGrantsAuditOperatorFk,
  },
  {
    version: '0004_invitation_and_user_password_columns',
    apply: applyInvitationAndUserPasswordMigration,
  },
  {
    version: '0005_invitation_invitee_name',
    apply: applyInvitationInviteeNameMigration,
  },
  {
    version: '0006_seed_sentinel_allowlist_for_admins',
    apply: seedSentinelAllowlistForExistingAdmins,
  },
  {
    version: '0007_workflow_run_approval_binding',
    apply: applyWorkflowRunApprovalBindingMigration,
  },
  {
    version: '0008_workflow_approval_medium_schema',
    apply: applyWorkflowApprovalMediumSchema,
  },
  {
    version: '0009_usage_tracking_baseline',
    apply: applyUsageTrackingBaseline,
  },
  {
    version: '0010_workflow_usage_attribution_schema',
    apply: applyWorkflowUsageAttributionSchema,
  },
  {
    version: '0011_workflow_admin_usage_attribution_schema',
    apply: applyWorkflowAdminUsageAttributionSchema,
  },
  {
    version: '0012_workflow_run_retention_columns',
    apply: applyWorkflowRunRetentionColumnsMigration,
  },
  {
    version: '0013_oauth_grants_table',
    apply: applyOAuthGrantsTable,
  },
  {
    version: '0014_consolidate_workflow_allowed_users',
    apply: consolidateWorkflowAllowedUsersToTriggers,
  },
  {
    version: '0015_oauth_service_grants',
    apply: applyOAuthServiceGrants,
  },
  {
    version: '0016_workflow_trigger_shared_foundation',
    apply: applyWorkflowTriggerSharedFoundationSchema,
  },
  {
    version: '0017_drop_team_workflow_grants_audit_actor_fk',
    apply: dropTeamWorkflowGrantsAuditActorFk,
  },
  {
    version: '0018_workflow_recipe_allowed_teams_team_fk',
    apply: enforceWorkflowRecipeAllowedTeamsTeamFk,
  },
  {
    version: '0019_workflow_recipe_allowed_teams_audit',
    apply: applyWorkflowRecipeAllowedTeamsAuditSchema,
  },
  {
    version: '0020_workflow_approval_trigger_run_intents',
    apply: applyWorkflowApprovalTriggerRunIntentSchema,
  },
  {
    version: '0021_teamless_invitations',
    apply: allowTeamlessInvitations,
  },
  {
    version: '0022_workflow_approval_provider_events',
    apply: applyWorkflowApprovalProviderEventsSchema,
  },
  {
    version: '0023_workflow_approval_medium_account_channel_identity_index',
    apply: applyWorkflowApprovalMediumAccountChannelIdentityIndex,
  },
  {
    version: '0024_disable_legacy_null_channel_medium_accounts',
    apply: disableLegacyNullChannelMediumAccounts,
  },
  {
    version: '0025_workflow_run_completed_notifications',
    apply: applyWorkflowRunCompletedNotificationTrigger,
  },
  {
    version: '0026_workflow_runs_recipe_created_started_index',
    apply: applyWorkflowRunRecipeCreatedStartedIndex,
  },
  {
    version: '0027_control_admin_email_and_invitations',
    apply: applyControlAdminEmailAndInvitationsSchema,
  },
  {
    version: '0028_control_admin_email_change_requests',
    apply: applyControlAdminEmailChangeRequestsSchema,
  },
  {
    version: '0029_control_admin_deletion_audit',
    apply: applyControlAdminDeletionAuditSchema,
  },
  {
    version: '0030_control_admin_password_reset_requests',
    apply: applyControlAdminPasswordResetRequestsSchema,
  },
  {
    version: '0031_control_admin_session_version',
    apply: applyControlAdminSessionVersionSchema,
  },
  {
    version: '0032_user_delete_audit_set_null',
    apply: applyUserDeleteAuditSetNullSchema,
  },
  {
    version: '0033_remove_team_owner_role',
    apply: removeTeamOwnerRole,
  },
  {
    version: '0034_plugin_workload_sdk',
    apply: applyPluginWorkloadSdkSchema,
  },
  {
    version: '0035_plugin_workload_sdk_drop_super_admin_approved',
    apply: dropPluginWorkloadSdkSuperAdminApprovedColumn,
  },
  {
    version: '0036_user_notification_preferences_preferred_account',
    apply: applyUserNotificationPreferencesPreferredAccount,
  },
  {
    version: '0037_invitation_teams_and_purpose',
    apply: applyInvitationTeamsAndPurposeSchema,
  },
  {
    version: '0038_notification_deliveries_delivered_medium',
    apply: applyNotificationDeliveriesDeliveredMedium,
  },
  {
    version: '0039_wama_communication_channel_ref',
    apply: applyWorkflowApprovalMediumChannelRef,
  },
  {
    version: '0040_admin_desktop_access_invitation_purpose',
    apply: applyAdminDesktopAccessInvitationPurpose,
  },
  {
    version: '0041_control_admin_invitation_opened_status',
    apply: applyControlAdminInvitationOpenedStatus,
  },
  {
    version: '0042_oauth_grant_background_flag',
    apply: async db => {
      // Per-user background OAuth: a user grant the user has explicitly
      // consented to have a background workload use on their behalf. Defaults
      // false so no existing grant silently gains background access.
      await db.query(`
        ALTER TABLE oauth_grants
          ADD COLUMN IF NOT EXISTS background boolean NOT NULL DEFAULT false;

        CREATE INDEX IF NOT EXISTS oauth_grants_user_background_idx
          ON oauth_grants (recipe_namespace, recipe_name, oauth_client_id)
          WHERE grant_kind = 'user' AND background = true;
      `)
    },
  },
  {
    version: '0043_usage_cache_tokens',
    apply: async db => {
      // mcp-host already emits cache_read_tokens/cache_write_tokens on every
      // LlmUsageEvent, but the ingest dropped them and the DDL never stored
      // them. Add the columns across the whole usage pipeline so cache token
      // counts are persisted (precondition for exact LLM cost pricing).
      //
      // usage_events mirrors input_tokens/output_tokens (INT); the rollup
      // tables use BIGINT for the same counters because they SUM upward.
      await db.query(`
        ALTER TABLE usage_events
          ADD COLUMN IF NOT EXISTS cache_read_tokens  INT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_write_tokens INT NOT NULL DEFAULT 0;

        ALTER TABLE usage_5min
          ADD COLUMN IF NOT EXISTS cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT NOT NULL DEFAULT 0;

        ALTER TABLE usage_hourly
          ADD COLUMN IF NOT EXISTS cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT NOT NULL DEFAULT 0;

        ALTER TABLE usage_daily
          ADD COLUMN IF NOT EXISTS cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT NOT NULL DEFAULT 0;
      `)
    },
  },
  {
    version: '0044_llm_model_prices',
    apply: async db => {
      // Per-model LLM pricing — the cost basis for token budgets (unit='cost').
      // Prices are expressed per 1,000,000 tokens, stored as NUMERIC for
      // monetary precision. A budget's spend JOINs the rollups to the active
      // (enabled) row for each (provider, model); models without an active row
      // contribute $0 and are surfaced as "unpriced" for the admin to fill in.
      //
      // v1 = current price only: one enabled row per (provider, model),
      // enforced by the partial unique index. `effective_from` is reserved so a
      // future change can historize prices without migrating data.
      await db.query(`
        CREATE TABLE IF NOT EXISTS llm_model_prices (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_token_price NUMERIC(20,8) NOT NULL CHECK (input_token_price >= 0),
          output_token_price NUMERIC(20,8) NOT NULL CHECK (output_token_price >= 0),
          cache_read_token_price NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (cache_read_token_price >= 0),
          cache_write_token_price NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (cache_write_token_price >= 0),
          currency TEXT NOT NULL DEFAULT 'USD',
          effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_model_prices_active
          ON llm_model_prices (provider, model) WHERE enabled;
      `)

      // Seed convenience prices (USD per 1,000,000 tokens) for the providers/
      // models the repo ships with by default, plus a couple of well-known
      // public models, so cost-unit budgets have example rows to work with out
      // of the box. ON CONFLICT DO NOTHING keeps this idempotent and never
      // clobbers an admin-edited price on re-run.
      //
      // !!! APPROXIMATE — ADMIN MUST REVIEW. These are plausible public-list
      // figures, not contractually exact. Some default model ids (e.g.
      // gpt-5.4-mini, glm-5.1, qwen3-coder-plus) have no published price yet;
      // values below are best-effort placeholders. Anthropic cache pricing is
      // modeled as ~0.1x input (cache read) and ~1.25x input (cache write).
      await db.query(`
        INSERT INTO llm_model_prices
          (provider, model, input_token_price, output_token_price, cache_read_token_price, cache_write_token_price)
        VALUES
          -- openai (default model gpt-5.4-mini is unreleased → placeholder)
          ('openai', 'gpt-5.4-mini', 0.15, 0.60, 0.075, 0.15),
          ('openai', 'gpt-4o', 2.50, 10.00, 1.25, 0),
          ('openai', 'gpt-4o-mini', 0.15, 0.60, 0.075, 0),
          -- claude (default model claude-sonnet-4-6 is forward-named → placeholder)
          ('claude', 'claude-sonnet-4-6', 3.00, 15.00, 0.30, 3.75),
          ('claude', 'claude-3-5-sonnet', 3.00, 15.00, 0.30, 3.75),
          ('claude', 'claude-3-5-haiku', 0.80, 4.00, 0.08, 1.00),
          -- zai / z.ai (glm-5.1 unreleased → placeholder)
          ('zai', 'glm-5.1', 0.60, 2.20, 0.11, 0),
          -- bailian / Alibaba Model Studio (qwen3-coder-plus → placeholder)
          ('bailian', 'qwen3-coder-plus', 1.00, 5.00, 0.20, 0)
        ON CONFLICT DO NOTHING;
      `)
    },
  },
  {
    version: '0045_token_budgets',
    apply: async db => {
      // Token budgets — policy definitions that cap LLM consumption per
      // dimension (global, team, user, model, provider, llm secret, host,
      // source_kind, recipe, cron). Spend is computed on-demand from the
      // pre-aggregated usage rollups (no materialized counter), expressed in
      // the budget's `unit`: 'cost' (currency, JOINed to llm_model_prices) or
      // 'tokens' (raw count, no JOIN).
      //
      // `scope` is JSONB mirroring usageReader's UsageFilters shape
      // (Partial<Record<dimension, string[]>>) — keys AND, values within a key
      // OR; {} = global. The route validates the shape with zod (keys ∈ a fixed
      // dimension allowlist, values string[]) so arbitrary keys never reach SQL.
      //
      // P0c ships these in observation mode (enforcement default 'block' but no
      // runtime enforcement yet); the list view surfaces spent/remaining.
      // `max_task_amount` (not max_session_amount, §0.7) caps a single task's
      // delta, reserved for the P2 per-task brake.
      await db.query(`
        CREATE TABLE IF NOT EXISTS token_budgets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          scope JSONB NOT NULL DEFAULT '{}'::jsonb,
          unit TEXT NOT NULL DEFAULT 'cost' CHECK (unit IN ('cost','tokens')),
          currency TEXT,
          limit_amount NUMERIC(20,4) NOT NULL CHECK (limit_amount > 0),
          period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly')),
          timezone TEXT NOT NULL DEFAULT 'UTC',
          min_start_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (min_start_amount >= 0),
          max_task_amount NUMERIC(20,4) CHECK (max_task_amount IS NULL OR max_task_amount > 0),
          enforcement TEXT NOT NULL DEFAULT 'block' CHECK (enforcement IN ('block','warn')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (unit <> 'cost' OR currency IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_token_budgets_enabled ON token_budgets (enabled) WHERE enabled;
      `)
    },
  },
  {
    version: '0046_budget_pending_reservations',
    apply: async db => {
      // Ephemeral anti-race reservations for the danger-zone TOCTOU guard
      // (.specs/feat-token-budgets §2.3, §5.4). NOT a historical accumulator
      // (rollups still own real spend, §3.2): a row records only the ESTIMATED
      // spend of a task that already passed the check but hasn't landed in the
      // rollups yet. Rows self-expire via `expires_at` — a crashed task that
      // never releases its reservation stops counting once the TTL elapses
      // (keeps §0.2 fail-open: a stuck reservation never blocks forever).
      //
      // `est_amount` = the budget's `max_task_amount` (the real per-task cap,
      // §0.7). `task_ref` lets mcp-host release early on task completion instead
      // of waiting for the TTL. ON DELETE CASCADE drops a budget's reservations
      // when the budget is deleted.
      //
      // INDEX NOTE: the spec's partial index `... WHERE expires_at > NOW()` is
      // NOT creatable — `now()` is STABLE, and Postgres requires index-predicate
      // functions to be IMMUTABLE ("functions in index predicate must be marked
      // IMMUTABLE"). We therefore use a plain composite index on
      // (budget_id, expires_at) and keep the `expires_at > NOW()` filter in every
      // query (pending-sum and sweep). The index still serves those range scans.
      await db.query(`
        CREATE TABLE IF NOT EXISTS budget_pending_reservations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          budget_id UUID NOT NULL REFERENCES token_budgets(id) ON DELETE CASCADE,
          est_amount NUMERIC(20,4) NOT NULL CHECK (est_amount > 0),
          task_ref TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_budget_pending_active
          ON budget_pending_reservations (budget_id, expires_at);
        CREATE INDEX IF NOT EXISTS idx_budget_pending_task_ref
          ON budget_pending_reservations (task_ref);
      `)
    },
  },
  {
    version: '0047_budget_pending_reservations_host_ref',
    apply: async db => {
      // Scope a reservation to the caller's host so /internal/budgets/release
      // can only free reservations that belong to the SAME host that created
      // them (.specs/feat-token-budgets §5.4). Without this, any valid mcp-host
      // token could release another host's reservation and re-open the (already
      // TTL-bounded) danger-zone race window (griefing).
      //
      // NULLABLE: reservations are ephemeral and self-expire via `expires_at`,
      // so rows written before this migration simply carry host_ref = NULL and
      // are cleaned up by the TTL sweep — no backfill needed. New reservations
      // always populate host_ref (reserveInDangerZone requires it).
      //
      // No index: the release DELETE is keyed by the PK `id` or by `task_ref`
      // (both already indexed) with host_ref only as an additional AND filter,
      // so an extra index on host_ref would not change the plan.
      await db.query(`
        ALTER TABLE budget_pending_reservations
          ADD COLUMN IF NOT EXISTS host_ref TEXT;
      `)
    },
  },
  {
    version: '0048_gfs_permission_store',
    apply: applyGfsPermissionStoreSchema,
  },
]

async function consolidateWorkflowAllowedUsersToTriggers(db: DbClient): Promise<void> {
  // `workflow_recipe_allowed_users` and `user_workflow_triggers` had identical
  // shape but different writers and readers — the new grants API wrote to
  // `user_workflow_triggers` while sandbox-ui discovery still read from
  // `workflow_recipe_allowed_users`, so newly-granted users never appeared in
  // the desktop app. Backfill the legacy rows into the canonical table, then
  // drop the legacy one.
  //
  // Idempotent against schema paths that never created the legacy table
  // (renumbered migration; the dev branch's schema evolution can land first):
  // the backfill no-ops when `workflow_recipe_allowed_users` is absent, and the
  // sentinel re-seed only runs when `users.role` exists.
  const legacyTable = await db.query(
    `SELECT to_regclass('public.workflow_recipe_allowed_users')::text AS regclass`
  )
  const legacyRow = legacyTable.rows[0] as { regclass: string | null } | undefined
  const legacyExists = Boolean(legacyRow?.regclass)
  if (legacyExists) {
    // `workflow_recipe_allowed_users` had no FK to `users`; `user_workflow_triggers`
    // does (ON DELETE CASCADE). Drop orphan rows — the referenced user is gone, so
    // the grant is unusable anyway.
    await db.query(`
      INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name, created_at)
      SELECT wrau.user_id, wrau.recipe_namespace, wrau.recipe_name, wrau.created_at
        FROM workflow_recipe_allowed_users wrau
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = wrau.user_id)
      ON CONFLICT DO NOTHING;
    `)
  }
  const usersRoleColumn = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role'
     ) AS exists`
  )
  const roleRow = usersRoleColumn.rows[0] as { exists: boolean } | undefined
  if (roleRow?.exists) {
    // Re-seed the sentinel binding (admins → mcp-host/standalone) into the
    // canonical table. Migration 0006 seeded it into the legacy table; this is
    // idempotent against admins that joined since 0006 ran.
    await db.query(`
      INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
      SELECT id, 'mcp-host', 'standalone' FROM users WHERE role = 'admin'
      ON CONFLICT DO NOTHING;
    `)
  }
  await db.query(`DROP TABLE IF EXISTS workflow_recipe_allowed_users;`)
}

async function applyOAuthGrantsTable(db: DbClient): Promise<void> {
  // Storage for sandbox-ui OAuth grants (Decision 20). Tokens are encrypted
  // at rest with the AES-256-GCM key from CONTROL_API_OAUTH_ENCRYPTION_KEY.
  // The unique constraint enforces one grant per (recipe, user, client) tuple
  // — re-consenting replaces the previous tokens.
  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_grants (
      id BIGSERIAL PRIMARY KEY,
      recipe_namespace TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      oauth_client_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      access_token_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT oauth_grants_unique
        UNIQUE (recipe_namespace, recipe_name, user_id, oauth_client_id)
    );
    CREATE INDEX IF NOT EXISTS oauth_grants_user_idx
      ON oauth_grants (user_id, recipe_namespace, recipe_name);
  `)
}

async function applyOAuthServiceGrants(db: DbClient): Promise<void> {
  // Path B — recipe-scoped (service) OAuth grants for background workloads.
  // A `service` grant is owned by the recipe, not a user: user_id is NULL and
  // grant_kind = 'service'. The existing `oauth_grants_unique` constraint keeps
  // governing `user` grants (non-null user_id); service grants get their own
  // partial unique index since NULL user_ids are distinct under that constraint.
  await db.query(`
    ALTER TABLE oauth_grants
      ADD COLUMN IF NOT EXISTS grant_kind TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE oauth_grants
      ALTER COLUMN user_id DROP NOT NULL;
    DO $$ BEGIN
      ALTER TABLE oauth_grants
        ADD CONSTRAINT oauth_grants_kind_userid_check
        CHECK ((grant_kind = 'user' AND user_id IS NOT NULL)
            OR (grant_kind = 'service' AND user_id IS NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_service_unique
      ON oauth_grants (recipe_namespace, recipe_name, oauth_client_id)
      WHERE grant_kind = 'service';
  `)
}

async function ensureSchemaMigrationsTable(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

async function loadAppliedMigrationVersions(db: DbClient): Promise<Set<string>> {
  const result = await db.query(`SELECT version FROM schema_migrations`)
  return new Set(result.rows.map(row => String((row as { version: string }).version)))
}

async function recordMigration(db: DbClient, version: string): Promise<void> {
  await db.query(
    `INSERT INTO schema_migrations(version)
     VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [version]
  )
}

async function applyPendingMigrations(db: DbClient): Promise<void> {
  await ensureSchemaMigrationsTable(db)
  const appliedVersions = await loadAppliedMigrationVersions(db)

  for (const migration of CONTROL_API_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue
    await migration.apply(db)
    await recordMigration(db, migration.version)
  }
}

export async function initDb(db: DbConnector = pool): Promise<void> {
  const client = await db.connect()
  let locked = false
  let inTransaction = false

  try {
    await client.query(`SELECT pg_advisory_lock(${INIT_DB_LOCK_KEY_SQL})`)
    locked = true

    await client.query('BEGIN')
    inTransaction = true

    await applyPendingMigrations(client)

    await client.query('COMMIT')
    inTransaction = false
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        console.warn('[ControlAPI] initDb rollback failed:', rollbackError)
      }
    }
    throw error
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(${INIT_DB_LOCK_KEY_SQL})`)
      } catch (unlockError) {
        console.warn('[ControlAPI] initDb advisory unlock failed:', unlockError)
      }
    }
    client.release()
  }
}

export async function withTransaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as PoolClient
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

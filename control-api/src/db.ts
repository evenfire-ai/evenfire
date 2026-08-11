import { Pool, type PoolClient } from 'pg'
import {
  type BoundedPoolBudget,
  type PoolConstructor,
  createBoundedPgPoolForConnection,
} from './boundedPgPool.js'
import { config } from './config.js'
import { applyMemberRegistrationCredentialsSchema } from './services/memberRegistrationCredentialsSchema.js'
import {
  addPluginWorkloadSdkAttemptLedgerColumns,
  addPluginWorkloadSdkCredentialTicketRuntimeAccess,
  addPluginWorkloadSdkJitCredentialTicketColumns,
  addPluginWorkloadSdkNotExecutedSpendOutcome,
  addPluginWorkloadSdkPolicyReviewProvenance,
  addPluginWorkloadSdkPromptTargetPolicyColumns,
  addPluginWorkloadSdkProtocolAndRevocation,
  addPluginWorkloadSdkProviderAttemptLedger,
  addPluginWorkloadSdkProviderColumn,
  addPluginWorkloadSdkRevocationEpoch,
  addPluginWorkloadSdkRuntimeAccess,
  addPluginWorkloadSdkSpendOutcomeLedger,
  addPluginWorkloadSdkUsageSourceKind,
  applyPluginWorkloadSdkSchema,
  dropPluginWorkloadSdkSuperAdminApprovedColumn,
  relaxPluginWorkloadSdkSpendOutcomeHostRef,
  repairPluginWorkloadSdkLegacyGrantPolicies,
} from './services/pluginWorkloadSdkSchema.js'
import { applyRegistryConnectionSchema } from './services/registryConnectionSchema.js'

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
  // Equivalent names used before a branch merge renumbered the same migration body.
  legacyVersions?: readonly string[]
  apply: (db: DbClient) => Promise<void>
}

export type { BoundedPoolBudget, PoolConstructor } from './boundedPgPool.js'

const MIN_POOL_MAX = 1
const MAX_POOL_MAX = 64
const MIN_IDLE_TIMEOUT_MS = 1_000
const MAX_IDLE_TIMEOUT_MS = 120_000
const MIN_CONNECTION_TIMEOUT_MS = 100
const MAX_CONNECTION_TIMEOUT_MS = 30_000
const MIN_STATEMENT_TIMEOUT_MS = 100
const MAX_STATEMENT_TIMEOUT_MS = 30_000

const DEFAULT_CORE_POOL_MAX = 10
const DEFAULT_CORE_POOL_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_CORE_POOL_CONNECTION_TIMEOUT_MS = 2_000
const DEFAULT_CORE_POOL_STATEMENT_TIMEOUT_MS = 15_000

function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function createBoundedPgPool(
  budget: BoundedPoolBudget,
  PoolClass: PoolConstructor = Pool
): Pool {
  return createBoundedPgPoolForConnection(config.pgConnectionString, budget, PoolClass)
}

export function corePoolBudget(): BoundedPoolBudget {
  return {
    max: boundedEnvInteger('CORE_POOL_MAX', DEFAULT_CORE_POOL_MAX, MIN_POOL_MAX, MAX_POOL_MAX),
    idleTimeoutMillis: boundedEnvInteger(
      'CORE_POOL_IDLE_TIMEOUT_MS',
      DEFAULT_CORE_POOL_IDLE_TIMEOUT_MS,
      MIN_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS
    ),
    connectionTimeoutMillis: boundedEnvInteger(
      'CORE_POOL_CONNECTION_TIMEOUT_MS',
      DEFAULT_CORE_POOL_CONNECTION_TIMEOUT_MS,
      MIN_CONNECTION_TIMEOUT_MS,
      MAX_CONNECTION_TIMEOUT_MS
    ),
    statementTimeoutMillis: boundedEnvInteger(
      'CORE_POOL_STATEMENT_TIMEOUT_MS',
      DEFAULT_CORE_POOL_STATEMENT_TIMEOUT_MS,
      MIN_STATEMENT_TIMEOUT_MS,
      MAX_STATEMENT_TIMEOUT_MS
    ),
  }
}

export function createCorePool(PoolClass: PoolConstructor = Pool): Pool {
  return createBoundedPgPool(corePoolBudget(), PoolClass)
}

export const pool = createCorePool()
export const corePool = pool

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
    CREATE OR REPLACE FUNCTION public.workflow_run_step_output_jsonb(raw_value TEXT) RETURNS JSONB AS $$
    BEGIN
      IF raw_value IS NULL OR btrim(raw_value) = '' THEN
        RETURN NULL;
      END IF;

      RETURN raw_value::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;

    CREATE OR REPLACE FUNCTION public.notify_workflow_run_update() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
         AND OLD.phase IS DISTINCT FROM NEW.phase
         AND NEW.phase IN ('Succeeded', 'Failed', 'Canceled')
         AND NEW.approval_request_id IS NOT NULL THEN
        INSERT INTO public.notification_deliveries
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
            'providerConversationId', war.payload #>> '{metadata,workflowTrigger,conversationId}',
            'providerThreadId', war.payload #>> '{metadata,workflowTrigger,providerBinding,providerThreadId}',
            'hasDownloadableItems', wr_outputs.has_downloadable_items,
            'message', CASE
              WHEN NEW.phase = 'Succeeded' AND wr_outputs.has_downloadable_items
                THEN 'Workflow ' || NEW.recipe_name || ' completed. Results are ready.'
              WHEN NEW.phase = 'Succeeded'
                THEN 'Workflow ' || NEW.recipe_name || ' completed.'
              ELSE 'Workflow ' || NEW.recipe_name || ' finished with status ' || NEW.phase || '.'
            END
          ),
          'normal',
          'queued',
          NOW() + INTERVAL '7 days'
        FROM public.workflow_approval_requests war
        JOIN public.workflow_approval_trigger_intents wati
          ON wati.approval_request_id = war.id
        CROSS JOIN LATERAL (
          SELECT EXISTS (
            SELECT 1
              FROM public.workflow_run_steps wrs
              CROSS JOIN LATERAL (
                SELECT public.workflow_run_step_output_jsonb(wrs.output) AS output_json
              ) wrs_output
             WHERE wrs.run_id = NEW.run_id
               AND (
                 NULLIF(wrs_output.output_json #>> '{artifact,name}', '') IS NOT NULL
                 OR CASE
                      WHEN jsonb_typeof(wrs_output.output_json->'artifacts') = 'array'
                        THEN jsonb_array_length(wrs_output.output_json->'artifacts') > 0
                      ELSE false
                    END
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(
                       CASE
                         WHEN jsonb_typeof(wrs.tools_called) = 'array' THEN wrs.tools_called
                         ELSE '[]'::jsonb
                       END
                     ) AS tool_call
                     CROSS JOIN LATERAL (
                       SELECT CASE
                         WHEN jsonb_typeof(tool_call->'result') = 'object'
                           THEN tool_call->'result'
                         WHEN jsonb_typeof(tool_call->'result') = 'string'
                           THEN public.workflow_run_step_output_jsonb(tool_call->>'result')
                         ELSE NULL
                       END AS result_json
                     ) tool_result
                    WHERE tool_result.result_json->>'success' = 'true'
                      AND NULLIF(tool_result.result_json #>> '{artifact,name}', '') IS NOT NULL
                 )
               )
          ) AS has_downloadable_items
        ) wr_outputs
        WHERE war.id = NEW.approval_request_id
          AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' IN ('telegram', 'slack', 'teams')
          AND NULLIF(war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}', '') IS NOT NULL
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;

      PERFORM pg_notify('workflow_run_update', NEW.run_id::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
       SECURITY DEFINER
       SET search_path = pg_catalog;

    REVOKE ALL ON FUNCTION public.workflow_run_step_output_jsonb(TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.notify_workflow_run_update() FROM PUBLIC;

    DROP TRIGGER IF EXISTS workflow_runs_notify ON public.workflow_runs;
    CREATE TRIGGER workflow_runs_notify
      AFTER INSERT OR UPDATE OF phase ON public.workflow_runs
      FOR EACH ROW EXECUTE FUNCTION public.notify_workflow_run_update();
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
      display_name TEXT NULL,
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
      reply_in_threads BOOLEAN NULL,
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
 * E2E running against example-dev on 2026-04-24.
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
      CREATE TYPE usage_source_kind AS ENUM ('channel','desktop','workflow','cron','unknown','plugin_workload_sdk');
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
    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS prompt_bridge_metadata JSONB;
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

/** Adds bounded promptBridge target attribution to the raw usage ledger. */
async function addPromptBridgeUsageMetadataColumn(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS prompt_bridge_metadata JSONB;
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
  // schema, so clusters that ran 0001 before that table existed (e.g. example-dev)
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
  // append-only hash-chained audit log. File bytes use opaque internal
  // resource-generation keys in the gfsc-mounted volume; the human path is
  // metadata here (path_cache), never mirrored on disk. There is deliberately
  // NO tenant_id column —
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

/**
 * Reconcile all Plugin Workload SDK contracts that were edited in-place after
 * their migrations had already run on long-lived databases. This is one
 * forward-only migration on purpose: the migration runner never replays a
 * recorded version, so the repair must be an explicit new step rather than a
 * re-run of an historical migration.
 */
async function reconcilePluginWorkloadSdkRuntimeContracts(db: DbClient): Promise<void> {
  await db.query(`
    -- Bound the wait for the table locks so a stuck concurrent writer cannot make
    -- this migration hang indefinitely. EXCLUSIVE conflicts with the ROW EXCLUSIVE
    -- that ordinary INSERT/UPDATE/DELETE take (e.g. the trace-retention prune's
    -- DELETE FROM agent_run_events), so if such a writer holds its lock past this
    -- timeout the LOCK/DDL below fails loudly (exit 1) rather than stalling. 60s
    -- sits well above the bounded prune wake-transaction and well below the deploy's
    -- 300s kubectl-wait budget, so a transient writer is tolerated but a genuinely
    -- stuck one surfaces fast. The migration Job sets backoffLimit 2 with
    -- restartPolicy Never (deploy script, same PR), so a transient lock_timeout
    -- abort re-runs on a fresh pod -- up to 3 attempts -- instead of failing the
    -- deploy outright; the body is idempotent, so a retry is safe.
    SET LOCAL lock_timeout = '60s';

    -- Runtime writers do not take the initDb advisory lock. Hold the table locks
    -- in the same logical order as finalization (invocation -> receipt ->
    -- provider attempt) before replacing validators or fencing rows.
    -- EXCLUSIVE MODE (not SHARE ROW EXCLUSIVE) conflicts with the ROW SHARE that
    -- finalization's SELECT ... FOR UPDATE takes, so a concurrent finalization
    -- cannot hold row locks and deadlock against the ACCESS EXCLUSIVE that the
    -- ALTERs below acquire; plain readers (ACCESS SHARE) are still allowed. This
    -- closes the rolling-deploy race in which a writer could change a row between
    -- the ambiguity check and the repair UPDATE.
    LOCK TABLE
      plugin_workload_sdk_invocations,
      plugin_workload_sdk_invocation_attempts,
      plugin_workload_sdk_provider_attempts,
      agent_run_events
      IN EXCLUSIVE MODE;

    CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata(event_kind TEXT, value JSONB)
    RETURNS BOOLEAN
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT COALESCE(CASE
        WHEN event_kind IS NULL THEN FALSE
        WHEN event_kind <> 'token_usage' THEN governed_trace_safe_metadata(value)
        ELSE jsonb_typeof(value) = 'object'
         AND octet_length(value::text) <= 16384
         AND value ?& ARRAY[
           'request_ref', 'provider', 'model', 'source_kind',
           'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
           'cache_tokens_reported'
         ]
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_object_keys(value) AS key_name
            WHERE key_name NOT IN (
              'request_ref', 'provider', 'model', 'source_kind',
              'input_tokens', 'output_tokens', 'cache_read_tokens',
              'cache_write_tokens', 'cache_tokens_reported', 'iteration', 'prompt_bridge'
            )
         )
         AND jsonb_typeof(value->'request_ref') = 'string'
         AND (value->>'request_ref') ~ '^[0-9a-f]{64}$'
         AND jsonb_typeof(value->'provider') = 'string'
         AND jsonb_typeof(value->'model') = 'string'
         AND jsonb_typeof(value->'source_kind') = 'string'
         AND value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown', 'plugin_workload_sdk')
         AND jsonb_typeof(value->'input_tokens') = 'number'
         AND (value->>'input_tokens') ~ '^(0|[1-9][0-9]*)$'
         AND jsonb_typeof(value->'output_tokens') = 'number'
         AND (value->>'output_tokens') ~ '^(0|[1-9][0-9]*)$'
         AND jsonb_typeof(value->'cache_read_tokens') = 'number'
         AND (value->>'cache_read_tokens') ~ '^(0|[1-9][0-9]*)$'
         AND jsonb_typeof(value->'cache_write_tokens') = 'number'
         AND (value->>'cache_write_tokens') ~ '^(0|[1-9][0-9]*)$'
         AND jsonb_typeof(value->'cache_tokens_reported') = 'boolean'
         AND (
           NOT (value ? 'iteration')
           OR (
             jsonb_typeof(value->'iteration') = 'number'
             AND (value->>'iteration') ~ '^(0|[1-9][0-9]*)$'
           )
         )
         AND (
           NOT (value ? 'prompt_bridge')
           OR (
             jsonb_typeof(value->'prompt_bridge') = 'object'
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value->'prompt_bridge') AS key_name
                WHERE key_name NOT IN (
                  'invocation_id', 'attempt_generation', 'target_ref',
                  'fallback_used', 'attempt_count', 'provider_attempt_id',
                  'provider_attempt_index'
                )
             )
             AND value->'prompt_bridge' ?& ARRAY[
               'invocation_id', 'attempt_generation', 'target_ref',
               'fallback_used', 'attempt_count', 'provider_attempt_id',
               'provider_attempt_index'
             ]
             AND jsonb_typeof(value->'prompt_bridge'->'invocation_id') = 'string'
             AND jsonb_typeof(value->'prompt_bridge'->'provider_attempt_id') = 'string'
             AND jsonb_typeof(value->'prompt_bridge'->'attempt_generation') = 'number'
             AND jsonb_typeof(value->'prompt_bridge'->'provider_attempt_index') = 'number'
             AND (value->'prompt_bridge'->>'invocation_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND (value->'prompt_bridge'->>'provider_attempt_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND (value->'prompt_bridge'->>'attempt_generation') ~ '^[1-9][0-9]*$'
             AND (value->'prompt_bridge'->>'provider_attempt_index') ~ '^[1-4]$'
             AND jsonb_typeof(value->'prompt_bridge'->'target_ref') = 'string'
             AND char_length(value->'prompt_bridge'->>'target_ref') BETWEEN 1 AND 256
             AND jsonb_typeof(value->'prompt_bridge'->'fallback_used') = 'boolean'
             AND jsonb_typeof(value->'prompt_bridge'->'attempt_count') = 'number'
             AND (value->'prompt_bridge'->>'attempt_count') ~ '^[1-4]$'
           )
         )
      END, FALSE);
    $$;

    ALTER FUNCTION governed_trace_safe_metadata(JSONB)
      SET search_path = pg_catalog, public;
    ALTER FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
      SET search_path = pg_catalog, public;

    REVOKE ALL ON FUNCTION governed_trace_safe_metadata(JSONB)
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
    REVOKE ALL ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT EXECUTE ON FUNCTION governed_trace_safe_metadata(JSONB)
      TO control_api_runtime, trace_maintenance_runtime;
    GRANT EXECUTE ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
      TO control_api_runtime;

    -- Changing a function body does not recheck rows already accepted by a
    -- CHECK that calls it, so scan every historical row fail-closed. Run the scan
    -- FIRST, while only the EXCLUSIVE table lock is held (plain readers still
    -- allowed), before the DROP/ADD CONSTRAINT below take ACCESS EXCLUSIVE -- this
    -- keeps the expensive full scan out of the reader-blocking window. On failure
    -- the message carries a bounded sample of offending (id:event_type) rows so an
    -- operator can triage from the log. No row is rewritten or deleted: an invalid
    -- append-only history aborts the whole migration and requires an explicit
    -- data-governance decision.
    DO $$
    DECLARE
      invalid_count BIGINT := 0;
      invalid_sample TEXT := '';
      offending RECORD;
    BEGIN
      FOR offending IN
        SELECT COUNT(*) OVER () AS total, event_id, event_type
          FROM agent_run_events
         WHERE governed_trace_safe_agent_run_metadata(event_type, payload_metadata)
               IS DISTINCT FROM TRUE
         ORDER BY occurred_at
         LIMIT 10
      LOOP
        invalid_count := offending.total;
        invalid_sample := invalid_sample
          || CASE WHEN invalid_sample = '' THEN '' ELSE ', ' END
          || offending.event_id::text || ':' || offending.event_type;
      END LOOP;
      IF invalid_count > 0 THEN
        RAISE EXCEPTION
          'cannot reconcile % historical agent_run_events rows with invalid payload metadata (first % shown): %',
          invalid_count, LEAST(invalid_count, 10), invalid_sample;
      END IF;
    END
    $$;

    -- History is clean: the fail-closed scan above ran under the EXCLUSIVE table
    -- lock (plain readers proceed) and already proved every row passes, emitting a
    -- triage sample on failure. Reinstall the named constraint with a single
    -- validating ADD CONSTRAINT: it takes ACCESS EXCLUSIVE and scans once. A
    -- NOT VALID + separate VALIDATE would buy nothing here -- applyPendingMigrations
    -- holds this transaction open until COMMIT, so the ADD's ACCESS EXCLUSIVE (and
    -- the reader blocking it implies) is held through any later VALIDATE anyway; the
    -- split would just scan the table a second time under the same lock profile.
    ALTER TABLE agent_run_events
      DROP CONSTRAINT IF EXISTS agent_run_events_check;
    ALTER TABLE agent_run_events
      DROP CONSTRAINT IF EXISTS agent_run_events_payload_metadata_check;
    ALTER TABLE agent_run_events
      ADD CONSTRAINT agent_run_events_check
      CHECK (governed_trace_safe_agent_run_metadata(event_type, payload_metadata) IS TRUE);

    ALTER TABLE plugin_workload_sdk_invocations
      ALTER COLUMN contract_version SET DEFAULT 1;

    DO $$
    DECLARE ambiguous_count BIGINT;
    BEGIN
      SELECT COUNT(*)
        INTO ambiguous_count
        FROM plugin_workload_sdk_invocations invocations
       WHERE invocations.contract_version = 2
         AND invocations.status = 'in_progress'
         AND invocations.lease_expires_at IS NULL
         AND EXISTS (
           SELECT 1
             FROM plugin_workload_sdk_provider_attempts attempts
            WHERE attempts.invocation_id = invocations.id
              AND attempts.attempt_generation = invocations.attempt_generation
              AND attempts.status IN ('in_progress', 'complete')
         );
      IF ambiguous_count > 0 THEN
        RAISE EXCEPTION
          'cannot reconcile % v2 invocations without leases with a physical provider attempt',
          ambiguous_count;
      END IF;
    END
    $$;

    CREATE TEMP TABLE plugin_workload_sdk_runtime_reconciled_invocations (
      invocation_id UUID PRIMARY KEY,
      attempt_generation INTEGER NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO plugin_workload_sdk_runtime_reconciled_invocations (invocation_id, attempt_generation)
    SELECT id, attempt_generation
      FROM plugin_workload_sdk_invocations
     WHERE contract_version = 2
       AND status = 'in_progress'
       AND lease_expires_at IS NULL;

    DO $$
    DECLARE expected_count BIGINT;
    DECLARE fenced_count BIGINT;
    BEGIN
      SELECT COUNT(*)
        INTO expected_count
        FROM plugin_workload_sdk_runtime_reconciled_invocations;

      UPDATE plugin_workload_sdk_invocations invocations
         SET contract_version = 1,
             status = 'failed',
             authorization_decision = CASE
               WHEN authorization_decision = 'authorized' THEN 'migration_interrupted'
               ELSE authorization_decision
             END,
             updated_at = now(),
             completed_at = COALESCE(completed_at, now()),
             lease_expires_at = NULL
       WHERE invocations.id IN (
         SELECT invocation_id
           FROM plugin_workload_sdk_runtime_reconciled_invocations
       )
         AND invocations.contract_version = 2
         AND invocations.status = 'in_progress'
         AND invocations.lease_expires_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM plugin_workload_sdk_provider_attempts attempts
            WHERE attempts.invocation_id = invocations.id
              AND attempts.attempt_generation = invocations.attempt_generation
              AND attempts.status IN ('in_progress', 'complete')
         );

      GET DIAGNOSTICS fenced_count = ROW_COUNT;
      -- Belt-and-braces: under the EXCLUSIVE lock held above nothing can change the
      -- captured set between the snapshot and this UPDATE, and the ambiguity check
      -- already aborted on any physical attempt, so fenced_count always equals
      -- expected_count. This guard is defence-in-depth and is not expected to fire.
      IF fenced_count <> expected_count THEN
        RAISE EXCEPTION
          'plugin workload SDK invocation state changed during reconciliation (fenced % of % captured); aborting the migration',
          fenced_count, expected_count;
      END IF;
    END
    $$;

    UPDATE plugin_workload_sdk_invocation_attempts attempts
       SET status = 'failed',
           completed_at = COALESCE(attempts.completed_at, now()),
           lease_expires_at = NULL
      FROM plugin_workload_sdk_runtime_reconciled_invocations reconciled
     WHERE attempts.invocation_id = reconciled.invocation_id
       AND attempts.attempt_generation = reconciled.attempt_generation
       AND attempts.status = 'in_progress';

    UPDATE plugin_workload_sdk_provider_attempts attempts
       SET status = 'failed',
           completed_at = COALESCE(attempts.completed_at, now()),
           lease_expires_at = NULL
      FROM plugin_workload_sdk_runtime_reconciled_invocations reconciled
     WHERE attempts.invocation_id = reconciled.invocation_id
       AND attempts.attempt_generation = reconciled.attempt_generation
       AND attempts.status IN ('reserved', 'in_progress');

    ALTER TABLE plugin_workload_sdk_invocations
      DROP CONSTRAINT IF EXISTS plugin_workload_sdk_invocations_v2_lease_check;
    ALTER TABLE plugin_workload_sdk_invocations
      ADD CONSTRAINT plugin_workload_sdk_invocations_v2_lease_check
      CHECK (
        contract_version = 1
        OR status <> 'in_progress'
        OR lease_expires_at IS NOT NULL
      );

    ALTER TABLE plugin_workload_sdk_provider_attempts
      DROP CONSTRAINT IF EXISTS plugin_workload_sdk_provider_attempts_status_check;
    ALTER TABLE plugin_workload_sdk_provider_attempts
      ADD CONSTRAINT plugin_workload_sdk_provider_attempts_status_check
      CHECK (status IN ('reserved','in_progress','complete','failed','provider_unavailable','skipped'));

    -- Reset the statement-scoped lock timeout set at the top of this migration.
    -- applyPendingMigrations runs every pending migration in one transaction, so
    -- without this a later 0091+ applied in the same batch would silently inherit
    -- the 60s timeout. 0090 is currently last (so this is latent today), but keep
    -- the transaction state hygienic for whatever ships next.
    SET LOCAL lock_timeout = '0';
  `)
}

async function applyGfsDesktopOperatorLinksSchema(db: DbClient): Promise<void> {
  await db.query(`
    -- Current-state, one-to-one identity link. Revocation is represented by
    -- deleting this row only after its governed lifecycle event is appended.
    -- Deliberately no email backfill: link creation always requires both exact
    -- server-known UUIDs.
    CREATE TABLE IF NOT EXISTS gfs_desktop_operator_links (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      control_admin_id UUID NOT NULL UNIQUE REFERENCES control_admin_users(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('initial_setup')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    REVOKE ALL ON TABLE gfs_desktop_operator_links FROM PUBLIC;
    GRANT SELECT, INSERT, DELETE ON TABLE gfs_desktop_operator_links TO control_api_runtime;
  `)
}

async function applyGfsAuditActorCorrelationSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE gfs_audit
      ADD COLUMN IF NOT EXISTS desktop_user_id UUID NULL,
      ADD COLUMN IF NOT EXISTS authority_source TEXT NULL;

    DO $$ BEGIN
      ALTER TABLE gfs_audit
        ADD CONSTRAINT gfs_audit_actor_correlation_valid
        CHECK (
          (desktop_user_id IS NULL AND authority_source IS NULL)
          OR
          (desktop_user_id IS NOT NULL
            AND authority_source = 'user-session'
            AND actor_on_behalf_of IS NULL)
          OR
          (desktop_user_id IS NOT NULL
            AND authority_source = 'linked-admin'
            AND actor_on_behalf_of IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS gfs_audit_desktop_user_time_idx
      ON gfs_audit (desktop_user_id, event_time);
  `)
}

/** Preserve operator-link history while making revocation a state transition. */
async function evolveGfsDesktopOperatorLinksToGenerations(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE gfs_desktop_operator_links
      ADD COLUMN IF NOT EXISTS id UUID,
      ADD COLUMN IF NOT EXISTS lineage_id UUID,
      ADD COLUMN IF NOT EXISTS generation INTEGER,
      ADD COLUMN IF NOT EXISTS predecessor_id UUID,
      ADD COLUMN IF NOT EXISTS state TEXT,
      ADD COLUMN IF NOT EXISTS created_by UUID,
      ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS revoked_by_type TEXT,
      ADD COLUMN IF NOT EXISTS revoked_by_id UUID,
      ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
      ADD COLUMN IF NOT EXISTS row_version BIGINT;

    UPDATE gfs_desktop_operator_links
       SET id = COALESCE(id, gen_random_uuid()),
           lineage_id = COALESCE(lineage_id, gen_random_uuid()),
           generation = COALESCE(generation, 1),
           state = COALESCE(state, 'active'),
           created_by = COALESCE(created_by, control_admin_id),
           row_version = COALESCE(row_version, 1)
     WHERE id IS NULL OR lineage_id IS NULL OR generation IS NULL OR state IS NULL
        OR created_by IS NULL OR row_version IS NULL;

    ALTER TABLE gfs_desktop_operator_links
      ALTER COLUMN id SET NOT NULL,
      ALTER COLUMN lineage_id SET NOT NULL,
      ALTER COLUMN generation SET NOT NULL,
      ALTER COLUMN state SET NOT NULL,
      ALTER COLUMN created_by SET NOT NULL,
      ALTER COLUMN row_version SET NOT NULL;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_pkey;
    ALTER TABLE gfs_desktop_operator_links ADD PRIMARY KEY (id);
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_user_id_key;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_control_admin_id_key;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_predecessor_id_fkey;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_predecessor_id_fkey
      FOREIGN KEY (predecessor_id) REFERENCES gfs_desktop_operator_links(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_user_id_fkey;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_control_admin_id_fkey;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_control_admin_id_fkey
      FOREIGN KEY (control_admin_id) REFERENCES control_admin_users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_created_by_fkey;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES control_admin_users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_revoked_by_id_fkey;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_revoked_by_id_fkey
      FOREIGN KEY (revoked_by_id) REFERENCES control_admin_users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_generation_check;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_generation_check CHECK (generation > 0);
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_row_version_check;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_row_version_check CHECK (row_version > 0);
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_state_check;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_state_check CHECK (state IN ('active', 'revoked'));
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_lifecycle_check;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_lifecycle_check CHECK (
      (state = 'active' AND revoked_at IS NULL AND revoked_by_type IS NULL AND revoked_by_id IS NULL AND revocation_reason IS NULL)
      OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_type = 'control_admin' AND revoked_by_id IS NOT NULL AND revocation_reason IS NOT NULL)
    );
    ALTER TABLE gfs_desktop_operator_links DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_predecessor_check;
    ALTER TABLE gfs_desktop_operator_links ADD CONSTRAINT gfs_desktop_operator_links_predecessor_check CHECK (
      (generation = 1 AND predecessor_id IS NULL) OR (generation > 1 AND predecessor_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_desktop_operator_links_lineage_generation_key ON gfs_desktop_operator_links(lineage_id, generation);
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_desktop_operator_links_predecessor_key ON gfs_desktop_operator_links(predecessor_id) WHERE predecessor_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_desktop_operator_links_active_user_key ON gfs_desktop_operator_links(user_id) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS gfs_desktop_operator_links_active_admin_key ON gfs_desktop_operator_links(control_admin_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS gfs_desktop_operator_links_revoked_at_idx
      ON gfs_desktop_operator_links(revoked_at) WHERE state = 'revoked';
    GRANT SELECT, INSERT, UPDATE ON TABLE gfs_desktop_operator_links TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE gfs_desktop_operator_links FROM control_api_runtime;
  `)
}

/**
 * Governed Desktop-user retirement is a state transition, not a destructive
 * shortcut around retained operator-link history.  This remains additive so
 * historical users are explicitly backfilled into the active lifecycle state.
 */
async function applyDesktopUserRetirementLifecycleSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS lifecycle_state TEXT,
      ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS retirement_reason TEXT,
      ADD COLUMN IF NOT EXISTS retired_by_type TEXT,
      ADD COLUMN IF NOT EXISTS retired_by_control_admin_id UUID,
      ADD COLUMN IF NOT EXISTS retired_by_desktop_user_id UUID,
      ADD COLUMN IF NOT EXISTS retirement_request_id TEXT,
      ADD COLUMN IF NOT EXISTS retirement_operation_id UUID,
      ADD COLUMN IF NOT EXISTS lifecycle_version BIGINT;

    -- Fresh and already-existing users are both active until an explicit
    -- governed retirement transition records actor, reason, and outcome.
    UPDATE users
       SET lifecycle_state = COALESCE(lifecycle_state, 'active'),
           lifecycle_version = COALESCE(lifecycle_version, 1)
     WHERE lifecycle_state IS NULL OR lifecycle_version IS NULL;

    ALTER TABLE users
      ALTER COLUMN lifecycle_state SET DEFAULT 'active',
      ALTER COLUMN lifecycle_state SET NOT NULL,
      ALTER COLUMN lifecycle_version SET DEFAULT 1,
      ALTER COLUMN lifecycle_version SET NOT NULL;

    CREATE TABLE IF NOT EXISTS desktop_user_retirement_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operation TEXT NOT NULL DEFAULT 'retire_desktop_user'
        CHECK (operation = 'retire_desktop_user'),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('control_admin', 'platform_user')),
      actor_control_admin_id UUID NULL,
      actor_desktop_user_id UUID NULL,
      target_user_id UUID NOT NULL,
      idempotency_key_hash TEXT NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
      request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 512),
      request_id TEXT NULL CHECK (request_id IS NULL OR char_length(request_id) <= 256),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      outcome TEXT NULL CHECK (outcome IS NULL OR outcome IN ('retired', 'deleted')),
      lifecycle_version BIGINT NULL CHECK (lifecycle_version IS NULL OR lifecycle_version > 0),
      lifecycle_operation_id UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ NULL,
      CHECK (
        (actor_type = 'control_admin'
          AND actor_control_admin_id IS NOT NULL
          AND actor_desktop_user_id IS NULL)
        OR
        (actor_type = 'platform_user'
          AND actor_control_admin_id IS NULL
          AND actor_desktop_user_id IS NOT NULL)
      ),
      CHECK (
        (status = 'pending'
          AND outcome IS NULL
          AND lifecycle_version IS NULL
          AND lifecycle_operation_id IS NULL
          AND completed_at IS NULL)
        OR
        (status = 'completed'
          AND outcome IS NOT NULL
          AND completed_at IS NOT NULL
          AND (
            (outcome = 'retired' AND lifecycle_version IS NOT NULL AND lifecycle_operation_id IS NOT NULL)
            OR
            (outcome = 'deleted' AND lifecycle_version IS NULL AND lifecycle_operation_id IS NULL)
          ))
      )
    );

    -- The target deliberately has no FK: a legacy-compatible hard-delete for
    -- a user with no link history must still leave an idempotent outcome record.
    -- Actor columns remain separate; no caller identity is inferred from UUID shape.
    CREATE UNIQUE INDEX IF NOT EXISTS desktop_user_retirement_operations_control_admin_key
      ON desktop_user_retirement_operations
         (operation, actor_control_admin_id, target_user_id, idempotency_key_hash)
      WHERE actor_type = 'control_admin';
    CREATE UNIQUE INDEX IF NOT EXISTS desktop_user_retirement_operations_platform_user_key
      ON desktop_user_retirement_operations
         (operation, actor_desktop_user_id, target_user_id, idempotency_key_hash)
      WHERE actor_type = 'platform_user';
    CREATE INDEX IF NOT EXISTS desktop_user_retirement_operations_target_idx
      ON desktop_user_retirement_operations (target_user_id, completed_at DESC);

    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_retired_by_control_admin_id_fkey;
    ALTER TABLE users
      ADD CONSTRAINT users_retired_by_control_admin_id_fkey
      FOREIGN KEY (retired_by_control_admin_id)
      REFERENCES control_admin_users(id) ON DELETE RESTRICT;
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_retired_by_desktop_user_id_fkey;
    ALTER TABLE users
      ADD CONSTRAINT users_retired_by_desktop_user_id_fkey
      FOREIGN KEY (retired_by_desktop_user_id)
      REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_retirement_operation_id_fkey;
    ALTER TABLE users
      ADD CONSTRAINT users_retirement_operation_id_fkey
      FOREIGN KEY (retirement_operation_id)
      REFERENCES desktop_user_retirement_operations(id) ON DELETE RESTRICT;
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_lifecycle_version_check;
    ALTER TABLE users
      ADD CONSTRAINT users_lifecycle_version_check CHECK (lifecycle_version > 0);
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_lifecycle_state_check;
    ALTER TABLE users
      ADD CONSTRAINT users_lifecycle_state_check CHECK (
        (lifecycle_state = 'active'
          AND retired_at IS NULL
          AND retirement_reason IS NULL
          AND retired_by_type IS NULL
          AND retired_by_control_admin_id IS NULL
          AND retired_by_desktop_user_id IS NULL
          AND retirement_request_id IS NULL
          AND retirement_operation_id IS NULL)
        OR
        (lifecycle_state = 'retired'
          AND retired_at IS NOT NULL
          AND char_length(retirement_reason) BETWEEN 1 AND 512
          AND retirement_operation_id IS NOT NULL
          AND (
            (retired_by_type = 'control_admin'
              AND retired_by_control_admin_id IS NOT NULL
              AND retired_by_desktop_user_id IS NULL)
            OR
            (retired_by_type = 'platform_user'
              AND retired_by_control_admin_id IS NULL
              AND retired_by_desktop_user_id IS NOT NULL)
          ))
      );
    CREATE INDEX IF NOT EXISTS users_lifecycle_state_idx ON users (lifecycle_state);

    ALTER TABLE gfs_desktop_operator_links
      ADD COLUMN IF NOT EXISTS revoked_by_control_admin_id UUID,
      ADD COLUMN IF NOT EXISTS revoked_by_desktop_user_id UUID;

    -- 0093 could only record a Control Admin in revoked_by_id.  Preserve that
    -- exact historic actor in the typed column before broadening the union.
    UPDATE gfs_desktop_operator_links
       SET revoked_by_control_admin_id = revoked_by_id
     WHERE state = 'revoked'
       AND revoked_by_type = 'control_admin'
       AND revoked_by_control_admin_id IS NULL;

    ALTER TABLE gfs_desktop_operator_links
      DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_revoked_by_control_admin_id_fkey;
    ALTER TABLE gfs_desktop_operator_links
      ADD CONSTRAINT gfs_desktop_operator_links_revoked_by_control_admin_id_fkey
      FOREIGN KEY (revoked_by_control_admin_id)
      REFERENCES control_admin_users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links
      DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_revoked_by_desktop_user_id_fkey;
    ALTER TABLE gfs_desktop_operator_links
      ADD CONSTRAINT gfs_desktop_operator_links_revoked_by_desktop_user_id_fkey
      FOREIGN KEY (revoked_by_desktop_user_id)
      REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE gfs_desktop_operator_links
      DROP CONSTRAINT IF EXISTS gfs_desktop_operator_links_lifecycle_check;
    ALTER TABLE gfs_desktop_operator_links
      ADD CONSTRAINT gfs_desktop_operator_links_lifecycle_check CHECK (
        (state = 'active'
          AND revoked_at IS NULL
          AND revoked_by_type IS NULL
          AND revoked_by_id IS NULL
          AND revoked_by_control_admin_id IS NULL
          AND revoked_by_desktop_user_id IS NULL
          AND revocation_reason IS NULL)
        OR
        (state = 'revoked'
          AND revoked_at IS NOT NULL
          AND revocation_reason IS NOT NULL
          AND (
            (revoked_by_type = 'control_admin'
              AND revoked_by_id IS NOT NULL
              AND revoked_by_control_admin_id = revoked_by_id
              AND revoked_by_desktop_user_id IS NULL)
            OR
            (revoked_by_type = 'platform_user'
              AND revoked_by_id IS NULL
              AND revoked_by_control_admin_id IS NULL
              AND revoked_by_desktop_user_id IS NOT NULL)
          ))
      );

    GRANT SELECT, INSERT, UPDATE ON TABLE desktop_user_retirement_operations TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE desktop_user_retirement_operations FROM control_api_runtime;
  `)
}

// Exported (read-only) so the migration-order invariant test can assert the
// array is monotonic by version-string. Applied strictly in array order and
// tracked by full version-string in `schema_migrations`, so a non-monotonic
// array is a latent footgun — the test guards it going forward.
export const CONTROL_API_MIGRATIONS: DbMigration[] = [
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
  {
    version: '0049_registry_connection',
    apply: applyRegistryConnectionSchema,
  },
  {
    version: '0050_host_wake_generations',
    apply: async db => {
      // Monotonic wake-generation counter for stateless Hosts (Stage 4.1).
      // The counter lives in Postgres — NOT in the Host CR annotation —
      // because the admin facade full-replaces Host metadata and could
      // clobber a read-modify-write on the annotation. The wake endpoint
      // bumps the generation here atomically (INSERT ... ON CONFLICT DO
      // UPDATE ... RETURNING) and only PROJECTS the value onto the
      // `clerum.io/wake-requested` annotation, never reads it back.
      //
      // `last_projected_at` implements server-side coalescence: concurrent
      // wakes for the same host within a short window still increment the
      // generation, but only the caller that moves `last_projected_at`
      // re-projects the annotation (N wakes => 1 annotation patch).
      await db.query(`
        CREATE TABLE IF NOT EXISTS host_wake_generations (
          host_ref TEXT PRIMARY KEY,
          generation BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_projected_at TIMESTAMPTZ
        );
      `)
    },
  },
  {
    version: '0051_host_heartbeats',
    apply: async db => {
      // Stateless heartbeat ingest (JWT-plane realignment): mcp-host pods
      // POST D8 activity snapshots to control-api's /mcp-host facade
      // (identity bound to the runtime token's hostRefs[0] claim, never the
      // path); HCC polls the rows via /api/v1/auth/mcp-host/heartbeats
      // (InternalControl, iss=hcc) and feeds its StatelessLifecycleTracker.
      //
      // One row per host — the latest beat wins. The tracker's idle decision
      // derives from the payload's last_activity_ts, so no row history is
      // needed; `received_at` drives the poller's `since` cursor.
      await db.query(`
        CREATE TABLE IF NOT EXISTS host_heartbeats (
          host_ref TEXT PRIMARY KEY,
          pod_uid TEXT NOT NULL,
          active_work BOOLEAN NOT NULL,
          conditions JSONB NOT NULL,
          last_activity_ts BIGINT NOT NULL,
          state TEXT NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
    },
  },
  {
    version: '0052_workflow_approval_medium_display_name',
    apply: async db => {
      await db.query(`
        ALTER TABLE workflow_approval_medium_accounts
          ADD COLUMN IF NOT EXISTS display_name TEXT NULL;
      `)
    },
  },
  {
    version: '0053_workflow_approval_medium_reply_in_threads',
    apply: async db => {
      await db.query(`
        ALTER TABLE workflow_approval_medium_challenges
          ADD COLUMN IF NOT EXISTS reply_in_threads BOOLEAN NULL;
      `)
    },
  },
  {
    version: '0054_workflow_run_completed_notification_download_detection',
    legacyVersions: ['0059_workflow_run_completed_notification_download_detection'],
    apply: applyWorkflowRunCompletedNotificationTrigger,
  },
  {
    version: '0055_plugin_workload_sdk_grant_provider',
    apply: addPluginWorkloadSdkProviderColumn,
  },
  {
    version: '0056_llm_allowed_models',
    apply: async db => {
      // Operator-declared allowlist of usable (provider, model) pairs
      // (spec v2 §3-R3). Source of truth in control-api; materialized to the
      // `clerum-llm-allowed-models` ConfigMap for mcp-host/WRC. Fail-closed: a
      // model is usable only when a row exists AND enabled = true.
      //
      // `vendor` is metadata with no logic — it identifies the model creator so
      // the UI can group and cross-runtime reports reconcile (e.g. bailian hosts
      // models from Alibaba, MiniMax, Zhipu and Moonshot under one runtime).
      // `context_window_tokens` is operator-declared and optional; the service
      // validates its range. The (provider, model) UNIQUE index (not partial —
      // one row per pair regardless of enabled) surfaces as a 409 on conflict.
      await db.query(`
        CREATE TABLE IF NOT EXISTS llm_allowed_models (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          vendor TEXT,
          display_name TEXT,
          context_window_tokens INTEGER,
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_allowed_models_pm
          ON llm_allowed_models (provider, model);

        CREATE TABLE IF NOT EXISTS llm_allowed_models_audit (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          detail JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)

      // Seed the current static catalog (control-ui/lib/llm.ts LLM_MODELS_BY_
      // PROVIDER, 25 models) so the upgrade is a behavior no-op — the allowlist
      // reintroduces the model gate R1 removed without disrupting deployed
      // Hosts. `vendor` is set per row. ON CONFLICT DO NOTHING keeps this
      // idempotent and never clobbers an admin-edited row on re-run.
      await db.query(`
        INSERT INTO llm_allowed_models (provider, model, vendor)
        VALUES
          -- openai (runtime) → OpenAI (vendor)
          ('openai', 'gpt-5.5', 'OpenAI'),
          ('openai', 'gpt-5.4', 'OpenAI'),
          ('openai', 'gpt-5.4-mini', 'OpenAI'),
          ('openai', 'gpt-5.4-nano', 'OpenAI'),
          ('openai', 'gpt-5.1-codex', 'OpenAI'),
          ('openai', 'gpt-5.1-codex-mini', 'OpenAI'),
          -- claude (runtime) → Anthropic (vendor)
          ('claude', 'claude-opus-4-7', 'Anthropic'),
          ('claude', 'claude-sonnet-4-6', 'Anthropic'),
          ('claude', 'claude-haiku-4-5', 'Anthropic'),
          ('claude', 'claude-opus-4-6', 'Anthropic'),
          ('claude', 'claude-sonnet-4-5', 'Anthropic'),
          -- zai (runtime) → Zhipu (vendor)
          ('zai', 'glm-5.2', 'Zhipu'),
          ('zai', 'glm-5.1', 'Zhipu'),
          ('zai', 'glm-5', 'Zhipu'),
          ('zai', 'glm-5-turbo', 'Zhipu'),
          ('zai', 'glm-4.7', 'Zhipu'),
          -- bailian (runtime) hosts multiple vendors under one platform
          ('bailian', 'qwen3-coder-plus', 'Alibaba'),
          ('bailian', 'qwen3.5-plus', 'Alibaba'),
          ('bailian', 'qwen3-coder-next', 'Alibaba'),
          ('bailian', 'qwen3-max-2026-01-23', 'Alibaba'),
          ('bailian', 'MiniMax-M2.5', 'MiniMax'),
          ('bailian', 'glm-5.1', 'Zhipu'),
          ('bailian', 'glm-5', 'Zhipu'),
          ('bailian', 'glm-4.7', 'Zhipu'),
          ('bailian', 'kimi-k2.5', 'Moonshot')
        ON CONFLICT DO NOTHING;
      `)
    },
  },
  {
    version: '0057_llm_allowed_models_vertex_bedrock',
    apply: async db => {
      // R4: seed a curated allowlist for the two new providers (Google Vertex AI
      // and Amazon Bedrock). enabled=true — a provider without credentials is
      // unusable regardless (the "provider usable" chip is an R4.5 concern), so
      // enabling the rows just makes them selectable once creds are configured.
      // ON CONFLICT DO NOTHING keeps this idempotent and never clobbers an
      // admin-edited row. Bedrock model ids are runtime-specific (distinct from
      // the native `claude` ids); the sonnet id matches registryCore's
      // bedrock defaultModel (B1).
      await db.query(`
        INSERT INTO llm_allowed_models (provider, model, vendor)
        VALUES
          -- vertex (runtime) → Google (vendor)
          ('vertex', 'gemini-2.5-pro', 'Google'),
          ('vertex', 'gemini-2.5-flash', 'Google'),
          -- bedrock (runtime) → Anthropic (vendor); Bedrock model ids
          ('bedrock', 'anthropic.claude-sonnet-4-6-v1:0', 'Anthropic'),
          ('bedrock', 'anthropic.claude-haiku-4-5-v1:0', 'Anthropic')
        ON CONFLICT DO NOTHING;
      `)
    },
  },
  {
    version: '0058_llm_allowed_models_new_providers',
    apply: async db => {
      // Seed one sensible default model per new provider added in the LLM
      // provider expansion (packages/llm-providers now carries 21 ids). Same
      // shape as 0056/0057: enabled=true (a provider without credentials is
      // unusable regardless), a `vendor` label for UI grouping, and ON CONFLICT
      // DO NOTHING to stay idempotent and never clobber an admin-edited row.
      //
      // Model strings that embed `/` (together, fireworks, deepinfra, nebius,
      // novita, openrouter) are plain data — the allowlist keys on
      // (provider, model) and url-encoding is handled via the surrogate id, so
      // the slashes carry no routing meaning here.
      //
      // azure is intentionally NOT seeded: its `model` is an Azure OpenAI
      // deployment name, not a catalog id, so there is no sensible default —
      // the operator registers their own deployment names via /llm-models.
      await db.query(`
        INSERT INTO llm_allowed_models (provider, model, vendor)
        VALUES
          -- openrouter (runtime) is an aggregator; vendor = model creator
          ('openrouter', 'anthropic/claude-sonnet-latest', 'OpenRouter'),
          -- gemini (runtime) → Google (vendor)
          ('gemini', 'gemini-2.5-flash', 'Google'),
          -- deepseek (runtime) → DeepSeek (vendor)
          ('deepseek', 'deepseek-v4-flash', 'DeepSeek'),
          -- groq (runtime) hosts Meta's Llama
          ('groq', 'llama-3.3-70b-versatile', 'Meta'),
          -- together (runtime) hosts Meta's Llama
          ('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Meta'),
          -- fireworks (runtime) hosts Meta's Llama
          ('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Meta'),
          -- mistral (runtime) → Mistral (vendor)
          ('mistral', 'mistral-medium-latest', 'Mistral'),
          -- xai (runtime) → xAI (vendor)
          ('xai', 'grok-4.3', 'xAI'),
          -- cerebras (runtime) hosts OpenAI's gpt-oss
          ('cerebras', 'gpt-oss-120b', 'OpenAI'),
          -- deepinfra (runtime) hosts DeepSeek
          ('deepinfra', 'deepseek-ai/DeepSeek-V3.2', 'DeepSeek'),
          -- perplexity (runtime) → Perplexity (vendor)
          ('perplexity', 'sonar-pro', 'Perplexity'),
          -- moonshot (runtime) → Moonshot (vendor)
          ('moonshot', 'kimi-k2.6', 'Moonshot'),
          -- nebius (runtime) hosts Alibaba's Qwen
          ('nebius', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'Alibaba'),
          -- novita (runtime) hosts DeepSeek
          ('novita', 'deepseek/deepseek-v3.2', 'DeepSeek')
        ON CONFLICT DO NOTHING;
      `)
    },
  },
  {
    version: '0059_llm_allowed_models_catalog_lifecycle',
    apply: async db => {
      // F1 of "unified provider/model management" (spec 09 §2.2 + §8-F1): add the
      // catalog lifecycle columns to `llm_allowed_models`. ADDITIVE, zero behavior
      // change — the foundation for auto-discovery (F2, later), but this ships
      // alone and is reversible.
      //
      //   - `source`        provenance: 'manual' (operator/seed) | 'discovery'
      //                     (auto-discovered, F2). Every EXISTING row is
      //                     operator/seed, so the DEFAULT 'manual' is the intended
      //                     backfill — no separate UPDATE needed.
      //   - `discovered_at` when discovery first inserted the row (NULL for manual).
      //   - `last_seen_at`  when discovery last saw the id live (NULL for manual).
      //   - `stale`         discovery ran and the id has disappeared; never
      //                     auto-disabled (R3.7) — an operator decision flag.
      //
      // ADD COLUMN IF NOT EXISTS keeps this idempotent. The materializer
      // (listEnabledGroupedByProvider → clerum-llm-allowed-models ConfigMap) does
      // NOT select or serialize any of these, so the CM contract stays
      // byte-identical for mcp-host/WRC. The CHECK constrains `source` to the two
      // known provenances.
      await db.query(`
        ALTER TABLE llm_allowed_models
          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
            CHECK (source IN ('manual','discovery'));
        ALTER TABLE llm_allowed_models
          ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
        ALTER TABLE llm_allowed_models
          ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
        ALTER TABLE llm_allowed_models
          ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false;
      `)
    },
  },
  {
    version: '0060_llm_catalog_sync_runs',
    apply: async db => {
      // F2 of "unified provider/model management" (spec 09 §2 + §8-F2): a tiny
      // per-run summary of the models.dev catalog sync so the admin UI can show
      // "last synced" (source + counts). One row per sync; the actual catalog
      // state lives in `llm_allowed_models` (source/stale columns from 0059).
      // ADDITIVE and self-contained — no change to the allowlist contract or the
      // `clerum-llm-allowed-models` ConfigMap. `source` mirrors the client's
      // provenance ('live' fetch of api.json, or the vendored offline snapshot).
      await db.query(`
        CREATE TABLE IF NOT EXISTS llm_catalog_sync_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          source TEXT NOT NULL CHECK (source IN ('live','vendored')),
          added INTEGER NOT NULL DEFAULT 0,
          updated INTEGER NOT NULL DEFAULT 0,
          staled INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_llm_catalog_sync_runs_ran_at
          ON llm_catalog_sync_runs (ran_at DESC);
      `)
    },
  },
  {
    version: '0061_governed_run_trace_schema_foundation',
    legacyVersions: ['0054_governed_run_trace_schema_foundation'],
    apply: async db => {
      // The governed trace is three physical append-only ledgers plus a payload-free
      // stream. Controllers never receive database authority; later services insert a
      // family row and its stream pointer in the same transaction. The deferred
      // constraint triggers below reject either side being committed on its own.
      await db.query(`
        ALTER TABLE usage_events
          ADD COLUMN IF NOT EXISTS run_id UUID NULL;

        CREATE OR REPLACE FUNCTION governed_trace_safe_metadata(value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'reason_code', 'error_class', 'phase', 'state', 'status',
                  'transition', 'resource_class', 'unit', 'provider_ref',
                  'summary', 'detail_ref', 'target_label', 'tool_name', 'tool_kind',
                  'tool_source_ref', 'model', 'attempt', 'count', 'config_hash'
                )
             )
             AND (
               NOT (value ? 'tool_kind')
               OR (
                 jsonb_typeof(value->'tool_kind') = 'string'
                 AND value->>'tool_kind' IN ('internal_tool', 'mcp_server_tool', 'workflow')
               )
             )
             AND (
               NOT (value ? 'target_label')
               OR (
                 jsonb_typeof(value->'target_label') = 'string'
                 AND value->>'target_label' ~ '^[A-Za-z0-9._-]{3,64}$'
               )
             )
             AND (
               NOT (value ? 'tool_source_ref')
               OR (
                 jsonb_typeof(value->'tool_source_ref') = 'string'
                 AND char_length(value->>'tool_source_ref') BETWEEN 1 AND 128
               )
             );
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata(event_kind TEXT, value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT CASE
            WHEN event_kind <> 'token_usage' THEN governed_trace_safe_metadata(value)
            ELSE jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND value ?& ARRAY[
               'request_ref', 'provider', 'model', 'source_kind',
               'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'
             ]
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'request_ref', 'provider', 'model', 'source_kind',
                  'input_tokens', 'output_tokens', 'cache_read_tokens',
                  'cache_write_tokens', 'iteration', 'prompt_bridge'
                )
             )
             AND jsonb_typeof(value->'request_ref') = 'string'
             AND (value->>'request_ref') ~ '^[0-9a-f]{64}$'
             AND jsonb_typeof(value->'provider') = 'string'
             AND jsonb_typeof(value->'model') = 'string'
             AND value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown', 'plugin_workload_sdk')
             AND jsonb_typeof(value->'source_kind') = 'string'
             AND jsonb_typeof(value->'input_tokens') = 'number'
             AND (value->>'input_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'output_tokens') = 'number'
             AND (value->>'output_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_read_tokens') = 'number'
             AND (value->>'cache_read_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_write_tokens') = 'number'
             AND (value->>'cache_write_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND (
               NOT (value ? 'iteration')
               OR (
                 jsonb_typeof(value->'iteration') = 'number'
                 AND (value->>'iteration') ~ '^(0|[1-9][0-9]*)$'
               )
             )
             AND (
               NOT (value ? 'prompt_bridge')
               OR (
                 jsonb_typeof(value->'prompt_bridge') = 'object'
                 AND value->'prompt_bridge' ?& ARRAY[
                   'invocation_id', 'attempt_generation', 'target_ref',
                   'fallback_used', 'attempt_count', 'provider_attempt_id',
                   'provider_attempt_index'
                 ]
                 AND (value->'prompt_bridge'->>'invocation_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'provider_attempt_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'attempt_generation') ~ '^[1-9][0-9]*$'
                 AND (value->'prompt_bridge'->>'provider_attempt_index') ~ '^[1-9][0-9]*$'
                 AND jsonb_typeof(value->'prompt_bridge'->'target_ref') = 'string'
                 AND jsonb_typeof(value->'prompt_bridge'->'fallback_used') = 'boolean'
                 AND jsonb_typeof(value->'prompt_bridge'->'attempt_count') = 'number'
               )
             )
          END;
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_sorted_unique_text_array(value TEXT[])
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT cardinality(value) <= 32
             AND array_position(value, NULL) IS NULL
             AND value = COALESCE(
               (SELECT array_agg(item ORDER BY item)
                  FROM unnest(value) AS item),
               ARRAY[]::TEXT[]
             );
        $$;

        CREATE TABLE IF NOT EXISTS agent_run_events (
          event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('mcp_host_runtime', 'wrc_internal_control', 'control_api_local')),
          source_service TEXT NOT NULL CHECK (char_length(source_service) BETWEEN 1 AND 128),
          source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 256),
          idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
          run_id UUID NOT NULL,
          session_id TEXT NULL CHECK (char_length(session_id) <= 256),
          span_id TEXT NOT NULL CHECK (span_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
          parent_span_id TEXT NULL CHECK (parent_span_id IS NULL OR parent_span_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
          origin TEXT NOT NULL CHECK (origin IN ('direct_chat', 'workflow_runtime', 'channel_event', 'api')),
          event_type TEXT NOT NULL CHECK (event_type IN (
            'run_start', 'run_end', 'llm_call', 'tool_call', 'approval', 'token_usage'
          )),
          outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'cancelled', 'approved', 'denied', 'unknown')),
          identity_issuer TEXT NULL CHECK (identity_issuer IS NULL OR char_length(identity_issuer) <= 512),
          actor_human_sub TEXT NULL CHECK (actor_human_sub IS NULL OR char_length(actor_human_sub) <= 256),
          actor_medium TEXT NULL CHECK (actor_medium IS NULL OR actor_medium IN ('desktop', 'channel', 'api', 'workflow', 'unknown')),
          agent_sub TEXT NOT NULL CHECK (char_length(agent_sub) BETWEEN 1 AND 256),
          resource_aud TEXT NULL CHECK (resource_aud IS NULL OR char_length(resource_aud) <= 512),
          effective_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
            CHECK (governed_trace_sorted_unique_text_array(effective_scopes)),
          decision TEXT NOT NULL DEFAULT 'not_applicable'
            CHECK (decision IN ('allow', 'deny', 'require_approval', 'not_applicable')),
          decision_source_kind TEXT NULL CHECK (decision_source_kind IS NULL OR decision_source_kind IN ('approval_request', 'approval_resolution', 'policy', 'runtime_guard')),
          decision_source_ref TEXT NULL CHECK (decision_source_ref IS NULL OR char_length(decision_source_ref) <= 256),
          decision_actor_sub TEXT NULL CHECK (decision_actor_sub IS NULL OR char_length(decision_actor_sub) <= 256),
          approval_request_id UUID NULL,
          token_exchange_id UUID NULL,
          host_ref TEXT NULL CHECK (host_ref IS NULL OR char_length(host_ref) <= 256),
          recipe_namespace TEXT NULL CHECK (recipe_namespace IS NULL OR char_length(recipe_namespace) <= 253),
          recipe_name TEXT NULL CHECK (recipe_name IS NULL OR char_length(recipe_name) <= 253),
          team_id TEXT NULL CHECK (team_id IS NULL OR char_length(team_id) <= 256),
          user_id TEXT NULL CHECK (user_id IS NULL OR char_length(user_id) <= 256),
          source_adapter_kind TEXT NULL CHECK (source_adapter_kind IS NULL OR char_length(source_adapter_kind) <= 64),
          source_adapter_version TEXT NULL CHECK (source_adapter_version IS NULL OR char_length(source_adapter_version) <= 128),
          runtime_version_ref TEXT NULL CHECK (runtime_version_ref IS NULL OR char_length(runtime_version_ref) <= 256),
          code_digest TEXT NULL CHECK (code_digest IS NULL OR code_digest ~ '^[0-9a-f]{64}$'),
          config_digest TEXT NULL CHECK (config_digest IS NULL OR config_digest ~ '^[0-9a-f]{64}$'),
          policy_digest TEXT NULL CHECK (policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$'),
          model_version_ref TEXT NULL CHECK (model_version_ref IS NULL OR char_length(model_version_ref) <= 256),
          tool_definition_digest TEXT NULL CHECK (tool_definition_digest IS NULL OR tool_definition_digest ~ '^[0-9a-f]{64}$'),
          authorization_ref TEXT NULL CHECK (authorization_ref IS NULL OR char_length(authorization_ref) <= 256),
          effect_ref TEXT NULL CHECK (effect_ref IS NULL OR char_length(effect_ref) <= 256),
          pre_state_digest TEXT NULL CHECK (pre_state_digest IS NULL OR pre_state_digest ~ '^[0-9a-f]{64}$'),
          post_state_digest TEXT NULL CHECK (post_state_digest IS NULL OR post_state_digest ~ '^[0-9a-f]{64}$'),
          payload_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (governed_trace_safe_agent_run_metadata(event_type, payload_metadata)),
          payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
          duration_ms BIGINT NULL CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
          occurred_at TIMESTAMPTZ NOT NULL,
          ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ingest_sequence BIGSERIAL NOT NULL UNIQUE,
          schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
          CHECK (occurred_at <= ingested_at + INTERVAL '5 minutes'),
          CHECK (
            (decision = 'not_applicable' AND decision_source_kind IS NULL AND decision_source_ref IS NULL)
            OR (decision <> 'not_applicable' AND decision_source_kind IS NOT NULL AND decision_source_ref IS NOT NULL)
          ),
          UNIQUE (source_service, source_kind, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS administrative_events (
          event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('control_api_local', 'hcc_internal_control', 'wrc_internal_control')),
          source_service TEXT NOT NULL CHECK (char_length(source_service) BETWEEN 1 AND 128),
          source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 256),
          idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
          event_kind TEXT NOT NULL CHECK (event_kind IN ('intent', 'linked_outcome', 'service_action')),
          action TEXT NOT NULL CHECK (action IN (
            'agent_mutation', 'host_mutation', 'permission_grant', 'permission_revoke',
            'delegated_resource_mutation', 'folder_mutation', 'resource_mutation',
            'configuration_mutation', 'service_maintenance'
          )),
          outcome TEXT NOT NULL CHECK (outcome IN ('attempted', 'committed', 'succeeded', 'failed', 'rejected')),
          operator_sub TEXT NULL CHECK (operator_sub IS NULL OR char_length(operator_sub) <= 256),
          service_sub TEXT NOT NULL CHECK (char_length(service_sub) BETWEEN 1 AND 256),
          target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'host', 'permission', 'delegated_resource', 'folder', 'resource', 'configuration', 'service')),
          target_ref TEXT NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 512),
          operation_id UUID NULL,
          request_id TEXT NULL CHECK (request_id IS NULL OR char_length(request_id) <= 256),
          correlation_id TEXT NULL CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 256),
          related_run_id UUID NULL,
          environment TEXT NULL CHECK (environment IS NULL OR char_length(environment) <= 64),
          namespace TEXT NULL CHECK (namespace IS NULL OR char_length(namespace) <= 253),
          deployment_ref TEXT NULL CHECK (deployment_ref IS NULL OR char_length(deployment_ref) <= 512),
          team_id TEXT NULL CHECK (team_id IS NULL OR char_length(team_id) <= 256),
          source_audit_ref TEXT NULL CHECK (source_audit_ref IS NULL OR char_length(source_audit_ref) <= 256),
          source_adapter_kind TEXT NULL CHECK (source_adapter_kind IS NULL OR char_length(source_adapter_kind) <= 64),
          source_adapter_version TEXT NULL CHECK (source_adapter_version IS NULL OR char_length(source_adapter_version) <= 128),
          code_digest TEXT NULL CHECK (code_digest IS NULL OR code_digest ~ '^[0-9a-f]{64}$'),
          config_digest TEXT NULL CHECK (config_digest IS NULL OR config_digest ~ '^[0-9a-f]{64}$'),
          policy_digest TEXT NULL CHECK (policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$'),
          authorization_ref TEXT NULL CHECK (authorization_ref IS NULL OR char_length(authorization_ref) <= 256),
          effect_ref TEXT NULL CHECK (effect_ref IS NULL OR char_length(effect_ref) <= 256),
          pre_state_digest TEXT NULL CHECK (pre_state_digest IS NULL OR pre_state_digest ~ '^[0-9a-f]{64}$'),
          post_state_digest TEXT NULL CHECK (post_state_digest IS NULL OR post_state_digest ~ '^[0-9a-f]{64}$'),
          payload_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (governed_trace_safe_metadata(payload_metadata)),
          payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
          occurred_at TIMESTAMPTZ NOT NULL,
          ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ingest_sequence BIGSERIAL NOT NULL UNIQUE,
          schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
          CHECK (occurred_at <= ingested_at + INTERVAL '5 minutes'),
          CHECK ((event_kind = 'intent' AND outcome IN ('attempted', 'committed', 'rejected')) OR event_kind <> 'intent'),
          UNIQUE (source_service, source_kind, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS infrastructure_telemetry_events (
          event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          source_service TEXT NOT NULL CHECK (source_service IN ('host-context-controller', 'workflow-recipes', 'control-api')),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('hcc_internal_control', 'wrc_internal_control', 'trace_maintenance')),
          source_occurrence_id TEXT NOT NULL CHECK (char_length(source_occurrence_id) BETWEEN 1 AND 256),
          telemetry_type TEXT NOT NULL CHECK (telemetry_type IN (
            'reconcile_outcome', 'health_transition', 'lifecycle_transition',
            'capacity_sample', 'usage_sample', 'controller_error'
          )),
          trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('administrative_intent', 'runtime_activity', 'controller_reconcile', 'periodic_sample')),
          outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'healthy', 'unhealthy', 'started', 'stopped', 'unknown')),
          reason_code TEXT NULL CHECK (reason_code IS NULL OR char_length(reason_code) <= 128),
          environment TEXT NOT NULL CHECK (char_length(environment) BETWEEN 1 AND 64),
          cluster_name TEXT NOT NULL CHECK (char_length(cluster_name) BETWEEN 1 AND 253),
          namespace TEXT NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 253),
          workload_kind TEXT NOT NULL CHECK (workload_kind IN ('Host', 'McpServer', 'WorkflowRecipe', 'Deployment', 'Service', 'NetworkPolicy')),
          workload_ref TEXT NOT NULL CHECK (char_length(workload_ref) BETWEEN 1 AND 512),
          kubernetes_kind TEXT NOT NULL CHECK (char_length(kubernetes_kind) BETWEEN 1 AND 128),
          kubernetes_name TEXT NOT NULL CHECK (char_length(kubernetes_name) BETWEEN 1 AND 253),
          kubernetes_uid TEXT NULL CHECK (kubernetes_uid IS NULL OR char_length(kubernetes_uid) <= 128),
          metadata_generation BIGINT NULL CHECK (metadata_generation IS NULL OR metadata_generation >= 0),
          interval_start TIMESTAMPTZ NULL,
          interval_end TIMESTAMPTZ NULL,
          desired_replicas INTEGER NULL CHECK (desired_replicas IS NULL OR desired_replicas >= 0),
          observed_replicas INTEGER NULL CHECK (observed_replicas IS NULL OR observed_replicas >= 0),
          ready_replicas INTEGER NULL CHECK (ready_replicas IS NULL OR ready_replicas >= 0),
          cpu_request_cores NUMERIC(20, 6) NULL CHECK (cpu_request_cores IS NULL OR cpu_request_cores >= 0),
          cpu_limit_cores NUMERIC(20, 6) NULL CHECK (cpu_limit_cores IS NULL OR cpu_limit_cores >= 0),
          memory_request_bytes BIGINT NULL CHECK (memory_request_bytes IS NULL OR memory_request_bytes >= 0),
          memory_limit_bytes BIGINT NULL CHECK (memory_limit_bytes IS NULL OR memory_limit_bytes >= 0),
          cpu_usage_core_seconds NUMERIC(24, 9) NULL CHECK (cpu_usage_core_seconds IS NULL OR cpu_usage_core_seconds >= 0),
          memory_usage_byte_seconds NUMERIC(30, 9) NULL CHECK (memory_usage_byte_seconds IS NULL OR memory_usage_byte_seconds >= 0),
          related_operation_id UUID NULL,
          related_run_id UUID NULL,
          source_adapter_kind TEXT NULL CHECK (source_adapter_kind IS NULL OR char_length(source_adapter_kind) <= 64),
          source_adapter_version TEXT NULL CHECK (source_adapter_version IS NULL OR char_length(source_adapter_version) <= 128),
          code_digest TEXT NULL CHECK (code_digest IS NULL OR code_digest ~ '^[0-9a-f]{64}$'),
          config_digest TEXT NULL CHECK (config_digest IS NULL OR config_digest ~ '^[0-9a-f]{64}$'),
          policy_digest TEXT NULL CHECK (policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$'),
          authorization_ref TEXT NULL CHECK (authorization_ref IS NULL OR char_length(authorization_ref) <= 256),
          effect_ref TEXT NULL CHECK (effect_ref IS NULL OR char_length(effect_ref) <= 256),
          pre_state_digest TEXT NULL CHECK (pre_state_digest IS NULL OR pre_state_digest ~ '^[0-9a-f]{64}$'),
          post_state_digest TEXT NULL CHECK (post_state_digest IS NULL OR post_state_digest ~ '^[0-9a-f]{64}$'),
          payload_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (governed_trace_safe_metadata(payload_metadata)),
          payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
          occurred_at TIMESTAMPTZ NOT NULL,
          ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ingest_sequence BIGSERIAL NOT NULL UNIQUE,
          schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
          idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
          CHECK (occurred_at <= ingested_at + INTERVAL '5 minutes'),
          CHECK ((interval_start IS NULL AND interval_end IS NULL) OR (interval_start IS NOT NULL AND interval_end IS NOT NULL AND interval_end > interval_start)),
          CHECK (
            (telemetry_type IN ('capacity_sample', 'usage_sample') AND interval_start IS NOT NULL AND interval_end IS NOT NULL)
            OR (
              telemetry_type NOT IN ('capacity_sample', 'usage_sample')
              AND (metadata_generation IS NOT NULL OR related_run_id IS NOT NULL)
            )
          ),
          UNIQUE (source_service, source_kind, idempotency_key)
        );

        -- WRC owns workflow lifecycle facts. Delivery identity remains source-scoped,
        -- while this separate invariant permits only one effective root and terminal
        -- event for each canonical workflow run.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_wrc_lifecycle_once
          ON agent_run_events (run_id, event_type)
          WHERE source_kind = 'wrc_internal_control'
            AND event_type IN ('run_start', 'run_end');

        CREATE TABLE IF NOT EXISTS governed_event_stream (
          stream_sequence BIGSERIAL PRIMARY KEY,
          event_family TEXT NOT NULL CHECK (event_family IN ('agent_run', 'administrative', 'infrastructure_telemetry')),
          event_id UUID NOT NULL,
          schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
          occurred_at TIMESTAMPTZ NOT NULL,
          ingested_at TIMESTAMPTZ NOT NULL,
          environment TEXT NULL CHECK (environment IS NULL OR char_length(environment) <= 64),
          tenant_id TEXT NULL CHECK (tenant_id IS NULL OR char_length(tenant_id) <= 256),
          team_id TEXT NULL CHECK (team_id IS NULL OR char_length(team_id) <= 256),
          run_id UUID NULL,
          operation_id UUID NULL,
          workload_ref TEXT NULL CHECK (workload_ref IS NULL OR char_length(workload_ref) <= 512),
          payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
          UNIQUE (event_family, event_id)
        );

        CREATE TABLE IF NOT EXISTS infrastructure_price_snapshots (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          cloud_provider TEXT NOT NULL CHECK (cloud_provider IN ('gcp')),
          cloud_project_id TEXT NOT NULL CHECK (char_length(cloud_project_id) BETWEEN 1 AND 256),
          region TEXT NOT NULL CHECK (char_length(region) BETWEEN 1 AND 128),
          cluster_class TEXT NOT NULL CHECK (char_length(cluster_class) BETWEEN 1 AND 128),
          resource_class TEXT NOT NULL CHECK (resource_class IN ('cpu', 'memory', 'ephemeral_storage', 'gpu')),
          unit TEXT NOT NULL CHECK (unit IN ('vCPU_hour', 'GiB_hour', 'GiB_month', 'GPU_hour')),
          unit_price NUMERIC(24, 9) NOT NULL CHECK (unit_price >= 0),
          currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
          effective_from TIMESTAMPTZ NOT NULL,
          source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 512),
          source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (cloud_provider, cloud_project_id, region, cluster_class, resource_class, unit, currency, effective_from, source_sha256)
        );

        CREATE TABLE IF NOT EXISTS infrastructure_cost_daily (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          utc_day DATE NOT NULL,
          cloud_provider TEXT NOT NULL CHECK (cloud_provider IN ('gcp')),
          cloud_project_id TEXT NOT NULL CHECK (char_length(cloud_project_id) BETWEEN 1 AND 256),
          cluster_location TEXT NOT NULL CHECK (char_length(cluster_location) BETWEEN 1 AND 128),
          cluster_name TEXT NOT NULL CHECK (char_length(cluster_name) BETWEEN 1 AND 253),
          environment TEXT NOT NULL CHECK (char_length(environment) BETWEEN 1 AND 64),
          namespace TEXT NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 253),
          workload_kind TEXT NOT NULL CHECK (char_length(workload_kind) BETWEEN 1 AND 128),
          workload_ref TEXT NOT NULL CHECK (char_length(workload_ref) BETWEEN 1 AND 512),
          valuation_kind TEXT NOT NULL CHECK (valuation_kind IN ('estimated', 'billed')),
          selected_basis TEXT NOT NULL CHECK (selected_basis IN ('requested_capacity', 'measured_usage', 'gcp_request_allocation')),
          currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
          rollup_version INTEGER NOT NULL CHECK (rollup_version >= 1),
          predecessor_version INTEGER NULL,
          publication_state TEXT NOT NULL CHECK (publication_state IN ('provisional', 'finalized')),
          completeness_status TEXT NOT NULL CHECK (completeness_status IN ('complete', 'partial', 'unavailable')),
          as_of_utc TIMESTAMPTZ NOT NULL,
          source_interval_start TIMESTAMPTZ NULL,
          source_interval_end TIMESTAMPTZ NULL,
          billing_export_watermark TIMESTAMPTZ NULL,
          source_count BIGINT NOT NULL CHECK (source_count >= 0),
          source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
          gross_amount NUMERIC(24, 9) NOT NULL CHECK (gross_amount >= 0),
          credits_amount NUMERIC(24, 9) NOT NULL DEFAULT 0 CHECK (credits_amount <= 0),
          net_amount NUMERIC(24, 9) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (net_amount = gross_amount + credits_amount),
          CHECK ((source_interval_start IS NULL AND source_interval_end IS NULL) OR (source_interval_start IS NOT NULL AND source_interval_end IS NOT NULL AND source_interval_end > source_interval_start)),
          CHECK (
            (valuation_kind = 'estimated' AND selected_basis IN ('requested_capacity', 'measured_usage') AND source_interval_start IS NOT NULL AND billing_export_watermark IS NULL)
            OR (valuation_kind = 'billed' AND selected_basis = 'gcp_request_allocation' AND billing_export_watermark IS NOT NULL)
          ),
          CHECK (
            (rollup_version = 1 AND predecessor_version IS NULL)
            OR (rollup_version > 1 AND predecessor_version = rollup_version - 1)
          ),
          UNIQUE (id, valuation_kind, selected_basis),
          UNIQUE (utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name, environment, namespace, workload_kind, workload_ref, valuation_kind, selected_basis, currency, rollup_version),
          FOREIGN KEY (utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name, environment, namespace, workload_kind, workload_ref, valuation_kind, selected_basis, currency, predecessor_version)
            REFERENCES infrastructure_cost_daily (utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name, environment, namespace, workload_kind, workload_ref, valuation_kind, selected_basis, currency, rollup_version)
            DEFERRABLE INITIALLY DEFERRED
        );

        CREATE TABLE IF NOT EXISTS infrastructure_cost_daily_components (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          daily_cost_id UUID NOT NULL,
          valuation_kind TEXT NOT NULL CHECK (valuation_kind IN ('estimated', 'billed')),
          selected_basis TEXT NOT NULL CHECK (selected_basis IN ('requested_capacity', 'measured_usage', 'gcp_request_allocation')),
          component_key TEXT NOT NULL CHECK (char_length(component_key) BETWEEN 1 AND 512),
          resource_class TEXT NOT NULL CHECK (resource_class IN ('cpu', 'memory', 'ephemeral_storage', 'gpu', 'provider_sku', 'allocation_bucket')),
          allocation_bucket TEXT NULL CHECK (allocation_bucket IS NULL OR allocation_bucket IN ('platform_overhead', 'kube:system-overhead', 'kube:unallocated', 'unsupported', 'unmapped', 'missing_label', 'non_gke_shared', 'unknown', 'adjustment')),
          unit_hours NUMERIC(24, 9) NULL CHECK (unit_hours IS NULL OR unit_hours >= 0),
          price_snapshot_id UUID NULL REFERENCES infrastructure_price_snapshots(id) ON DELETE RESTRICT,
          provider_service TEXT NULL CHECK (provider_service IS NULL OR char_length(provider_service) <= 256),
          provider_sku TEXT NULL CHECK (provider_sku IS NULL OR char_length(provider_sku) <= 256),
          billing_view_version TEXT NULL CHECK (billing_view_version IS NULL OR char_length(billing_view_version) <= 128),
          source_row_count BIGINT NULL CHECK (source_row_count IS NULL OR source_row_count >= 0),
          source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
          billing_export_watermark TIMESTAMPTZ NULL,
          gross_amount NUMERIC(24, 9) NOT NULL CHECK (gross_amount >= 0),
          credits_amount NUMERIC(24, 9) NOT NULL DEFAULT 0 CHECK (credits_amount <= 0),
          net_amount NUMERIC(24, 9) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (net_amount = gross_amount + credits_amount),
          CHECK (
            (valuation_kind = 'estimated' AND selected_basis IN ('requested_capacity', 'measured_usage')
             AND price_snapshot_id IS NOT NULL AND unit_hours IS NOT NULL
             AND provider_service IS NULL AND provider_sku IS NULL AND billing_view_version IS NULL
             AND source_row_count IS NULL AND billing_export_watermark IS NULL)
            OR (valuation_kind = 'billed' AND selected_basis = 'gcp_request_allocation'
             AND price_snapshot_id IS NULL AND unit_hours IS NULL
             AND provider_service IS NOT NULL AND provider_sku IS NOT NULL AND billing_view_version IS NOT NULL
             AND source_row_count IS NOT NULL AND billing_export_watermark IS NOT NULL)
          ),
          UNIQUE (daily_cost_id, component_key),
          FOREIGN KEY (daily_cost_id, valuation_kind, selected_basis)
            REFERENCES infrastructure_cost_daily (id, valuation_kind, selected_basis)
            DEFERRABLE INITIALLY DEFERRED
        );

        CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_time
          ON agent_run_events (run_id, occurred_at DESC, ingest_sequence DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_source_time
          ON agent_run_events (source_service, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_administrative_events_operation_time
          ON administrative_events (operation_id, occurred_at DESC) WHERE operation_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_administrative_events_target_time
          ON administrative_events (target_type, target_ref, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_infrastructure_telemetry_workload_time
          ON infrastructure_telemetry_events (workload_ref, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_infrastructure_telemetry_interval
          ON infrastructure_telemetry_events (interval_end) WHERE interval_end IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_governed_event_stream_cursor
          ON governed_event_stream (stream_sequence);
        CREATE INDEX IF NOT EXISTS idx_governed_event_stream_family_time
          ON governed_event_stream (event_family, occurred_at, stream_sequence);
        CREATE INDEX IF NOT EXISTS idx_governed_event_stream_run_cursor
          ON governed_event_stream (run_id, stream_sequence) WHERE run_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_governed_event_stream_operation_cursor
          ON governed_event_stream (operation_id, stream_sequence) WHERE operation_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_governed_event_stream_workload_cursor
          ON governed_event_stream (workload_ref, stream_sequence) WHERE workload_ref IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_infrastructure_price_snapshots_lookup
          ON infrastructure_price_snapshots (cloud_provider, cloud_project_id, region, cluster_class, resource_class, effective_from DESC);
        CREATE INDEX IF NOT EXISTS idx_infrastructure_cost_daily_query
          ON infrastructure_cost_daily (utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name, environment, namespace, workload_kind, workload_ref, valuation_kind, selected_basis, currency, rollup_version DESC);
        CREATE INDEX IF NOT EXISTS idx_infrastructure_cost_daily_components_header
          ON infrastructure_cost_daily_components (daily_cost_id, component_key);

        CREATE OR REPLACE FUNCTION governed_trace_assert_stream_integrity()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          checked_family TEXT;
          checked_event_id UUID;
          family_row_exists BOOLEAN;
          stream_row_exists BOOLEAN;
        BEGIN
          IF TG_TABLE_NAME = 'governed_event_stream' THEN
            IF TG_OP = 'DELETE' THEN
              checked_family := OLD.event_family;
              checked_event_id := OLD.event_id;
            ELSE
              checked_family := NEW.event_family;
              checked_event_id := NEW.event_id;
            END IF;
          ELSIF TG_TABLE_NAME = 'agent_run_events' THEN
            checked_family := 'agent_run';
            checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
          ELSIF TG_TABLE_NAME = 'administrative_events' THEN
            checked_family := 'administrative';
            checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
          ELSE
            checked_family := 'infrastructure_telemetry';
            checked_event_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
          END IF;

          SELECT EXISTS (
            SELECT 1 FROM governed_event_stream
             WHERE event_family = checked_family AND event_id = checked_event_id
          ) INTO stream_row_exists;

          IF checked_family = 'agent_run' THEN
            SELECT EXISTS (SELECT 1 FROM agent_run_events WHERE event_id = checked_event_id) INTO family_row_exists;
          ELSIF checked_family = 'administrative' THEN
            SELECT EXISTS (SELECT 1 FROM administrative_events WHERE event_id = checked_event_id) INTO family_row_exists;
          ELSE
            SELECT EXISTS (SELECT 1 FROM infrastructure_telemetry_events WHERE event_id = checked_event_id) INTO family_row_exists;
          END IF;

          IF family_row_exists <> stream_row_exists THEN
            RAISE EXCEPTION 'governed event family row and stream pointer must commit together (%:%)', checked_family, checked_event_id;
          END IF;
          RETURN NULL;
        END;
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_enforce_append_only()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP = 'DELETE'
             AND current_setting('governed_trace.retention_delete', true) = 'on'
             AND TG_TABLE_NAME IN (
               'agent_run_events', 'administrative_events',
               'infrastructure_telemetry_events', 'governed_event_stream',
               'infrastructure_cost_daily_components', 'infrastructure_cost_daily'
             ) THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'governed trace relation % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
        END;
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_enforce_rollup_finality()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          predecessor_state TEXT;
        BEGIN
          IF NEW.predecessor_version IS NULL THEN
            RETURN NEW;
          END IF;
          SELECT publication_state INTO predecessor_state
            FROM infrastructure_cost_daily
           WHERE utc_day = NEW.utc_day
             AND cloud_provider = NEW.cloud_provider
             AND cloud_project_id = NEW.cloud_project_id
             AND cluster_location = NEW.cluster_location
             AND cluster_name = NEW.cluster_name
             AND environment = NEW.environment
             AND namespace = NEW.namespace
             AND workload_kind = NEW.workload_kind
             AND workload_ref = NEW.workload_ref
             AND valuation_kind = NEW.valuation_kind
             AND selected_basis = NEW.selected_basis
             AND currency = NEW.currency
             AND rollup_version = NEW.predecessor_version;
          IF predecessor_state = 'finalized' AND NEW.publication_state <> 'finalized' THEN
            RAISE EXCEPTION 'infrastructure cost finality cannot regress';
          END IF;
          RETURN NEW;
        END;
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_assert_cost_component_conservation()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          checked_daily_cost_id UUID;
          header_gross NUMERIC(24, 9);
          header_credits NUMERIC(24, 9);
          header_net NUMERIC(24, 9);
          component_gross NUMERIC(24, 9);
          component_credits NUMERIC(24, 9);
          component_net NUMERIC(24, 9);
        BEGIN
          IF TG_TABLE_NAME = 'infrastructure_cost_daily' THEN
            checked_daily_cost_id := NEW.id;
          ELSE
            checked_daily_cost_id := NEW.daily_cost_id;
          END IF;

          SELECT gross_amount, credits_amount, net_amount
            INTO header_gross, header_credits, header_net
            FROM infrastructure_cost_daily
           WHERE id = checked_daily_cost_id;
          IF NOT FOUND THEN
            RETURN NULL;
          END IF;

          SELECT
            COALESCE(SUM(gross_amount), 0),
            COALESCE(SUM(credits_amount), 0),
            COALESCE(SUM(net_amount), 0)
            INTO component_gross, component_credits, component_net
            FROM infrastructure_cost_daily_components
           WHERE daily_cost_id = checked_daily_cost_id;

          IF component_gross <> header_gross
             OR component_credits <> header_credits
             OR component_net <> header_net THEN
            RAISE EXCEPTION 'infrastructure cost header and components must conserve exact gross, credits, and net for %', checked_daily_cost_id;
          END IF;
          RETURN NULL;
        END;
        $$;

        DROP TRIGGER IF EXISTS governed_agent_run_event_stream_integrity ON agent_run_events;
        CREATE CONSTRAINT TRIGGER governed_agent_run_event_stream_integrity
          AFTER INSERT OR DELETE ON agent_run_events
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_stream_integrity();
        DROP TRIGGER IF EXISTS governed_administrative_event_stream_integrity ON administrative_events;
        CREATE CONSTRAINT TRIGGER governed_administrative_event_stream_integrity
          AFTER INSERT OR DELETE ON administrative_events
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_stream_integrity();
        DROP TRIGGER IF EXISTS governed_infrastructure_telemetry_stream_integrity ON infrastructure_telemetry_events;
        CREATE CONSTRAINT TRIGGER governed_infrastructure_telemetry_stream_integrity
          AFTER INSERT OR DELETE ON infrastructure_telemetry_events
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_stream_integrity();
        DROP TRIGGER IF EXISTS governed_event_stream_family_integrity ON governed_event_stream;
        CREATE CONSTRAINT TRIGGER governed_event_stream_family_integrity
          AFTER INSERT OR DELETE ON governed_event_stream
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_stream_integrity();

        DROP TRIGGER IF EXISTS governed_agent_run_events_append_only ON agent_run_events;
        CREATE TRIGGER governed_agent_run_events_append_only
          BEFORE UPDATE OR DELETE ON agent_run_events
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS governed_administrative_events_append_only ON administrative_events;
        CREATE TRIGGER governed_administrative_events_append_only
          BEFORE UPDATE OR DELETE ON administrative_events
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS governed_infrastructure_telemetry_events_append_only ON infrastructure_telemetry_events;
        CREATE TRIGGER governed_infrastructure_telemetry_events_append_only
          BEFORE UPDATE OR DELETE ON infrastructure_telemetry_events
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS governed_event_stream_append_only ON governed_event_stream;
        CREATE TRIGGER governed_event_stream_append_only
          BEFORE UPDATE OR DELETE ON governed_event_stream
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS infrastructure_price_snapshots_append_only ON infrastructure_price_snapshots;
        CREATE TRIGGER infrastructure_price_snapshots_append_only
          BEFORE UPDATE OR DELETE ON infrastructure_price_snapshots
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS infrastructure_cost_daily_append_only ON infrastructure_cost_daily;
        CREATE TRIGGER infrastructure_cost_daily_append_only
          BEFORE UPDATE OR DELETE ON infrastructure_cost_daily
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS infrastructure_cost_daily_components_append_only ON infrastructure_cost_daily_components;
        CREATE TRIGGER infrastructure_cost_daily_components_append_only
          BEFORE UPDATE OR DELETE ON infrastructure_cost_daily_components
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();

        DROP TRIGGER IF EXISTS infrastructure_cost_daily_finality ON infrastructure_cost_daily;
        CREATE TRIGGER infrastructure_cost_daily_finality
          BEFORE INSERT ON infrastructure_cost_daily
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_rollup_finality();

        DROP TRIGGER IF EXISTS infrastructure_cost_daily_component_conservation ON infrastructure_cost_daily;
        CREATE CONSTRAINT TRIGGER infrastructure_cost_daily_component_conservation
          AFTER INSERT ON infrastructure_cost_daily
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_cost_component_conservation();
        DROP TRIGGER IF EXISTS infrastructure_cost_daily_components_conservation ON infrastructure_cost_daily_components;
        CREATE CONSTRAINT TRIGGER infrastructure_cost_daily_components_conservation
          AFTER INSERT ON infrastructure_cost_daily_components
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION governed_trace_assert_cost_component_conservation();

        CREATE OR REPLACE FUNCTION governed_trace_reject_truncate()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'governed trace relation % is append-only; TRUNCATE is not allowed', TG_TABLE_NAME;
        END;
        $$;

        DROP TRIGGER IF EXISTS governed_agent_run_events_no_truncate ON agent_run_events;
        CREATE TRIGGER governed_agent_run_events_no_truncate BEFORE TRUNCATE ON agent_run_events FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS governed_administrative_events_no_truncate ON administrative_events;
        CREATE TRIGGER governed_administrative_events_no_truncate BEFORE TRUNCATE ON administrative_events FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS governed_infrastructure_telemetry_events_no_truncate ON infrastructure_telemetry_events;
        CREATE TRIGGER governed_infrastructure_telemetry_events_no_truncate BEFORE TRUNCATE ON infrastructure_telemetry_events FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS governed_event_stream_no_truncate ON governed_event_stream;
        CREATE TRIGGER governed_event_stream_no_truncate BEFORE TRUNCATE ON governed_event_stream FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS infrastructure_price_snapshots_no_truncate ON infrastructure_price_snapshots;
        CREATE TRIGGER infrastructure_price_snapshots_no_truncate BEFORE TRUNCATE ON infrastructure_price_snapshots FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS infrastructure_cost_daily_no_truncate ON infrastructure_cost_daily;
        CREATE TRIGGER infrastructure_cost_daily_no_truncate BEFORE TRUNCATE ON infrastructure_cost_daily FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS infrastructure_cost_daily_components_no_truncate ON infrastructure_cost_daily_components;
        CREATE TRIGGER infrastructure_cost_daily_components_no_truncate BEFORE TRUNCATE ON infrastructure_cost_daily_components FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();

        -- Migration 0055 replaces this bootstrap function with the final
        -- owner-bound retention implementation and dedicated runtime roles.
        CREATE OR REPLACE FUNCTION governed_trace_prune_expired_events(
          requested_family TEXT,
          batch_limit INTEGER DEFAULT 1000
        )
        RETURNS TABLE (event_family TEXT, event_id UUID)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
        BEGIN
          IF requested_family NOT IN ('agent_run', 'administrative', 'infrastructure_telemetry') THEN
            RAISE EXCEPTION 'unsupported governed event family: %', requested_family;
          END IF;
          IF batch_limit NOT BETWEEN 1 AND 1000 THEN
            RAISE EXCEPTION 'governed trace retention batch must be between 1 and 1000';
          END IF;

          PERFORM set_config('governed_trace.retention_delete', 'on', true);
          RETURN QUERY
          WITH selected AS MATERIALIZED (
            SELECT stream.event_family, stream.event_id
              FROM governed_event_stream AS stream
              LEFT JOIN infrastructure_telemetry_events AS telemetry
                ON stream.event_family = 'infrastructure_telemetry'
               AND telemetry.event_id = stream.event_id
             WHERE stream.event_family = requested_family
               AND (
                 (stream.event_family IN ('agent_run', 'administrative')
                  AND stream.occurred_at < clock_timestamp() - INTERVAL '90 days')
                 OR (stream.event_family = 'infrastructure_telemetry'
                     AND telemetry.telemetry_type IN ('capacity_sample', 'usage_sample')
                     AND stream.occurred_at < clock_timestamp() - INTERVAL '30 days')
                 OR (stream.event_family = 'infrastructure_telemetry'
                     AND telemetry.telemetry_type NOT IN ('capacity_sample', 'usage_sample')
                     AND stream.occurred_at < clock_timestamp() - INTERVAL '90 days')
               )
             ORDER BY stream.stream_sequence
             LIMIT batch_limit
             FOR UPDATE OF stream SKIP LOCKED
          ),
          deleted_agent AS (
            DELETE FROM agent_run_events AS events
             USING selected
             WHERE selected.event_family = 'agent_run' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_administrative AS (
            DELETE FROM administrative_events AS events
             USING selected
             WHERE selected.event_family = 'administrative' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_telemetry AS (
            DELETE FROM infrastructure_telemetry_events AS events
             USING selected
             WHERE selected.event_family = 'infrastructure_telemetry' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_stream AS (
            DELETE FROM governed_event_stream AS stream
             USING selected
             WHERE stream.event_family = selected.event_family AND stream.event_id = selected.event_id
             RETURNING stream.event_family, stream.event_id
          )
          SELECT deleted_stream.event_family, deleted_stream.event_id FROM deleted_stream;
        END;
        $$;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) FROM PUBLIC;

        CREATE OR REPLACE VIEW governed_event_read_v1 AS
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence AS family_ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            events.run_id::TEXT AS correlation_ref,
            'agent'::TEXT AS actor_kind,
            events.agent_sub AS actor_sub,
            events.source_service AS service_or_agent_ref,
            events.actor_human_sub AS initiating_human_sub,
            events.agent_sub AS acting_agent_sub,
            events.resource_aud,
            events.effective_scopes,
            events.decision AS authorization_decision,
            events.token_exchange_id::TEXT AS token_exchange_id,
            events.event_type AS event_type,
            events.outcome,
            events.host_ref AS target_ref,
            events.payload_metadata AS safe_payload,
            'agent_run_events'::TEXT AS source_table,
            events.decision_actor_sub
          FROM governed_event_stream AS stream
          JOIN agent_run_events AS events
            ON stream.event_family = 'agent_run' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            COALESCE(events.operation_id::TEXT, events.request_id, events.correlation_id) AS correlation_ref,
            CASE WHEN events.operator_sub IS NULL THEN 'service' ELSE 'operator' END,
            COALESCE(events.operator_sub, events.service_sub),
            events.source_service,
            events.operator_sub,
            NULL::TEXT,
            NULL::TEXT,
            ARRAY[]::TEXT[],
            NULL::TEXT,
            NULL::TEXT,
            events.action,
            events.outcome,
            events.target_ref,
            events.payload_metadata,
            'administrative_events'::TEXT,
            NULL::TEXT
          FROM governed_event_stream AS stream
          JOIN administrative_events AS events
            ON stream.event_family = 'administrative' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            COALESCE(events.workload_ref, events.interval_start::TEXT),
            'controller'::TEXT,
            events.source_service,
            events.source_service,
            NULL::TEXT,
            NULL::TEXT,
            NULL::TEXT,
            ARRAY[]::TEXT[],
            NULL::TEXT,
            NULL::TEXT,
            events.telemetry_type,
            events.outcome,
            events.workload_ref,
            events.payload_metadata,
            'infrastructure_telemetry_events'::TEXT,
            NULL::TEXT
          FROM governed_event_stream AS stream
          JOIN infrastructure_telemetry_events AS events
            ON stream.event_family = 'infrastructure_telemetry' AND stream.event_id = events.event_id;

      `)
    },
  },
  {
    version: '0062_governed_trace_runtime_roles',
    legacyVersions: ['0055_governed_trace_runtime_roles'],
    apply: async db => {
      await db.query(`
        ALTER FUNCTION governed_trace_safe_metadata(JSONB)
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB)
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_sorted_unique_text_array(TEXT[])
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_assert_stream_integrity()
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_enforce_rollup_finality()
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_assert_cost_component_conservation()
          SET search_path = pg_catalog, public;
        ALTER FUNCTION governed_trace_reject_truncate()
          SET search_path = pg_catalog, public;

        CREATE OR REPLACE FUNCTION governed_trace_enforce_append_only()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          IF TG_OP = 'DELETE'
             AND TG_TABLE_NAME IN (
               'agent_run_events', 'administrative_events',
               'infrastructure_telemetry_events', 'governed_event_stream',
               'infrastructure_cost_daily_components', 'infrastructure_cost_daily'
             )
             AND current_user = (
               SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID
             ) THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'governed trace relation % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
        END;
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_prune_expired_events(
          requested_family TEXT,
          batch_limit INTEGER DEFAULT 1000
        )
        RETURNS TABLE (event_family TEXT, event_id UUID)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          IF requested_family NOT IN ('agent_run', 'administrative', 'infrastructure_telemetry') THEN
            RAISE EXCEPTION 'unsupported governed event family: %', requested_family;
          END IF;
          IF batch_limit NOT BETWEEN 1 AND 1000 THEN
            RAISE EXCEPTION 'governed trace retention batch must be between 1 and 1000';
          END IF;

          RETURN QUERY
          WITH selected AS MATERIALIZED (
            SELECT stream.event_family, stream.event_id
              FROM governed_event_stream AS stream
              LEFT JOIN infrastructure_telemetry_events AS telemetry
                ON stream.event_family = 'infrastructure_telemetry'
               AND telemetry.event_id = stream.event_id
             WHERE stream.event_family = requested_family
               AND (
                 (stream.event_family IN ('agent_run', 'administrative')
                  AND stream.occurred_at < clock_timestamp() - INTERVAL '90 days')
                 OR (stream.event_family = 'infrastructure_telemetry'
                     AND telemetry.telemetry_type IN ('capacity_sample', 'usage_sample')
                     AND stream.occurred_at < clock_timestamp() - INTERVAL '30 days')
                 OR (stream.event_family = 'infrastructure_telemetry'
                     AND telemetry.telemetry_type NOT IN ('capacity_sample', 'usage_sample')
                     AND stream.occurred_at < clock_timestamp() - INTERVAL '90 days')
               )
             ORDER BY stream.stream_sequence
             LIMIT batch_limit
             FOR UPDATE OF stream SKIP LOCKED
          ),
          deleted_agent AS (
            DELETE FROM agent_run_events AS events
             USING selected
             WHERE selected.event_family = 'agent_run' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_administrative AS (
            DELETE FROM administrative_events AS events
             USING selected
             WHERE selected.event_family = 'administrative' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_telemetry AS (
            DELETE FROM infrastructure_telemetry_events AS events
             USING selected
             WHERE selected.event_family = 'infrastructure_telemetry' AND events.event_id = selected.event_id
             RETURNING events.event_id
          ),
          deleted_stream AS (
            DELETE FROM governed_event_stream AS stream
             USING selected
             WHERE stream.event_family = selected.event_family AND stream.event_id = selected.event_id
             RETURNING stream.event_family, stream.event_id
          )
          SELECT deleted_stream.event_family, deleted_stream.event_id FROM deleted_stream;
        END;
        $$;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) FROM PUBLIC;

        CREATE OR REPLACE FUNCTION governed_trace_prune_expired_costs(
          batch_limit INTEGER DEFAULT 1000
        )
        RETURNS TABLE (id UUID)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          IF batch_limit NOT BETWEEN 1 AND 1000 THEN
            RAISE EXCEPTION 'governed trace retention batch must be between 1 and 1000';
          END IF;

          RETURN QUERY
          WITH selected AS MATERIALIZED (
            SELECT daily.id
              FROM infrastructure_cost_daily AS daily
             WHERE daily.utc_day < (clock_timestamp() AT TIME ZONE 'UTC')::date - 365
             ORDER BY daily.utc_day, daily.id
             LIMIT batch_limit
             FOR UPDATE OF daily SKIP LOCKED
          ),
          deleted_components AS (
            DELETE FROM infrastructure_cost_daily_components AS component
             USING selected
             WHERE component.daily_cost_id = selected.id
             RETURNING component.daily_cost_id
          ),
          deleted_daily AS (
            DELETE FROM infrastructure_cost_daily AS daily
             USING selected
             WHERE daily.id = selected.id
             RETURNING daily.id
          )
          SELECT deleted_daily.id FROM deleted_daily;
        END;
        $$;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_costs(INTEGER) FROM PUBLIC;

        DO $governed_trace_roles$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_api_runtime') THEN
            CREATE ROLE control_api_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trace_maintenance_runtime') THEN
            CREATE ROLE trace_maintenance_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_recipes_runtime') THEN
            CREATE ROLE workflow_recipes_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
        END
        $governed_trace_roles$;

        ALTER ROLE control_api_runtime
          WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        ALTER ROLE trace_maintenance_runtime
          WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        ALTER ROLE workflow_recipes_runtime
          WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

        GRANT USAGE ON SCHEMA public
          TO control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;

        -- This is the whole control-api application role, so it retains the legacy
        -- application DML surface. Governed trace relations are narrowed below.
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO control_api_runtime;
        GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO control_api_runtime;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations
          FROM control_api_runtime;
        GRANT SELECT ON TABLE schema_migrations TO control_api_runtime;

        REVOKE ALL ON TABLE
          agent_run_events,
          administrative_events,
          infrastructure_telemetry_events,
          governed_event_stream,
          infrastructure_price_snapshots,
          infrastructure_cost_daily,
          infrastructure_cost_daily_components,
          governed_event_read_v1
          FROM PUBLIC;
        REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
          agent_run_events,
          administrative_events,
          infrastructure_telemetry_events,
          governed_event_stream,
          infrastructure_price_snapshots,
          infrastructure_cost_daily,
          infrastructure_cost_daily_components
          FROM control_api_runtime;
        REVOKE INSERT, UPDATE, DELETE ON TABLE governed_event_read_v1 FROM control_api_runtime;
        REVOKE INSERT ON TABLE
          infrastructure_price_snapshots,
          infrastructure_cost_daily,
          infrastructure_cost_daily_components
          FROM control_api_runtime;
        GRANT SELECT, INSERT ON TABLE
          agent_run_events,
          administrative_events,
          infrastructure_telemetry_events,
          governed_event_stream
          TO control_api_runtime;
        GRANT SELECT ON TABLE
          infrastructure_price_snapshots,
          infrastructure_cost_daily,
          infrastructure_cost_daily_components
          TO control_api_runtime;
        GRANT SELECT ON TABLE governed_event_read_v1 TO control_api_runtime;

        REVOKE ALL ON SEQUENCE
          agent_run_events_ingest_sequence_seq,
          administrative_events_ingest_sequence_seq,
          infrastructure_telemetry_events_ingest_sequence_seq,
          governed_event_stream_stream_sequence_seq
          FROM PUBLIC;
        REVOKE UPDATE ON SEQUENCE
          agent_run_events_ingest_sequence_seq,
          administrative_events_ingest_sequence_seq,
          infrastructure_telemetry_events_ingest_sequence_seq,
          governed_event_stream_stream_sequence_seq
          FROM control_api_runtime;
        GRANT USAGE, SELECT ON SEQUENCE
          agent_run_events_ingest_sequence_seq,
          administrative_events_ingest_sequence_seq,
          infrastructure_telemetry_events_ingest_sequence_seq,
          governed_event_stream_stream_sequence_seq
          TO control_api_runtime;

        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM trace_maintenance_runtime;
        GRANT SELECT, INSERT ON TABLE
          infrastructure_telemetry_events,
          governed_event_stream,
          infrastructure_price_snapshots,
          infrastructure_cost_daily,
          infrastructure_cost_daily_components
          TO trace_maintenance_runtime;
        GRANT SELECT ON TABLE
          agent_run_events,
          administrative_events,
          governed_event_read_v1
          TO trace_maintenance_runtime;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM trace_maintenance_runtime;
        GRANT USAGE, SELECT ON SEQUENCE
          infrastructure_telemetry_events_ingest_sequence_seq,
          governed_event_stream_stream_sequence_seq
          TO trace_maintenance_runtime;

        REVOKE ALL ON FUNCTION governed_trace_safe_metadata(JSONB) FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB) FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_sorted_unique_text_array(TEXT[]) FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_assert_stream_integrity() FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_enforce_append_only() FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_enforce_rollup_finality() FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_assert_cost_component_conservation() FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_reject_truncate() FROM PUBLIC;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) FROM control_api_runtime;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_costs(INTEGER) FROM control_api_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_safe_metadata(JSONB) TO control_api_runtime, trace_maintenance_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_safe_agent_run_metadata(TEXT, JSONB) TO control_api_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_sorted_unique_text_array(TEXT[]) TO control_api_runtime;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM trace_maintenance_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_safe_metadata(JSONB) TO trace_maintenance_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_events(TEXT, INTEGER) TO trace_maintenance_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_costs(INTEGER) TO trace_maintenance_runtime;

        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM workflow_recipes_runtime;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM workflow_recipes_runtime;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM workflow_recipes_runtime;
        GRANT SELECT, UPDATE ON TABLE workflow_runs TO workflow_recipes_runtime;
        GRANT SELECT, INSERT, UPDATE ON TABLE workflow_run_steps TO workflow_recipes_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflow_schedules TO workflow_recipes_runtime;
        GRANT SELECT, UPDATE ON TABLE workflow_approval_requests TO workflow_recipes_runtime;
        GRANT DELETE ON TABLE
          team_workflow_triggers,
          user_workflow_triggers,
          workflow_recipe_allowed_teams
          TO workflow_recipes_runtime;
        GRANT SELECT (recipe_namespace, recipe_name)
          ON TABLE team_workflow_triggers TO workflow_recipes_runtime;
        GRANT SELECT (recipe_namespace, recipe_name)
          ON TABLE user_workflow_triggers TO workflow_recipes_runtime;
        GRANT SELECT (recipe_namespace, recipe_name)
          ON TABLE workflow_recipe_allowed_teams TO workflow_recipes_runtime;
        REVOKE ALL ON FUNCTION public.notify_workflow_run_update()
          FROM workflow_recipes_runtime;
      `)
    },
  },
  {
    version: '0063_workflow_approval_trace_binding',
    legacyVersions: ['0056_workflow_approval_trace_binding'],
    apply: async db => {
      await db.query(`
        ALTER TABLE agent_run_events
          ADD COLUMN IF NOT EXISTS decision_actor_sub TEXT NULL;
        ALTER TABLE agent_run_events
          DROP CONSTRAINT IF EXISTS agent_run_events_source_kind_check;
        ALTER TABLE agent_run_events
          ADD CONSTRAINT agent_run_events_source_kind_check
          CHECK (source_kind IN ('mcp_host_runtime', 'wrc_internal_control', 'control_api_local'));
        ALTER TABLE agent_run_events
          DROP CONSTRAINT IF EXISTS agent_run_events_decision_actor_sub_check;
        ALTER TABLE agent_run_events
          ADD CONSTRAINT agent_run_events_decision_actor_sub_check
          CHECK (decision_actor_sub IS NULL OR char_length(decision_actor_sub) <= 256);

        ALTER TABLE workflow_approval_requests
          ADD COLUMN IF NOT EXISTS bound_workflow_run_id UUID NULL;
        ALTER TABLE workflow_approval_requests
          ADD COLUMN IF NOT EXISTS bound_workflow_step_id TEXT NULL;
        ALTER TABLE workflow_run_steps
          ADD COLUMN IF NOT EXISTS approval_binding_sha256 TEXT NULL;
        ALTER TABLE workflow_run_steps
          DROP CONSTRAINT IF EXISTS workflow_run_steps_approval_binding_sha256_check;
        ALTER TABLE workflow_run_steps
          ADD CONSTRAINT workflow_run_steps_approval_binding_sha256_check
          CHECK (
            approval_binding_sha256 IS NULL
            OR approval_binding_sha256 ~ '^[0-9a-f]{64}$'
          );
        ALTER TABLE workflow_approval_requests
          DROP CONSTRAINT IF EXISTS workflow_approval_requests_bound_workflow_run_id_fkey;
        ALTER TABLE workflow_approval_requests
          DROP CONSTRAINT IF EXISTS workflow_approval_requests_bound_workflow_step_fkey;
        ALTER TABLE workflow_approval_requests
          ADD CONSTRAINT workflow_approval_requests_bound_workflow_step_fkey
          FOREIGN KEY (bound_workflow_run_id, bound_workflow_step_id)
          REFERENCES workflow_run_steps(run_id, step_id)
          ON DELETE SET NULL;
        ALTER TABLE workflow_approval_requests
          DROP CONSTRAINT IF EXISTS workflow_approval_requests_bound_workflow_pair_check;
        ALTER TABLE workflow_approval_requests
          ADD CONSTRAINT workflow_approval_requests_bound_workflow_pair_check
          CHECK (
            (bound_workflow_run_id IS NULL AND bound_workflow_step_id IS NULL)
            OR (bound_workflow_run_id IS NOT NULL AND NULLIF(BTRIM(bound_workflow_step_id), '') IS NOT NULL)
          );
        CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_bound_workflow
          ON workflow_approval_requests (bound_workflow_run_id, bound_workflow_step_id)
          WHERE bound_workflow_run_id IS NOT NULL;

        CREATE OR REPLACE VIEW governed_event_read_v1 AS
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence AS family_ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            events.run_id::TEXT AS correlation_ref,
            'agent'::TEXT AS actor_kind,
            events.agent_sub AS actor_sub,
            events.source_service AS service_or_agent_ref,
            events.actor_human_sub AS initiating_human_sub,
            events.agent_sub AS acting_agent_sub,
            events.resource_aud,
            events.effective_scopes,
            events.decision AS authorization_decision,
            events.token_exchange_id::TEXT AS token_exchange_id,
            events.event_type AS event_type,
            events.outcome,
            events.host_ref AS target_ref,
            events.payload_metadata AS safe_payload,
            'agent_run_events'::TEXT AS source_table,
            events.decision_actor_sub
          FROM governed_event_stream AS stream
          JOIN agent_run_events AS events
            ON stream.event_family = 'agent_run' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            COALESCE(events.operation_id::TEXT, events.request_id, events.correlation_id),
            CASE WHEN events.operator_sub IS NULL THEN 'service' ELSE 'operator' END,
            COALESCE(events.operator_sub, events.service_sub),
            events.source_service,
            events.operator_sub,
            NULL::TEXT,
            NULL::TEXT,
            ARRAY[]::TEXT[],
            NULL::TEXT,
            NULL::TEXT,
            events.action,
            events.outcome,
            events.target_ref,
            events.payload_metadata,
            'administrative_events'::TEXT,
            NULL::TEXT
          FROM governed_event_stream AS stream
          JOIN administrative_events AS events
            ON stream.event_family = 'administrative' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence,
            stream.event_family,
            events.event_id,
            events.ingest_sequence,
            events.occurred_at,
            events.ingested_at,
            events.schema_version,
            COALESCE(events.workload_ref, events.interval_start::TEXT),
            'controller'::TEXT,
            events.source_service,
            events.source_service,
            NULL::TEXT,
            NULL::TEXT,
            NULL::TEXT,
            ARRAY[]::TEXT[],
            NULL::TEXT,
            NULL::TEXT,
            events.telemetry_type,
            events.outcome,
            events.workload_ref,
            events.payload_metadata,
            'infrastructure_telemetry_events'::TEXT,
            NULL::TEXT
          FROM governed_event_stream AS stream
          JOIN infrastructure_telemetry_events AS events
            ON stream.event_family = 'infrastructure_telemetry' AND stream.event_id = events.event_id;
      `)
      // WRC owns workflow lifecycle updates, while the trigger's fixed-path
      // definer authority keeps notification delivery inside the control plane.
      await applyWorkflowRunCompletedNotificationTrigger(db)
      await db.query(`
        REVOKE ALL ON FUNCTION public.notify_workflow_run_update()
          FROM workflow_recipes_runtime;
      `)
    },
  },
  {
    version: '0064_agent_decision_source_catalog',
    legacyVersions: ['0057_agent_decision_source_catalog'],
    apply: async db => {
      await db.query(`
        ALTER TABLE agent_run_events
          DROP CONSTRAINT IF EXISTS agent_run_events_decision_source_kind_check;
        ALTER TABLE agent_run_events
          ADD CONSTRAINT agent_run_events_decision_source_kind_check
          CHECK (
            decision_source_kind IS NULL
            OR decision_source_kind IN (
              'approval_request',
              'approval_resolution',
              'policy',
              'policy_evaluator',
              'runtime_guard',
              'legacy_gate'
            )
          );
      `)
    },
  },
  {
    version: '0065_governed_session_replay_and_prompt_history',
    legacyVersions: ['0058_governed_session_replay_and_prompt_history'],
    apply: async db => {
      await db.query(`
        ALTER TABLE usage_events
          ADD COLUMN IF NOT EXISTS cache_tokens_reported BOOLEAN NOT NULL DEFAULT FALSE;

        UPDATE usage_events
           SET cache_tokens_reported = TRUE
         WHERE cache_tokens_reported = FALSE
           AND (cache_read_tokens > 0 OR cache_write_tokens > 0);

        CREATE OR REPLACE FUNCTION governed_trace_safe_metadata(value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'reason_code', 'error_class', 'phase', 'state', 'status',
                  'transition', 'resource_class', 'unit', 'provider_ref',
                  'summary', 'detail_ref', 'target_label', 'tool_name', 'tool_kind',
                  'tool_source_ref', 'model', 'attempt', 'count', 'config_hash'
                )
             )
             AND (
               NOT (value ? 'tool_kind')
               OR (
                 jsonb_typeof(value->'tool_kind') = 'string'
                 AND value->>'tool_kind' IN ('internal_tool', 'mcp_server_tool', 'workflow')
               )
             )
             AND (
               NOT (value ? 'target_label')
               OR (
                 jsonb_typeof(value->'target_label') = 'string'
                 AND value->>'target_label' ~ '^[A-Za-z0-9._-]{3,64}$'
               )
             )
             AND (
               NOT (value ? 'tool_source_ref')
               OR (
                 jsonb_typeof(value->'tool_source_ref') = 'string'
                 AND char_length(value->>'tool_source_ref') BETWEEN 1 AND 128
               )
             );
        $$;

        CREATE OR REPLACE FUNCTION governed_trace_safe_agent_run_metadata(event_kind TEXT, value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT CASE
            WHEN event_kind <> 'token_usage' THEN governed_trace_safe_metadata(value)
            ELSE jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND value ?& ARRAY[
               'request_ref', 'provider', 'model', 'source_kind',
               'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
               'cache_tokens_reported'
             ]
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'request_ref', 'provider', 'model', 'source_kind',
                  'input_tokens', 'output_tokens', 'cache_read_tokens',
                  'cache_write_tokens', 'cache_tokens_reported', 'iteration', 'prompt_bridge'
                )
             )
             AND jsonb_typeof(value->'request_ref') = 'string'
             AND (value->>'request_ref') ~ '^[0-9a-f]{64}$'
             AND jsonb_typeof(value->'provider') = 'string'
             AND jsonb_typeof(value->'model') = 'string'
             AND jsonb_typeof(value->'source_kind') = 'string'
             AND value->>'source_kind' IN ('channel', 'desktop', 'workflow', 'cron', 'unknown', 'plugin_workload_sdk')
             AND jsonb_typeof(value->'input_tokens') = 'number'
             AND (value->>'input_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'output_tokens') = 'number'
             AND (value->>'output_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_read_tokens') = 'number'
             AND (value->>'cache_read_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_write_tokens') = 'number'
             AND (value->>'cache_write_tokens') ~ '^(0|[1-9][0-9]*)$'
             AND jsonb_typeof(value->'cache_tokens_reported') = 'boolean'
             AND (
               NOT (value ? 'iteration')
               OR (
                 jsonb_typeof(value->'iteration') = 'number'
                 AND (value->>'iteration') ~ '^(0|[1-9][0-9]*)$'
               )
             )
             AND (
               NOT (value ? 'prompt_bridge')
               OR (
                 jsonb_typeof(value->'prompt_bridge') = 'object'
                 AND value->'prompt_bridge' ?& ARRAY[
                   'invocation_id', 'attempt_generation', 'target_ref',
                   'fallback_used', 'attempt_count', 'provider_attempt_id',
                   'provider_attempt_index'
                 ]
                 AND (value->'prompt_bridge'->>'invocation_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'provider_attempt_id') ~ '^[0-9a-f-]{36}$'
                 AND (value->'prompt_bridge'->>'attempt_generation') ~ '^[1-9][0-9]*$'
                 AND (value->'prompt_bridge'->>'provider_attempt_index') ~ '^[1-9][0-9]*$'
                 AND jsonb_typeof(value->'prompt_bridge'->'target_ref') = 'string'
                 AND jsonb_typeof(value->'prompt_bridge'->'fallback_used') = 'boolean'
                 AND jsonb_typeof(value->'prompt_bridge'->'attempt_count') = 'number'
               )
             )
          END;
        $$;

        CREATE TABLE IF NOT EXISTS governed_run_attribution_bindings (
          run_id UUID PRIMARY KEY,
          host_ref TEXT NOT NULL CHECK (char_length(host_ref) BETWEEN 1 AND 256),
          session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 256),
          origin TEXT NOT NULL CHECK (origin IN ('direct_chat', 'channel_event', 'api')),
          identity_issuer TEXT NOT NULL CHECK (char_length(identity_issuer) BETWEEN 1 AND 512),
          actor_human_sub TEXT NOT NULL CHECK (char_length(actor_human_sub) BETWEEN 1 AND 256),
          user_id UUID NULL,
          team_id UUID NULL,
          binding_sha256 TEXT NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );

        CREATE TABLE IF NOT EXISTS governed_approval_prompt_history (
          approval_request_id UUID PRIMARY KEY,
          approval_kind TEXT NOT NULL CHECK (approval_kind IN ('tool', 'workflow')),
          run_id UUID NULL,
          host_ref TEXT NULL CHECK (host_ref IS NULL OR char_length(host_ref) BETWEEN 1 AND 256),
          session_id TEXT NULL CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 256),
          origin TEXT NULL CHECK (origin IS NULL OR origin IN ('direct_chat', 'workflow_runtime', 'channel_event', 'api')),
          ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 32784),
          nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
          key_version TEXT NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
          plaintext_sha256 TEXT NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
          plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 32768),
          redaction_summary JSONB NOT NULL CHECK (
            jsonb_typeof(redaction_summary) = 'object'
            AND redaction_summary ?& ARRAY['redacted', 'replacementCount']
            AND redaction_summary - ARRAY['redacted', 'replacementCount'] = '{}'::jsonb
            AND jsonb_typeof(redaction_summary->'redacted') = 'boolean'
            AND jsonb_typeof(redaction_summary->'replacementCount') = 'number'
            AND (redaction_summary->>'replacementCount') ~ '^(0|[1-9][0-9]*)$'
          ),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('mcp_host_runtime', 'control_api_local')),
          captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > captured_at),
          CHECK (
            (approval_kind = 'tool' AND run_id IS NOT NULL AND host_ref IS NOT NULL AND session_id IS NOT NULL AND origin IS NOT NULL AND source_kind = 'mcp_host_runtime')
            OR (approval_kind = 'workflow' AND source_kind = 'control_api_local')
          )
        );

        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS identity_issuer TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS operator_user_id UUID NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS delegated_actor_sub TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS resource_aud TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS effective_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS token_exchange_id UUID NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS authorization_decision TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS decision_actor_sub TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS approval_request_id UUID NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS target_identity_issuer TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS target_human_sub TEXT NULL;
        ALTER TABLE administrative_events
          ADD COLUMN IF NOT EXISTS target_user_id UUID NULL;

        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_action_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_action_check
          CHECK (action IN (
            'agent_mutation', 'host_mutation', 'permission_grant', 'permission_revoke',
            'delegated_resource_mutation', 'folder_mutation', 'resource_mutation',
            'configuration_mutation', 'service_maintenance', 'control_admin_deleted'
          ));
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_target_type_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_target_type_check
          CHECK (target_type IN (
            'agent', 'host', 'permission', 'delegated_resource', 'folder', 'resource',
            'configuration', 'service', 'control_admin'
          ));

        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_identity_issuer_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_identity_issuer_check
          CHECK (identity_issuer IS NULL OR char_length(identity_issuer) <= 512);
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_delegated_actor_sub_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_delegated_actor_sub_check
          CHECK (delegated_actor_sub IS NULL OR char_length(delegated_actor_sub) <= 256);
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_resource_aud_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_resource_aud_check
          CHECK (resource_aud IS NULL OR char_length(resource_aud) <= 512);
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_effective_scopes_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_effective_scopes_check
          CHECK (governed_trace_sorted_unique_text_array(effective_scopes));
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_target_identity_issuer_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_target_identity_issuer_check
          CHECK (target_identity_issuer IS NULL OR char_length(target_identity_issuer) <= 512);
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_target_human_sub_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_target_human_sub_check
          CHECK (target_human_sub IS NULL OR char_length(target_human_sub) <= 256);
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_authorization_decision_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_authorization_decision_check
          CHECK (authorization_decision IS NULL OR authorization_decision IN ('allow', 'deny', 'require_approval', 'not_applicable'));
        ALTER TABLE administrative_events
          DROP CONSTRAINT IF EXISTS administrative_events_decision_actor_sub_check;
        ALTER TABLE administrative_events
          ADD CONSTRAINT administrative_events_decision_actor_sub_check
          CHECK (decision_actor_sub IS NULL OR char_length(decision_actor_sub) <= 256);

        CREATE INDEX IF NOT EXISTS idx_governed_run_binding_session
          ON governed_run_attribution_bindings (host_ref, session_id, created_at DESC, run_id);
        CREATE INDEX IF NOT EXISTS idx_governed_run_binding_human
          ON governed_run_attribution_bindings (user_id, created_at DESC)
          WHERE user_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_governed_prompt_history_expiry
          ON governed_approval_prompt_history (expires_at, approval_request_id);
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_session_replay
          ON agent_run_events (host_ref, session_id, occurred_at DESC, ingest_sequence DESC)
          WHERE host_ref IS NOT NULL AND session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_session_window
          ON agent_run_events (occurred_at DESC, host_ref, session_id, ingest_sequence DESC)
          WHERE host_ref IS NOT NULL AND session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_tool_session_filter
          ON agent_run_events ((payload_metadata->>'tool_name'), occurred_at DESC, host_ref, session_id)
          WHERE event_type = 'tool_call' AND host_ref IS NOT NULL AND session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_approval_session_filter
          ON agent_run_events (outcome, decision, occurred_at DESC, host_ref, session_id)
          WHERE event_type = 'approval' AND host_ref IS NOT NULL AND session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_administrative_events_list_filter
          ON administrative_events (action, outcome, occurred_at DESC, event_id);
        CREATE INDEX IF NOT EXISTS idx_infrastructure_telemetry_list_filter
          ON infrastructure_telemetry_events
             (telemetry_type, outcome, occurred_at DESC, event_id);
        CREATE INDEX IF NOT EXISTS idx_administrative_events_operator_user
          ON administrative_events (operator_user_id, occurred_at DESC)
          WHERE operator_user_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_administrative_events_target_user
          ON administrative_events (target_user_id, occurred_at DESC)
          WHERE target_user_id IS NOT NULL;

        CREATE OR REPLACE FUNCTION governed_trace_enforce_append_only()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          IF TG_OP = 'DELETE'
             AND TG_TABLE_NAME IN (
               'agent_run_events', 'administrative_events',
               'infrastructure_telemetry_events', 'governed_event_stream',
               'infrastructure_cost_daily_components', 'infrastructure_cost_daily',
               'governed_approval_prompt_history'
             )
             AND current_user = (
               SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID
             ) THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'governed trace relation % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
        END;
        $$;

        DROP TRIGGER IF EXISTS governed_run_attribution_bindings_append_only
          ON governed_run_attribution_bindings;
        CREATE TRIGGER governed_run_attribution_bindings_append_only
          BEFORE UPDATE OR DELETE ON governed_run_attribution_bindings
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS governed_run_attribution_bindings_reject_truncate
          ON governed_run_attribution_bindings;
        CREATE TRIGGER governed_run_attribution_bindings_reject_truncate
          BEFORE TRUNCATE ON governed_run_attribution_bindings
          FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();
        DROP TRIGGER IF EXISTS governed_approval_prompt_history_append_only
          ON governed_approval_prompt_history;
        CREATE TRIGGER governed_approval_prompt_history_append_only
          BEFORE UPDATE OR DELETE ON governed_approval_prompt_history
          FOR EACH ROW EXECUTE FUNCTION governed_trace_enforce_append_only();
        DROP TRIGGER IF EXISTS governed_approval_prompt_history_reject_truncate
          ON governed_approval_prompt_history;
        CREATE TRIGGER governed_approval_prompt_history_reject_truncate
          BEFORE TRUNCATE ON governed_approval_prompt_history
          FOR EACH STATEMENT EXECUTE FUNCTION governed_trace_reject_truncate();

        CREATE OR REPLACE FUNCTION governed_trace_prune_expired_prompts(batch_limit INTEGER DEFAULT 250)
        RETURNS TABLE (approval_request_id UUID)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          IF batch_limit NOT BETWEEN 1 AND 250 THEN
            RAISE EXCEPTION 'governed prompt retention batch must be between 1 and 250';
          END IF;
          RETURN QUERY
          WITH selected AS MATERIALIZED (
            SELECT history.approval_request_id
              FROM public.governed_approval_prompt_history AS history
             WHERE history.expires_at <= clock_timestamp()
             ORDER BY history.expires_at, history.approval_request_id
             LIMIT batch_limit
             FOR UPDATE OF history SKIP LOCKED
          )
          DELETE FROM public.governed_approval_prompt_history AS history
           USING selected
           WHERE history.approval_request_id = selected.approval_request_id
          RETURNING history.approval_request_id;
        END;
        $$;

        CREATE OR REPLACE VIEW governed_event_read_v1 AS
          SELECT
            stream.stream_sequence, stream.event_family, events.event_id,
            events.ingest_sequence AS family_ingest_sequence, events.occurred_at,
            events.ingested_at, events.schema_version, events.run_id::TEXT AS correlation_ref,
            'agent'::TEXT AS actor_kind, events.agent_sub AS actor_sub,
            events.source_service AS service_or_agent_ref,
            events.actor_human_sub AS initiating_human_sub, events.agent_sub AS acting_agent_sub,
            events.resource_aud, events.effective_scopes,
            events.decision AS authorization_decision,
            events.token_exchange_id::TEXT AS token_exchange_id, events.event_type,
            events.outcome, events.host_ref AS target_ref, events.payload_metadata AS safe_payload,
            'agent_run_events'::TEXT AS source_table, events.decision_actor_sub,
            events.identity_issuer, events.user_id::TEXT AS operator_user_id,
            NULL::TEXT AS delegated_actor_sub, NULL::TEXT AS target_identity_issuer,
            NULL::TEXT AS target_human_sub, NULL::TEXT AS target_user_id
          FROM governed_event_stream AS stream
          JOIN agent_run_events AS events
            ON stream.event_family = 'agent_run' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence, stream.event_family, events.event_id,
            events.ingest_sequence, events.occurred_at, events.ingested_at,
            events.schema_version,
            COALESCE(events.operation_id::TEXT, events.request_id, events.correlation_id),
            CASE WHEN events.operator_sub IS NULL THEN 'service' ELSE 'operator' END,
            COALESCE(events.operator_sub, events.service_sub), events.source_service,
            events.operator_sub, events.delegated_actor_sub, events.resource_aud,
            events.effective_scopes, events.authorization_decision, events.token_exchange_id::TEXT,
            events.action, events.outcome, events.target_ref, events.payload_metadata,
            'administrative_events'::TEXT, events.decision_actor_sub, events.identity_issuer,
            events.operator_user_id::TEXT, events.delegated_actor_sub,
            events.target_identity_issuer, events.target_human_sub, events.target_user_id::TEXT
          FROM governed_event_stream AS stream
          JOIN administrative_events AS events
            ON stream.event_family = 'administrative' AND stream.event_id = events.event_id
          UNION ALL
          SELECT
            stream.stream_sequence, stream.event_family, events.event_id,
            events.ingest_sequence, events.occurred_at, events.ingested_at,
            events.schema_version, COALESCE(events.workload_ref, events.interval_start::TEXT),
            'controller'::TEXT, events.source_service, events.source_service,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, ARRAY[]::TEXT[], NULL::TEXT,
            NULL::TEXT, events.telemetry_type, events.outcome, events.workload_ref,
            events.payload_metadata, 'infrastructure_telemetry_events'::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT
          FROM governed_event_stream AS stream
          JOIN infrastructure_telemetry_events AS events
            ON stream.event_family = 'infrastructure_telemetry' AND stream.event_id = events.event_id;

        REVOKE ALL ON TABLE governed_run_attribution_bindings, governed_approval_prompt_history FROM PUBLIC;
        REVOKE UPDATE, DELETE, TRUNCATE ON TABLE governed_run_attribution_bindings, governed_approval_prompt_history FROM control_api_runtime;
        GRANT SELECT, INSERT ON TABLE governed_run_attribution_bindings TO control_api_runtime;
        GRANT SELECT, INSERT ON TABLE governed_approval_prompt_history TO control_api_runtime;
        REVOKE ALL ON TABLE governed_run_attribution_bindings, governed_approval_prompt_history FROM trace_maintenance_runtime, workflow_recipes_runtime;
        REVOKE ALL ON FUNCTION governed_trace_prune_expired_prompts(INTEGER) FROM PUBLIC, control_api_runtime, workflow_recipes_runtime;
        GRANT EXECUTE ON FUNCTION governed_trace_prune_expired_prompts(INTEGER) TO trace_maintenance_runtime;
      `)
    },
  },
  {
    version: '0066_governed_trace_target_principal_projection',
    legacyVersions: ['0060_governed_trace_target_principal_projection'],
    apply: async db => {
      await db.query(`
        CREATE OR REPLACE FUNCTION governed_trace_safe_metadata(value JSONB)
        RETURNS BOOLEAN
        LANGUAGE sql
        IMMUTABLE
        AS $$
          SELECT jsonb_typeof(value) = 'object'
             AND octet_length(value::text) <= 16384
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(value) AS key_name
                WHERE key_name NOT IN (
                  'reason_code', 'error_class', 'phase', 'state', 'status',
                  'transition', 'resource_class', 'unit', 'provider_ref',
                  'summary', 'detail_ref', 'target_label', 'target_principal_kind',
                  'target_principal_ref', 'tool_name', 'tool_kind',
                  'tool_source_ref', 'model', 'attempt', 'count', 'config_hash'
                )
             )
             AND (
               NOT (value ? 'tool_kind')
               OR (
                 jsonb_typeof(value->'tool_kind') = 'string'
                 AND value->>'tool_kind' IN ('internal_tool', 'mcp_server_tool', 'workflow')
               )
             )
             AND (
               NOT (value ? 'target_label')
               OR (
                 jsonb_typeof(value->'target_label') = 'string'
                 AND value->>'target_label' ~ '^[A-Za-z0-9._-]{3,64}$'
               )
             )
             AND (
               NOT (value ? 'target_principal_kind')
               OR (
                 jsonb_typeof(value->'target_principal_kind') = 'string'
                 AND value->>'target_principal_kind' IN ('operator', 'host', 'context', 'service')
               )
             )
             AND (
               NOT (value ? 'target_principal_ref')
               OR (
                 jsonb_typeof(value->'target_principal_ref') = 'string'
                 AND char_length(value->>'target_principal_ref') BETWEEN 1 AND 256
                 AND value->>'target_principal_ref' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
               )
             )
             AND (
               (NOT (value ? 'target_principal_kind') AND NOT (value ? 'target_principal_ref'))
               OR (
                 value ? 'target_principal_kind'
                 AND value ? 'target_principal_ref'
                 AND (
                   (value->>'target_principal_kind' = 'operator'
                    AND value->>'target_principal_ref' = 'operator:')
                   OR
                   (value->>'target_principal_kind' <> 'operator'
                    AND value->>'target_principal_ref' LIKE ((value->>'target_principal_kind') || ':%'))
                 )
               )
             )
             AND (
               NOT (value ? 'tool_source_ref')
               OR (
                 jsonb_typeof(value->'tool_source_ref') = 'string'
                 AND char_length(value->>'tool_source_ref') BETWEEN 1 AND 128
               )
             );
        $$;
      `)
    },
  },
  {
    version: '0067_llm_runtime_access_profiles',
    apply: async db => {
      // The LLM catalog migrations can land after a database has already applied
      // the legacy runtime-role migration. Reconcile these three relations in a
      // new version so upgraded and fresh databases receive the same exact ACLs.
      await db.query(`
        REVOKE ALL ON TABLE
          llm_allowed_models,
          llm_allowed_models_audit,
          llm_catalog_sync_runs
          FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;

        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
          llm_allowed_models
          TO control_api_runtime;
        GRANT SELECT, INSERT ON TABLE
          llm_allowed_models_audit,
          llm_catalog_sync_runs
          TO control_api_runtime;
      `)
    },
  },
  {
    version: '0068_member_registration_credentials',
    apply: applyMemberRegistrationCredentialsSchema,
  },
  {
    version: '0069_member_registration_runtime_access',
    apply: async db => {
      // 0068 can already be applied on a long-lived database, so normalize the
      // new table's ACL in a follow-up migration instead of rewriting history.
      await db.query(`
        REVOKE ALL ON TABLE member_registration_credentials
          FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_registration_credentials
          TO control_api_runtime;
        REVOKE ALL ON SEQUENCE member_registration_credentials_id_seq
          FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;
        GRANT USAGE, SELECT ON SEQUENCE member_registration_credentials_id_seq
          TO control_api_runtime;
      `)
    },
  },
  {
    version: '0070_member_registration_runtime_delete_revoke',
    apply: async db => {
      // 0069 granted DELETE to the runtime role. Credential revocation is an
      // UPDATE, so remove the unnecessary destructive privilege without
      // rewriting a migration that may already be recorded in deployed DBs.
      await db.query(`
        REVOKE DELETE ON TABLE member_registration_credentials
          FROM control_api_runtime;
      `)
    },
  },
  {
    version: '0071_gfs_immutable_blob_generations',
    apply: async db => {
      await db.query(`
        ALTER TABLE gfs_resources
          ADD COLUMN IF NOT EXISTS blob_key TEXT NULL,
          ADD COLUMN IF NOT EXISTS content_sha256 TEXT NULL;

        DO $$ BEGIN
          ALTER TABLE gfs_resources
            ADD CONSTRAINT gfs_resources_blob_metadata_pair
            CHECK ((blob_key IS NULL AND content_sha256 IS NULL)
                OR (blob_key ~ '^[0-9a-f]{32}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND split_part(blob_key, '/', 1) = replace(resource_id::text, '-', '')
                    AND content_sha256 ~ '^[0-9a-f]{64}$'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        CREATE UNIQUE INDEX IF NOT EXISTS gfs_resources_blob_key_uniq
          ON gfs_resources (blob_key)
          WHERE blob_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS gfs_blob_manifests (
          blob_key TEXT PRIMARY KEY,
          request_id UUID NOT NULL,
          resource_id UUID NOT NULL,
          candidate_kind TEXT NOT NULL DEFAULT 'generation'
            CHECK (candidate_kind IN ('generation', 'legacy_flat')),
          content_sha256 TEXT NULL,
          bytes BIGINT NOT NULL CHECK (bytes >= 0),
          state TEXT NOT NULL CHECK (state IN ('staged', 'committed', 'deleting')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT gfs_blob_manifests_blob_key_valid CHECK (
            (candidate_kind = 'generation'
             AND blob_key ~ '^[0-9a-f]{32}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND split_part(blob_key, '/', 1) = replace(resource_id::text, '-', '')
             AND content_sha256 ~ '^[0-9a-f]{64}$')
            OR
            (candidate_kind = 'legacy_flat'
             AND blob_key = replace(resource_id::text, '-', '')
             AND content_sha256 IS NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS gfs_blob_manifests_cleanup_idx
          ON gfs_blob_manifests (state, updated_at, blob_key);

        DROP TRIGGER IF EXISTS gfs_resources_perm_invalidate ON gfs_resources;
        CREATE TRIGGER gfs_resources_perm_invalidate
          AFTER UPDATE OF parent_resource_id, name, path_cache, deleted_at
          OR DELETE OR TRUNCATE ON gfs_resources
          FOR EACH STATEMENT EXECUTE FUNCTION gfs_notify_perm_invalidate();

        GRANT SELECT, INSERT, UPDATE, DELETE ON gfs_blob_manifests TO gfs_controller;
        GRANT SELECT (blob_key, content_sha256) ON gfs_resources TO gfs_controller;
      `)
    },
  },
  {
    version: '0072_gfs_reader_database_role',
    apply: async db => {
      await db.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gfs_controller_reader') THEN
            CREATE ROLE gfs_controller_reader NOLOGIN;
          END IF;
        END
        $$;

        ALTER ROLE gfs_controller_reader
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

        DO $$
        DECLARE inherited_role RECORD;
        BEGIN
          FOR inherited_role IN
            SELECT granted.rolname
              FROM pg_auth_members membership
              JOIN pg_roles granted ON granted.oid = membership.roleid
              JOIN pg_roles member_role ON member_role.oid = membership.member
             WHERE member_role.rolname = 'gfs_controller_reader'
          LOOP
            EXECUTE format('REVOKE %I FROM gfs_controller_reader', inherited_role.rolname);
          END LOOP;
        END
        $$;

        REVOKE ALL PRIVILEGES ON gfs_resources, gfs_grants, gfs_shares,
          gfs_blob_manifests, gfs_audit FROM gfs_controller_reader;
        REVOKE ALL PRIVILEGES ON SEQUENCE gfs_audit_sequence_no_seq FROM gfs_controller_reader;
        REVOKE ALL PRIVILEGES ON control_admin_users, team_members FROM gfs_controller_reader;

        GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller_reader;
        GRANT SELECT (id, status) ON control_admin_users TO gfs_controller_reader;
        GRANT SELECT (team_id, user_id, status) ON team_members TO gfs_controller_reader;
        GRANT INSERT ON gfs_audit TO gfs_controller_reader;
        GRANT USAGE, SELECT ON SEQUENCE gfs_audit_sequence_no_seq TO gfs_controller_reader;

        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_resources FROM gfs_controller_reader;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_grants FROM gfs_controller_reader;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gfs_shares FROM gfs_controller_reader;
        REVOKE ALL PRIVILEGES ON gfs_blob_manifests FROM gfs_controller_reader;
        REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit FROM gfs_controller_reader;
      `)
    },
  },
  {
    version: '0073_gfs_audit_decision_evidence',
    apply: async db => {
      await db.query(`
        ALTER TABLE gfs_audit
          ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'legacy',
          ADD COLUMN IF NOT EXISTS matched_subject TEXT NULL,
          ADD COLUMN IF NOT EXISTS authorization_source TEXT NULL,
          ADD COLUMN IF NOT EXISTS cached_authorization_source TEXT NULL,
          ADD COLUMN IF NOT EXISTS mutation_outcome TEXT NULL;

        DO $$ BEGIN
          ALTER TABLE gfs_audit
            ADD CONSTRAINT gfs_audit_record_type_valid
            CHECK (record_type IN ('legacy', 'authorization_decision', 'mutation_outcome'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        DO $$ BEGIN
          ALTER TABLE gfs_audit
            ADD CONSTRAINT gfs_audit_authorization_source_valid
            CHECK (authorization_source IS NULL OR authorization_source IN (
              'direct_grant', 'inherited_grant', 'direct_share',
              'inherited_share', 'operator', 'cache'
            ));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        DO $$ BEGIN
          ALTER TABLE gfs_audit
            ADD CONSTRAINT gfs_audit_cached_authorization_source_valid
            CHECK (
              (authorization_source = 'cache'
                AND cached_authorization_source IS NOT NULL
                AND cached_authorization_source IN (
                  'direct_grant', 'inherited_grant', 'direct_share',
                  'inherited_share', 'operator'
                ))
              OR
              (authorization_source IS DISTINCT FROM 'cache'
                AND cached_authorization_source IS NULL)
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        DO $$ BEGIN
          ALTER TABLE gfs_audit
            ADD CONSTRAINT gfs_audit_mutation_outcome_valid
            CHECK (mutation_outcome IS NULL OR mutation_outcome IN ('succeeded', 'failed'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        DO $$ BEGIN
          ALTER TABLE gfs_audit
            ADD CONSTRAINT gfs_audit_record_type_fields_valid
            CHECK (
              (record_type = 'legacy' AND mutation_outcome IS NULL)
              OR
              (record_type = 'authorization_decision' AND mutation_outcome IS NULL)
              OR
              (record_type = 'mutation_outcome' AND mutation_outcome IS NOT NULL)
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        GRANT INSERT ON gfs_audit TO gfs_controller, gfs_controller_reader;
        GRANT USAGE, SELECT ON SEQUENCE gfs_audit_sequence_no_seq
          TO gfs_controller, gfs_controller_reader;
        REVOKE UPDATE, DELETE, TRUNCATE ON gfs_audit
          FROM gfs_controller, gfs_controller_reader;
      `)
    },
  },
  {
    version: '0074_gfs_runtime_role_exact_contract',
    apply: async db => {
      await db.query(`
        -- Reconcile existing clusters without changing credential state.
        -- Deploy provisioning remains the sole credential-state owner.
        ALTER ROLE gfs_controller
          NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        ALTER ROLE gfs_controller_reader
          NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

        DO $$
        DECLARE runtime_role TEXT;
        DECLARE inherited_role RECORD;
        BEGIN
          FOREACH runtime_role IN ARRAY ARRAY['gfs_controller', 'gfs_controller_reader']
          LOOP
            FOR inherited_role IN
              SELECT granted.rolname
                FROM pg_auth_members membership
                JOIN pg_roles granted ON granted.oid = membership.roleid
                JOIN pg_roles member_role ON member_role.oid = membership.member
               WHERE member_role.rolname = runtime_role
            LOOP
              EXECUTE format('REVOKE %I FROM %I', inherited_role.rolname, runtime_role);
            END LOOP;
          END LOOP;
        END
        $$;

        -- Table-level REVOKE does not erase column ACLs in PostgreSQL. Clear
        -- every column privilege explicitly before rebuilding the envelope.
        DO $$
        DECLARE protected_column RECORD;
        BEGIN
          FOR protected_column IN
            SELECT table_name, column_name
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = ANY(ARRAY[
                 'gfs_resources', 'gfs_grants', 'gfs_shares',
                 'gfs_blob_manifests', 'gfs_audit',
                 'control_admin_users', 'team_members'
               ])
          LOOP
            EXECUTE format(
              'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$I FROM gfs_controller, gfs_controller_reader, PUBLIC',
              protected_column.column_name,
              protected_column.table_name
            );
          END LOOP;
        END
        $$;

        -- Remove historical or manually-added grants before rebuilding the
        -- exact writer and reader envelopes. PUBLIC receives no GFS access.
        REVOKE ALL PRIVILEGES ON gfs_resources, gfs_grants, gfs_shares,
          gfs_blob_manifests, gfs_audit FROM gfs_controller, gfs_controller_reader, PUBLIC;
        REVOKE ALL PRIVILEGES ON SEQUENCE gfs_audit_sequence_no_seq
          FROM gfs_controller, gfs_controller_reader, PUBLIC;
        REVOKE ALL PRIVILEGES ON control_admin_users, team_members
          FROM gfs_controller, gfs_controller_reader;
        REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON control_admin_users, team_members
          FROM PUBLIC;

        GRANT SELECT, INSERT, UPDATE ON gfs_resources TO gfs_controller;
        GRANT SELECT ON gfs_grants, gfs_shares TO gfs_controller;
        GRANT SELECT, INSERT, UPDATE, DELETE ON gfs_blob_manifests TO gfs_controller;
        GRANT INSERT ON gfs_audit TO gfs_controller;
        GRANT USAGE, SELECT ON SEQUENCE gfs_audit_sequence_no_seq TO gfs_controller;

        GRANT SELECT ON gfs_resources, gfs_grants, gfs_shares TO gfs_controller_reader;
        GRANT INSERT ON gfs_audit TO gfs_controller_reader;
        GRANT USAGE, SELECT ON SEQUENCE gfs_audit_sequence_no_seq TO gfs_controller_reader;

        -- Subject resolution is deliberately column-scoped for both roles.
        GRANT SELECT (id, status) ON control_admin_users
          TO gfs_controller, gfs_controller_reader;
        GRANT SELECT (team_id, user_id, status) ON team_members
          TO gfs_controller, gfs_controller_reader;
      `)
    },
  },
  {
    version: '0075_plugin_workload_sdk_prompt_target_policy',
    apply: addPluginWorkloadSdkPromptTargetPolicyColumns,
  },
  {
    version: '0076_plugin_workload_sdk_jit_credential_tickets',
    apply: addPluginWorkloadSdkJitCredentialTicketColumns,
  },
  {
    version: '0077_plugin_workload_sdk_usage_attribution',
    apply: addPromptBridgeUsageMetadataColumn,
  },
  {
    version: '0078_plugin_workload_sdk_attempt_ledger',
    apply: addPluginWorkloadSdkAttemptLedgerColumns,
  },
  {
    version: '0079_plugin_workload_sdk_usage_source_kind',
    apply: addPluginWorkloadSdkUsageSourceKind,
  },
  {
    version: '0080_plugin_workload_sdk_protocol_revocation',
    apply: addPluginWorkloadSdkProtocolAndRevocation,
  },
  {
    version: '0081_plugin_workload_sdk_provider_attempt_ledger',
    apply: addPluginWorkloadSdkProviderAttemptLedger,
  },
  {
    version: '0082_plugin_workload_sdk_revocation_epoch',
    apply: addPluginWorkloadSdkRevocationEpoch,
  },
  {
    version: '0083_plugin_workload_sdk_runtime_access',
    apply: addPluginWorkloadSdkRuntimeAccess,
  },
  {
    version: '0084_plugin_workload_sdk_spend_outcome_ledger',
    apply: addPluginWorkloadSdkSpendOutcomeLedger,
  },
  {
    version: '0085_plugin_workload_sdk_spend_outcome_host_ref_nullable',
    apply: relaxPluginWorkloadSdkSpendOutcomeHostRef,
  },
  {
    version: '0086_plugin_workload_sdk_legacy_policy_repair',
    apply: repairPluginWorkloadSdkLegacyGrantPolicies,
  },
  {
    version: '0087_plugin_workload_sdk_not_executed_spend_outcome',
    apply: addPluginWorkloadSdkNotExecutedSpendOutcome,
  },
  {
    version: '0088_plugin_workload_sdk_policy_review_provenance',
    apply: addPluginWorkloadSdkPolicyReviewProvenance,
  },
  {
    version: '0089_plugin_workload_sdk_credential_ticket_runtime_access',
    apply: addPluginWorkloadSdkCredentialTicketRuntimeAccess,
  },
  {
    version: '0090_plugin_workload_sdk_runtime_contract_reconciliation',
    apply: reconcilePluginWorkloadSdkRuntimeContracts,
  },
  {
    version: '0091_gfs_desktop_operator_links',
    apply: applyGfsDesktopOperatorLinksSchema,
  },
  {
    version: '0092_gfs_audit_actor_correlation',
    apply: applyGfsAuditActorCorrelationSchema,
  },
  {
    version: '0093_gfs_desktop_operator_link_generations',
    apply: evolveGfsDesktopOperatorLinksToGenerations,
  },
  {
    version: '0094_desktop_user_retirement_lifecycle',
    apply: applyDesktopUserRetirementLifecycleSchema,
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
    if (migration.legacyVersions?.some(version => appliedVersions.has(version))) {
      await recordMigration(db, migration.version)
      appliedVersions.add(migration.version)
      continue
    }
    await migration.apply(db)
    await recordMigration(db, migration.version)
    appliedVersions.add(migration.version)
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

export async function assertDbReady(db: DbClient = pool): Promise<void> {
  const requiredVersion = CONTROL_API_MIGRATIONS.at(-1)?.version
  if (!requiredVersion) throw new Error('Control API database has no registered migrations')
  const result = await db.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS ready',
    [requiredVersion]
  )
  if (!(result.rows[0] as { ready?: boolean } | undefined)?.ready) {
    throw new Error(`Control API database is not ready: migration ${requiredVersion} is required`)
  }
}

export async function withTransaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as PoolClient
  let transactionStarted = false
  let commitSent = false
  let releaseError: Error | boolean | undefined
  try {
    await client.query('BEGIN')
    transactionStarted = true
    const result = await work(client)
    commitSent = true
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (commitSent || !transactionStarted) {
      releaseError = error instanceof Error ? error : true
    } else {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : true
      }
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}

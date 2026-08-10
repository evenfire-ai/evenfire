import type { DbClient } from '../../db.js'

export async function applyUserSessionAccessFoundation(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS external_user_sessions (
      sid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
      current_jti UUID NOT NULL,
      current_issued_at TIMESTAMPTZ NOT NULL,
      prior_jti UUID,
      prior_jti_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      idle_expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason TEXT,
      authentication_methods TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      authenticated_at TIMESTAMPTZ NOT NULL,
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK (
        (prior_jti IS NULL AND prior_jti_expires_at IS NULL)
        OR (prior_jti IS NOT NULL AND prior_jti_expires_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS external_user_sessions_user_live_idx
      ON external_user_sessions (user_id, revoked_at, absolute_expires_at);
    CREATE INDEX IF NOT EXISTS external_user_sessions_idle_idx
      ON external_user_sessions (idle_expires_at)
      WHERE revoked_at IS NULL;

    CREATE INDEX IF NOT EXISTS team_members_user_active_idx
      ON team_members (user_id, status, team_id) INCLUDE (role, updated_at);
    CREATE INDEX IF NOT EXISTS user_contexts_context_user_idx
      ON user_contexts (context_id, user_id);
    CREATE INDEX IF NOT EXISTS team_contexts_context_team_idx
      ON team_contexts (context_id, team_id);
    CREATE INDEX IF NOT EXISTS user_agents_agent_user_idx
      ON user_agents (agent_name, user_id);
    CREATE INDEX IF NOT EXISTS team_agents_agent_team_idx
      ON team_agents (agent_name, team_id);
    CREATE INDEX IF NOT EXISTS user_workflow_triggers_recipe_user_idx
      ON user_workflow_triggers (recipe_namespace, recipe_name, user_id);
    CREATE INDEX IF NOT EXISTS team_workflow_triggers_recipe_team_idx
      ON team_workflow_triggers (recipe_namespace, recipe_name, team_id);

    CREATE TABLE IF NOT EXISTS authorization_user_revisions (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS authorization_team_revisions (
      team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS authorization_resource_revisions (
      environment_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (environment_id, resource_type, resource_id)
    );

    CREATE OR REPLACE FUNCTION authorization_bump_user_revision(target_user_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_user_revisions(user_id, revision, updated_at)
      VALUES(target_user_id, 1, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET revision = authorization_user_revisions.revision + 1,
            updated_at = NOW();
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_revision(target_team_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_team_revisions(team_id, revision, updated_at)
      VALUES(target_team_id, 1, NOW())
      ON CONFLICT (team_id) DO UPDATE
        SET revision = authorization_team_revisions.revision + 1,
            updated_at = NOW();
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_membership_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_user_revision(NEW.user_id);
        PERFORM authorization_bump_team_revision(NEW.team_id);
      END IF;
      IF TG_OP <> 'INSERT' AND
         (TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id
          OR OLD.team_id IS DISTINCT FROM NEW.team_id) THEN
        PERFORM authorization_bump_user_revision(OLD.user_id);
        PERFORM authorization_bump_team_revision(OLD.team_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_user_grant_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_user_revision(NEW.user_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
        PERFORM authorization_bump_user_revision(OLD.user_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_grant_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_team_revision(NEW.team_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.team_id IS DISTINCT FROM NEW.team_id) THEN
        PERFORM authorization_bump_team_revision(OLD.team_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_members_authorization_revision') THEN
        CREATE TRIGGER team_members_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON team_members
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_team_membership_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_contexts_authorization_revision') THEN
        CREATE TRIGGER user_contexts_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON user_contexts
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_user_grant_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_agents_authorization_revision') THEN
        CREATE TRIGGER user_agents_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON user_agents
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_user_grant_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_workflow_authorization_revision') THEN
        CREATE TRIGGER user_workflow_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON user_workflow_triggers
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_user_grant_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_contexts_authorization_revision') THEN
        CREATE TRIGGER team_contexts_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON team_contexts
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_team_grant_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_agents_authorization_revision') THEN
        CREATE TRIGGER team_agents_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON team_agents
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_team_grant_revision();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_workflow_authorization_revision') THEN
        CREATE TRIGGER team_workflow_authorization_revision
        AFTER INSERT OR UPDATE OR DELETE ON team_workflow_triggers
        FOR EACH ROW EXECUTE FUNCTION authorization_bump_team_grant_revision();
      END IF;
    END;
    $$;
  `)
}

export async function applyLegacySessionRevocationFoundation(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS external_user_session_security_epochs (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      valid_after TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS external_v1_session_revocations (
      token_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_user_idx
      ON external_v1_session_revocations (user_id, expires_at);
    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_expiry_idx
      ON external_v1_session_revocations (expires_at);
  `)
}

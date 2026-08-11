import type { DbClient } from '../../db.js'

/**
 * Additive persistence foundation for user-session v2 and user-centric access.
 *
 * The operational tables intentionally contain provider state only. They do
 * not materialize a user's effective access and are never final action
 * authority. Relist staging is separate so an indexer can promote a complete
 * generation in one transaction without exposing a half-reconciled list.
 */
export async function applyUserAccessFoundationSchema(db: DbClient): Promise<void> {
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
      ON external_user_sessions (user_id, absolute_expires_at, idle_expires_at)
      WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS external_user_sessions_idle_idx
      ON external_user_sessions (idle_expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS external_user_session_security_epochs (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      valid_after TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS external_v1_session_revocations (
      token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_user_idx
      ON external_v1_session_revocations (user_id, expires_at);
    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_expiry_idx
      ON external_v1_session_revocations (expires_at);

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
      PRIMARY KEY (environment_id, resource_type, resource_id),
      CHECK (environment_id <> '' AND resource_type <> '' AND resource_id <> '')
    );
    CREATE INDEX IF NOT EXISTS authorization_resource_revisions_updated_idx
      ON authorization_resource_revisions (environment_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS operational_catalog_source_state (
      environment_id TEXT NOT NULL,
      source_family TEXT NOT NULL,
      generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
      staging_generation BIGINT CHECK (staging_generation > generation),
      resource_version TEXT,
      status TEXT NOT NULL DEFAULT 'relisting'
        CHECK (status IN ('current', 'relisting', 'unavailable')),
      last_success_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      safe_error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (environment_id, source_family),
      CHECK (environment_id <> '' AND source_family <> '')
    );

    CREATE TABLE IF NOT EXISTS operational_resource_index (
      environment_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      logical_id TEXT NOT NULL,
      source_family TEXT NOT NULL,
      source_generation BIGINT NOT NULL CHECK (source_generation > 0),
      provider_uid TEXT NOT NULL,
      provider_resource_version TEXT NOT NULL,
      display_name TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      deleted_at TIMESTAMPTZ,
      observed_generation BIGINT,
      content_bytes BIGINT NOT NULL CHECK (content_bytes >= 0),
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (environment_id, resource_type, logical_id),
      CHECK (
        environment_id <> '' AND resource_type <> '' AND logical_id <> ''
        AND source_family <> '' AND provider_uid <> ''
        AND provider_resource_version <> ''
      )
    );
    CREATE INDEX IF NOT EXISTS operational_resource_source_idx
      ON operational_resource_index (
        environment_id, source_family, source_generation, resource_type, logical_id
      );

    CREATE TABLE IF NOT EXISTS operational_resource_relationships (
      environment_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relationship_instance_id TEXT NOT NULL,
      behavior_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,
      source_family TEXT NOT NULL,
      source_provider_uid TEXT NOT NULL,
      source_resource_version TEXT NOT NULL,
      source_generation BIGINT NOT NULL CHECK (source_generation > 0),
      observed_generation BIGINT,
      content_bytes BIGINT NOT NULL CHECK (content_bytes >= 0),
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (
        environment_id, source_type, source_id, relationship_type,
        target_type, target_id, relationship_instance_id
      ),
      CHECK (jsonb_typeof(behavior_attributes) = 'object'),
      CHECK (
        environment_id <> '' AND source_type <> '' AND source_id <> ''
        AND relationship_type <> '' AND target_type <> '' AND target_id <> ''
        AND relationship_instance_id <> '' AND source_family <> ''
        AND source_provider_uid <> '' AND source_resource_version <> ''
      )
    );
    CREATE INDEX IF NOT EXISTS operational_relationship_source_idx
      ON operational_resource_relationships (
        environment_id, source_type, source_id, relationship_type,
        target_type, target_id, relationship_instance_id
      );
    CREATE INDEX IF NOT EXISTS operational_relationship_target_idx
      ON operational_resource_relationships (
        environment_id, target_type, target_id, source_type,
        source_id, relationship_instance_id
      );
    CREATE INDEX IF NOT EXISTS operational_relationship_generation_idx
      ON operational_resource_relationships (
        environment_id, source_family, source_generation, source_type, source_id
      );

    CREATE TABLE IF NOT EXISTS operational_resource_index_staging
      (LIKE operational_resource_index INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    CREATE UNIQUE INDEX IF NOT EXISTS operational_resource_staging_identity_idx
      ON operational_resource_index_staging (
        environment_id, source_family, source_generation, resource_type, logical_id
      );

    CREATE TABLE IF NOT EXISTS operational_relationships_staging
      (LIKE operational_resource_relationships INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    CREATE UNIQUE INDEX IF NOT EXISTS operational_relationship_staging_identity_idx
      ON operational_relationships_staging (
        environment_id, source_family, source_generation, source_type, source_id,
        relationship_type, target_type, target_id, relationship_instance_id
      );

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

    CREATE INDEX IF NOT EXISTS workflow_runs_actor_catalog_idx
      ON workflow_runs (actor_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, team_id, usage_team_id)
      WHERE actor_type = 'user' AND actor_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS workflow_runs_team_catalog_idx
      ON workflow_runs (team_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, actor_type, actor_id, usage_team_id)
      WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS workflow_runs_usage_team_catalog_idx
      ON workflow_runs (usage_team_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, actor_type, actor_id, team_id)
      WHERE usage_team_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS workflow_approval_user_catalog_idx
      ON workflow_approval_requests (target_user_id, id)
      INCLUDE (status, expires_at, recipe_namespace, recipe_name)
      WHERE target_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS workflow_approval_team_catalog_idx
      ON workflow_approval_requests (target_team_id, id)
      INCLUDE (status, expires_at, recipe_namespace, recipe_name)
      WHERE target_team_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS notification_user_catalog_idx
      ON notification_deliveries ((audience->>'userId'), id)
      INCLUDE (expires_at, status, event_type)
      WHERE audience ? 'userId';
    CREATE INDEX IF NOT EXISTS notification_team_catalog_idx
      ON notification_deliveries ((audience->>'teamId'), id)
      INCLUDE (expires_at, status, event_type)
      WHERE audience ? 'teamId';

    CREATE INDEX IF NOT EXISTS gfs_grants_subject_resource_catalog_idx
      ON gfs_grants (subject_type, subject_id, resource_id)
      INCLUDE (id, drive, permissions, inherit);
    CREATE INDEX IF NOT EXISTS gfs_shares_subject_resource_catalog_idx
      ON gfs_shares (subject_type, subject_id, resource_id)
      INCLUDE (id, drive, permissions, include_descendants);
  `)

  await applyAuthorizationRevisionFunctions(db)
  await applyAuthorizationRevisionTriggers(db)
  await applyUserAccessRuntimePrivileges(db)
}

async function applyAuthorizationRevisionFunctions(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION authorization_bump_user_revision(target_user_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_user_revisions(user_id, revision, updated_at)
      VALUES(target_user_id, 1, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
        SET revision = authorization_user_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_revision(target_team_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_team_revisions(team_id, revision, updated_at)
      VALUES(target_team_id, 1, clock_timestamp())
      ON CONFLICT (team_id) DO UPDATE
        SET revision = authorization_team_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_resource_revision(
      target_environment_id TEXT,
      target_resource_type TEXT,
      target_resource_id TEXT
    )
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_resource_revisions(
        environment_id, resource_type, resource_id, revision, updated_at
      )
      VALUES(target_environment_id, target_resource_type, target_resource_id, 1, clock_timestamp())
      ON CONFLICT (environment_id, resource_type, resource_id) DO UPDATE
        SET revision = authorization_resource_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;

    REVOKE ALL ON FUNCTION authorization_bump_user_revision(UUID) FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_team_revision(UUID) FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_resource_revision(TEXT, TEXT, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION authorization_bump_user_revision(UUID) TO control_api_runtime;
    GRANT EXECUTE ON FUNCTION authorization_bump_team_revision(UUID) TO control_api_runtime;
    GRANT EXECUTE ON FUNCTION authorization_bump_resource_revision(TEXT, TEXT, TEXT)
      TO control_api_runtime;
  `)
}

async function applyAuthorizationRevisionTriggers(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION authorization_bump_team_membership_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_user_revision(NEW.user_id);
        PERFORM authorization_bump_team_revision(NEW.team_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (
        TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.team_id IS DISTINCT FROM NEW.team_id
      ) THEN
        PERFORM authorization_bump_user_revision(OLD.user_id);
        PERFORM authorization_bump_team_revision(OLD.team_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_user_grant_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_user_revision(NEW.user_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (
        TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id
      ) THEN
        PERFORM authorization_bump_user_revision(OLD.user_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_grant_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_team_revision(NEW.team_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (
        TG_OP = 'DELETE' OR OLD.team_id IS DISTINCT FROM NEW.team_id
      ) THEN
        PERFORM authorization_bump_team_revision(OLD.team_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_operational_resource_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_resource_revision(
          NEW.environment_id, NEW.resource_type, NEW.logical_id
        );
      END IF;
      IF TG_OP <> 'INSERT' AND (
        TG_OP = 'DELETE'
        OR OLD.environment_id IS DISTINCT FROM NEW.environment_id
        OR OLD.resource_type IS DISTINCT FROM NEW.resource_type
        OR OLD.logical_id IS DISTINCT FROM NEW.logical_id
      ) THEN
        PERFORM authorization_bump_resource_revision(
          OLD.environment_id, OLD.resource_type, OLD.logical_id
        );
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_operational_relationship_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_resource_revision(
          NEW.environment_id, NEW.source_type, NEW.source_id
        );
        PERFORM authorization_bump_resource_revision(
          NEW.environment_id, NEW.target_type, NEW.target_id
        );
      END IF;
      IF TG_OP <> 'INSERT' THEN
        PERFORM authorization_bump_resource_revision(
          OLD.environment_id, OLD.source_type, OLD.source_id
        );
        PERFORM authorization_bump_resource_revision(
          OLD.environment_id, OLD.target_type, OLD.target_id
        );
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    DO $$
    DECLARE trigger_spec RECORD;
    BEGIN
      FOR trigger_spec IN
        SELECT * FROM (VALUES
          ('team_members', 'team_members_authorization_revision',
            'authorization_bump_team_membership_revision'),
          ('user_contexts', 'user_contexts_authorization_revision',
            'authorization_bump_user_grant_revision'),
          ('user_agents', 'user_agents_authorization_revision',
            'authorization_bump_user_grant_revision'),
          ('user_workflow_triggers', 'user_workflow_authorization_revision',
            'authorization_bump_user_grant_revision'),
          ('team_contexts', 'team_contexts_authorization_revision',
            'authorization_bump_team_grant_revision'),
          ('team_agents', 'team_agents_authorization_revision',
            'authorization_bump_team_grant_revision'),
          ('team_workflow_triggers', 'team_workflow_authorization_revision',
            'authorization_bump_team_grant_revision'),
          ('operational_resource_index', 'operational_resource_authorization_revision',
            'authorization_bump_operational_resource_revision'),
          ('operational_resource_relationships',
            'operational_relationship_authorization_revision',
            'authorization_bump_operational_relationship_revision')
        ) AS specs(table_name, trigger_name, function_name)
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = trigger_spec.trigger_name
        ) THEN
          EXECUTE format(
            'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
            || 'FOR EACH ROW EXECUTE FUNCTION %I()',
            trigger_spec.trigger_name,
            trigger_spec.table_name,
            trigger_spec.function_name
          );
        END IF;
      END LOOP;
    END;
    $$;

    REVOKE ALL ON FUNCTION authorization_bump_team_membership_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_user_grant_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_team_grant_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_operational_resource_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_operational_relationship_revision() FROM PUBLIC;
  `)
}

async function applyUserAccessRuntimePrivileges(db: DbClient): Promise<void> {
  await db.query(`
    REVOKE ALL PRIVILEGES ON TABLE
      external_user_sessions,
      external_user_session_security_epochs,
      external_v1_session_revocations,
      authorization_user_revisions,
      authorization_team_revisions,
      authorization_resource_revisions,
      operational_catalog_source_state,
      operational_resource_index,
      operational_resource_relationships,
      operational_resource_index_staging,
      operational_relationships_staging
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      external_user_sessions,
      external_user_session_security_epochs,
      external_v1_session_revocations,
      operational_catalog_source_state,
      operational_resource_index,
      operational_resource_relationships,
      operational_resource_index_staging,
      operational_relationships_staging
      TO control_api_runtime;

    GRANT SELECT, INSERT, UPDATE ON TABLE
      authorization_user_revisions,
      authorization_team_revisions,
      authorization_resource_revisions
      TO control_api_runtime;
  `)
}

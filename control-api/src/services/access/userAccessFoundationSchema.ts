import type { DbClient } from '../../db.js'
import { canonicalEnvironmentId } from './operationalAccessProjection.js'

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

    CREATE TABLE IF NOT EXISTS authorization_catalog_revision (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO authorization_catalog_revision(singleton)
    VALUES(TRUE)
    ON CONFLICT (singleton) DO NOTHING;

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
    CREATE INDEX IF NOT EXISTS operational_relationship_catalog_target_idx
      ON operational_resource_relationships (
        environment_id, target_type, relationship_type, target_id,
        source_type, source_id, relationship_instance_id
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
    CREATE INDEX IF NOT EXISTS user_workflow_triggers_catalog_key_idx
      ON user_workflow_triggers (
        user_id, ((recipe_namespace || '/'::text) || recipe_name)
      );
    CREATE INDEX IF NOT EXISTS team_workflow_triggers_catalog_key_idx
      ON team_workflow_triggers (
        ((recipe_namespace || '/'::text) || recipe_name), team_id
      );

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

/** Forward migration for D26A's exact UTF-8 byte ordering and supporting indexes. */
export async function applyCatalogUtf8OrderingSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION catalog_utf8_bytes(value TEXT)
    RETURNS BYTEA
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    AS $$
      SELECT convert_to(value, 'UTF8');
    $$;

    CREATE INDEX IF NOT EXISTS user_agents_catalog_utf8_idx
      ON user_agents (user_id, catalog_utf8_bytes(agent_name));
    CREATE INDEX IF NOT EXISTS team_agents_catalog_utf8_idx
      ON team_agents (catalog_utf8_bytes(agent_name), team_id);
    CREATE INDEX IF NOT EXISTS user_contexts_catalog_utf8_idx
      ON user_contexts (user_id, catalog_utf8_bytes(context_id));
    CREATE INDEX IF NOT EXISTS team_contexts_catalog_utf8_idx
      ON team_contexts (catalog_utf8_bytes(context_id), team_id);
    CREATE INDEX IF NOT EXISTS user_workflow_triggers_catalog_utf8_idx
      ON user_workflow_triggers (
        user_id,
        catalog_utf8_bytes(recipe_namespace || '/' || recipe_name)
      );
    CREATE INDEX IF NOT EXISTS team_workflow_triggers_catalog_utf8_idx
      ON team_workflow_triggers (
        catalog_utf8_bytes(recipe_namespace || '/' || recipe_name),
        team_id
      );
    CREATE INDEX IF NOT EXISTS operational_relationship_catalog_utf8_target_idx
      ON operational_resource_relationships (
        environment_id,
        target_type,
        relationship_type,
        catalog_utf8_bytes(target_id)
      );
  `)
}

/**
 * Replace the repository-wide catalog hot row with the transactional user,
 * team, resource, and operational-source revisions consumed by catalog reads.
 */
export async function applyComposableCatalogRevisionSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS authorization_catalog_environment (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      environment_id TEXT NOT NULL CHECK (environment_id <> '')
    );

    CREATE TABLE IF NOT EXISTS authorization_catalog_writer_components (
      writer_table TEXT PRIMARY KEY,
      component_class TEXT NOT NULL,
      rationale TEXT NOT NULL,
      CHECK (writer_table <> '' AND component_class <> '' AND rationale <> '')
    );

    INSERT INTO authorization_catalog_writer_components(writer_table, component_class, rationale)
    VALUES
      ('users', 'user', 'user identity and lifecycle'),
      ('teams', 'team', 'team identity'),
      ('team_members', 'user+team', 'membership and live role'),
      ('user_contexts', 'user', 'direct context access'),
      ('team_contexts', 'team', 'team context access'),
      ('user_agents', 'user', 'direct agent access'),
      ('team_agents', 'team', 'team agent access'),
      ('user_workflow_triggers', 'user', 'direct workflow access'),
      ('team_workflow_triggers', 'team', 'team workflow access'),
      ('workflow_runs', 'user+team', 'visible workflow-run ownership'),
      ('workflow_approval_requests', 'user+team', 'approval target authority'),
      ('notification_deliveries', 'user+team', 'notification audience'),
      ('gfs_resources', 'resource+gfs-subjects', 'resource and current subject visibility'),
      ('gfs_grants', 'resource+user+team', 'GFS resource and direct-subject authority'),
      ('gfs_shares', 'resource+user+team', 'GFS resource and shared-subject authority'),
      ('operational_resource_index', 'resource+source-state', 'promoted source resources'),
      ('operational_resource_relationships', 'resource+source-state', 'promoted source edges'),
      ('operational_catalog_source_state', 'source-state', 'atomic source generation promotion')
    ON CONFLICT (writer_table) DO UPDATE
      SET component_class = EXCLUDED.component_class,
          rationale = EXCLUDED.rationale;

    CREATE OR REPLACE FUNCTION authorization_bump_user_revision(target_user_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      INSERT INTO authorization_user_revisions(user_id, revision, updated_at)
      SELECT users.id, 1, clock_timestamp()
        FROM users
       WHERE users.id = target_user_id
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
      SELECT teams.id, 1, clock_timestamp()
        FROM teams
       WHERE teams.id = target_team_id
      ON CONFLICT (team_id) DO UPDATE
        SET revision = authorization_team_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_subject_revision(
      target_subject_type TEXT,
      target_subject_id TEXT
    )
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF target_subject_type NOT IN ('user', 'team', 'operator', 'host', 'context') THEN
        RAISE EXCEPTION 'unmapped catalog subject type: %', target_subject_type;
      END IF;
      IF target_subject_type IN ('operator', 'host', 'context') THEN
        RETURN;
      END IF;
      IF target_subject_id IS NULL OR target_subject_id = '' THEN
        RETURN;
      END IF;
      IF target_subject_id !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        RAISE EXCEPTION 'invalid catalog % subject identifier', target_subject_type;
      END IF;
      IF target_subject_type = 'user' THEN
        PERFORM authorization_bump_user_revision(target_subject_id::UUID);
      ELSE
        PERFORM authorization_bump_team_revision(target_subject_id::UUID);
      END IF;
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_user_row_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_user_revision(NEW.id);
      END IF;
      IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
        PERFORM authorization_bump_user_revision(OLD.id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_team_row_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_team_revision(NEW.id);
      END IF;
      IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
        PERFORM authorization_bump_team_revision(OLD.id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_workflow_run_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE row_value RECORD;
    BEGIN
      FOR row_value IN
        SELECT actor_type, actor_id::TEXT, team_id::TEXT, usage_team_id
          FROM (VALUES (NEW.actor_type, NEW.actor_id, NEW.team_id, NEW.usage_team_id))
               AS current_row(actor_type, actor_id, team_id, usage_team_id)
         WHERE TG_OP <> 'DELETE'
        UNION ALL
        SELECT actor_type, actor_id::TEXT, team_id::TEXT, usage_team_id
          FROM (VALUES (OLD.actor_type, OLD.actor_id, OLD.team_id, OLD.usage_team_id))
               AS prior_row(actor_type, actor_id, team_id, usage_team_id)
         WHERE TG_OP <> 'INSERT'
      LOOP
        IF row_value.actor_type = 'user' THEN
          PERFORM authorization_bump_subject_revision('user', row_value.actor_id);
        END IF;
        PERFORM authorization_bump_subject_revision('team', row_value.team_id);
        PERFORM authorization_bump_subject_revision('team', row_value.usage_team_id);
      END LOOP;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_workflow_approval_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_subject_revision('user', NEW.target_user_id::TEXT);
        PERFORM authorization_bump_subject_revision('team', NEW.target_team_id::TEXT);
      END IF;
      IF TG_OP <> 'INSERT' THEN
        PERFORM authorization_bump_subject_revision('user', OLD.target_user_id::TEXT);
        PERFORM authorization_bump_subject_revision('team', OLD.target_team_id::TEXT);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_notification_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_subject_revision('user', NEW.audience->>'userId');
        PERFORM authorization_bump_subject_revision('team', NEW.audience->>'teamId');
      END IF;
      IF TG_OP <> 'INSERT' THEN
        PERFORM authorization_bump_subject_revision('user', OLD.audience->>'userId');
        PERFORM authorization_bump_subject_revision('team', OLD.audience->>'teamId');
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_gfs_subject_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_subject_revision(NEW.subject_type, NEW.subject_id);
      END IF;
      IF TG_OP <> 'INSERT' THEN
        PERFORM authorization_bump_subject_revision(OLD.subject_type, OLD.subject_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_gfs_resource_component(
      target_resource_id UUID
    )
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE target_environment_id TEXT;
    BEGIN
      SELECT environment_id
        INTO target_environment_id
        FROM authorization_catalog_environment
       WHERE singleton = TRUE;
      IF target_environment_id IS NULL THEN
        RAISE EXCEPTION 'catalog environment is not configured';
      END IF;
      IF target_resource_id IS NULL THEN
        RETURN;
      END IF;
      INSERT INTO authorization_resource_revisions(
        environment_id, resource_type, resource_id, revision, updated_at
      ) VALUES (
        target_environment_id, 'gfs_resource', target_resource_id::TEXT, 1, clock_timestamp()
      )
      ON CONFLICT (environment_id, resource_type, resource_id) DO UPDATE
        SET revision = authorization_resource_revisions.revision + 1,
            updated_at = clock_timestamp();
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_gfs_authority_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_subject_revision(NEW.subject_type, NEW.subject_id);
        PERFORM authorization_bump_gfs_resource_component(NEW.resource_id);
      END IF;
      IF TG_OP = 'DELETE' OR (
        TG_OP = 'UPDATE' AND (
          OLD.subject_type IS DISTINCT FROM NEW.subject_type
          OR OLD.subject_id IS DISTINCT FROM NEW.subject_id
          OR OLD.resource_id IS DISTINCT FROM NEW.resource_id
        )
      ) THEN
        PERFORM authorization_bump_subject_revision(OLD.subject_type, OLD.subject_id);
        PERFORM authorization_bump_gfs_resource_component(OLD.resource_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_gfs_resource_subjects(target_resource_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE subject RECORD;
    BEGIN
      FOR subject IN
        SELECT grant_row.subject_type, grant_row.subject_id
          FROM gfs_grants grant_row
         WHERE grant_row.resource_id = target_resource_id
        UNION
        SELECT share_row.subject_type, share_row.subject_id
          FROM gfs_shares share_row
         WHERE share_row.resource_id = target_resource_id
        ORDER BY subject_type, subject_id
      LOOP
        PERFORM authorization_bump_subject_revision(subject.subject_type, subject.subject_id);
      END LOOP;
    END;
    $$;

    CREATE OR REPLACE FUNCTION authorization_bump_gfs_resource_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        PERFORM authorization_bump_gfs_resource_component(NEW.resource_id);
        PERFORM authorization_bump_gfs_resource_subjects(NEW.resource_id);
      END IF;
      IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.resource_id IS DISTINCT FROM NEW.resource_id)
      THEN
        PERFORM authorization_bump_gfs_resource_component(OLD.resource_id);
        PERFORM authorization_bump_gfs_resource_subjects(OLD.resource_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    DROP TRIGGER IF EXISTS users_catalog_revision ON users;
    DROP TRIGGER IF EXISTS teams_catalog_revision ON teams;
    DROP TRIGGER IF EXISTS team_members_catalog_revision ON team_members;
    DROP TRIGGER IF EXISTS user_contexts_catalog_revision ON user_contexts;
    DROP TRIGGER IF EXISTS team_contexts_catalog_revision ON team_contexts;
    DROP TRIGGER IF EXISTS user_agents_catalog_revision ON user_agents;
    DROP TRIGGER IF EXISTS team_agents_catalog_revision ON team_agents;
    DROP TRIGGER IF EXISTS user_workflow_triggers_catalog_revision ON user_workflow_triggers;
    DROP TRIGGER IF EXISTS team_workflow_triggers_catalog_revision ON team_workflow_triggers;
    DROP TRIGGER IF EXISTS workflow_runs_catalog_revision ON workflow_runs;
    DROP TRIGGER IF EXISTS workflow_approval_requests_catalog_revision ON workflow_approval_requests;
    DROP TRIGGER IF EXISTS notification_deliveries_catalog_revision ON notification_deliveries;
    DROP TRIGGER IF EXISTS gfs_resources_catalog_revision ON gfs_resources;
    DROP TRIGGER IF EXISTS gfs_grants_catalog_revision ON gfs_grants;
    DROP TRIGGER IF EXISTS gfs_shares_catalog_revision ON gfs_shares;
    DROP TRIGGER IF EXISTS operational_resource_index_catalog_revision ON operational_resource_index;
    DROP TRIGGER IF EXISTS operational_resource_relationships_catalog_revision
      ON operational_resource_relationships;
    DROP TRIGGER IF EXISTS operational_catalog_source_state_catalog_revision
      ON operational_catalog_source_state;

    DROP TRIGGER IF EXISTS users_authorization_revision ON users;
    CREATE TRIGGER users_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_user_row_revision();
    DROP TRIGGER IF EXISTS teams_authorization_revision ON teams;
    CREATE TRIGGER teams_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON teams
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_team_row_revision();
    DROP TRIGGER IF EXISTS workflow_runs_authorization_revision ON workflow_runs;
    CREATE TRIGGER workflow_runs_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON workflow_runs
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_workflow_run_revision();
    DROP TRIGGER IF EXISTS workflow_approval_requests_authorization_revision
      ON workflow_approval_requests;
    CREATE TRIGGER workflow_approval_requests_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON workflow_approval_requests
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_workflow_approval_revision();
    DROP TRIGGER IF EXISTS notification_deliveries_authorization_revision
      ON notification_deliveries;
    CREATE TRIGGER notification_deliveries_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_notification_revision();
    DROP TRIGGER IF EXISTS gfs_grants_authorization_revision ON gfs_grants;
    CREATE TRIGGER gfs_grants_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON gfs_grants
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_gfs_authority_revision();
    DROP TRIGGER IF EXISTS gfs_shares_authorization_revision ON gfs_shares;
    CREATE TRIGGER gfs_shares_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON gfs_shares
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_gfs_authority_revision();
    DROP TRIGGER IF EXISTS gfs_resources_authorization_revision ON gfs_resources;
    CREATE TRIGGER gfs_resources_authorization_revision
      AFTER INSERT OR UPDATE OR DELETE ON gfs_resources
      FOR EACH ROW EXECUTE FUNCTION authorization_bump_gfs_resource_revision();

    DROP FUNCTION IF EXISTS authorization_bump_catalog_revision();
    DROP TABLE IF EXISTS authorization_catalog_revision;

    REVOKE ALL ON TABLE authorization_catalog_writer_components FROM PUBLIC;
    REVOKE ALL ON TABLE authorization_catalog_environment FROM PUBLIC;
    GRANT SELECT ON TABLE authorization_catalog_writer_components TO control_api_runtime;
    GRANT SELECT ON TABLE authorization_catalog_environment TO control_api_runtime;
    REVOKE ALL ON FUNCTION authorization_bump_subject_revision(TEXT, TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_user_row_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_team_row_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_workflow_run_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_workflow_approval_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_notification_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_gfs_subject_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_gfs_resource_component(UUID) FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_gfs_authority_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_gfs_resource_subjects(UUID) FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_gfs_resource_revision() FROM PUBLIC;
  `)
  await db.query(
    `INSERT INTO authorization_catalog_environment(singleton, environment_id)
     VALUES(TRUE, $1)
     ON CONFLICT (singleton) DO UPDATE SET environment_id = EXCLUDED.environment_id`,
    [canonicalEnvironmentId()]
  )
  await db.query(
    `INSERT INTO authorization_resource_revisions(
       environment_id, resource_type, resource_id, revision, updated_at
     )
     SELECT $1, 'gfs_resource', resource_id::text, 1, clock_timestamp()
       FROM gfs_resources
     ON CONFLICT (environment_id, resource_type, resource_id) DO NOTHING`,
    [canonicalEnvironmentId()]
  )
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
    CREATE OR REPLACE FUNCTION authorization_bump_catalog_revision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      UPDATE authorization_catalog_revision
         SET revision = revision + 1,
             updated_at = clock_timestamp()
       WHERE singleton = TRUE;
      RETURN NULL;
    END;
    $$;

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

    DO $$
    DECLARE table_name TEXT;
    DECLARE trigger_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'users', 'teams', 'team_members',
        'user_contexts', 'team_contexts', 'user_agents', 'team_agents',
        'user_workflow_triggers', 'team_workflow_triggers',
        'workflow_runs', 'workflow_approval_requests', 'notification_deliveries',
        'gfs_resources', 'gfs_grants', 'gfs_shares',
        'operational_resource_index', 'operational_resource_relationships',
        'operational_catalog_source_state'
      ]
      LOOP
        trigger_name := table_name || '_catalog_revision';
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trigger_name) THEN
          EXECUTE format(
            'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
            || 'FOR EACH STATEMENT EXECUTE FUNCTION authorization_bump_catalog_revision()',
            trigger_name,
            table_name
          );
        END IF;
      END LOOP;
    END;
    $$;

    REVOKE ALL ON FUNCTION authorization_bump_catalog_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_team_membership_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_user_grant_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_team_grant_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_operational_resource_revision() FROM PUBLIC;
    REVOKE ALL ON FUNCTION authorization_bump_operational_relationship_revision() FROM PUBLIC;
  `)
}

export async function backfillLegacyPasswordSecurityEpochs(db: DbClient): Promise<void> {
  await db.query(`
    INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason, updated_at)
    SELECT u.id, u.password_set_at, 'historical_password_event', u.password_set_at
      FROM users u
     WHERE u.password_set_at IS NOT NULL
    ON CONFLICT (user_id) DO UPDATE
      SET valid_after = GREATEST(
            external_user_session_security_epochs.valid_after,
            EXCLUDED.valid_after
          ),
          reason = CASE
            WHEN external_user_session_security_epochs.valid_after < EXCLUDED.valid_after
              THEN EXCLUDED.reason
            ELSE external_user_session_security_epochs.reason
          END,
          updated_at = CASE
            WHEN external_user_session_security_epochs.valid_after < EXCLUDED.valid_after
              THEN EXCLUDED.updated_at
            ELSE external_user_session_security_epochs.updated_at
          END;
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
      authorization_catalog_revision,
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

    GRANT SELECT ON TABLE authorization_catalog_revision TO control_api_runtime;
  `)
}

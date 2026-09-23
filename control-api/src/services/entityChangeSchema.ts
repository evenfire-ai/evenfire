import type { DbClient } from '../db.js'

/**
 * Durable, generic change-capture storage. Producers only append through
 * SECURITY DEFINER trigger functions; consumers see coarse scopes, never the
 * internal resource identity or authorization subject in the outbox.
 */
export async function applyEntityChangeSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS entity_change_outbox (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('gfs', 'authorization')),
      entity_type TEXT NOT NULL,
      entity_id TEXT NULL,
      change_kind TEXT NOT NULL,
      revision BIGINT NULL,
      facets TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS entity_change_watermark (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
      pruned_through BIGINT NOT NULL DEFAULT 0 CHECK (pruned_through >= 0),
      current_cursor UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    );
    ALTER TABLE entity_change_watermark
      ADD COLUMN IF NOT EXISTS current_cursor UUID NOT NULL
      DEFAULT '00000000-0000-0000-0000-000000000000';
    INSERT INTO entity_change_watermark (singleton) VALUES (true)
      ON CONFLICT (singleton) DO NOTHING;

    CREATE TABLE IF NOT EXISTS entity_change_feed (
      sequence BIGINT PRIMARY KEY CHECK (sequence > 0),
      cursor UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      scope TEXT NOT NULL CHECK (scope IN ('gfs', 'authorization')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS entity_change_feed_created_at_idx
      ON entity_change_feed (created_at, sequence);

    CREATE OR REPLACE FUNCTION entity_change_capture_resource() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE
      resource_key UUID;
      event_kind TEXT;
      event_revision BIGINT;
      event_facets TEXT[];
    BEGIN
      IF TG_OP = 'DELETE' THEN
        resource_key := OLD.resource_id;
        event_kind := 'deleted';
        event_revision := OLD.version;
        event_facets := ARRAY['metadata', 'hierarchy', 'content', 'visibility'];
      ELSIF TG_OP = 'INSERT' THEN
        resource_key := NEW.resource_id;
        event_kind := 'created';
        event_revision := NEW.version;
        event_facets := ARRAY['metadata', 'hierarchy', 'content', 'visibility'];
      ELSE
        resource_key := NEW.resource_id;
        event_revision := NEW.version;
        IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
          event_kind := 'deleted';
          event_facets := ARRAY['metadata', 'hierarchy', 'content', 'visibility'];
        ELSE
          event_kind := 'updated';
          event_facets := ARRAY[]::TEXT[];
          IF OLD.version IS DISTINCT FROM NEW.version OR OLD.bytes IS DISTINCT FROM NEW.bytes THEN
            event_facets := array_append(event_facets, 'content');
          END IF;
          IF OLD.name IS DISTINCT FROM NEW.name OR
             OLD.parent_resource_id IS DISTINCT FROM NEW.parent_resource_id OR
             OLD.path_cache IS DISTINCT FROM NEW.path_cache OR
             OLD.kind IS DISTINCT FROM NEW.kind THEN
            event_facets := array_append(event_facets, 'metadata');
            event_facets := array_append(event_facets, 'hierarchy');
          END IF;
          IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
            event_facets := array_append(event_facets, 'visibility');
          END IF;
          IF cardinality(event_facets) = 0 THEN
            event_facets := ARRAY['metadata'];
          END IF;
        END IF;
      END IF;

      INSERT INTO public.entity_change_outbox
        (scope, entity_type, entity_id, change_kind, revision, facets)
      VALUES ('gfs', 'gfs.resource', resource_key::TEXT, event_kind, event_revision, event_facets);
      PERFORM pg_notify('entity_change_outbox', '');
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION entity_change_capture_scope() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE
      capture_scope TEXT;
      capture_type TEXT;
    BEGIN
      IF TG_TABLE_NAME IN (
        'gfs_grants', 'gfs_shares', 'team_members', 'users',
        'control_admin_users', 'gfs_desktop_operator_links'
      ) THEN
        capture_scope := 'authorization';
        capture_type := 'authorization.scope';
      ELSE
        capture_scope := 'gfs';
        capture_type := 'gfs.resource';
      END IF;
      INSERT INTO public.entity_change_outbox
        (scope, entity_type, entity_id, change_kind, facets)
      VALUES (capture_scope, capture_type, NULL, 'scope_invalidated', ARRAY['visibility', 'hierarchy']);
      PERFORM pg_notify('entity_change_outbox', '');
      RETURN NULL;
    END;
    $$;

    DROP TRIGGER IF EXISTS entity_change_resource_rows ON gfs_resources;
    CREATE TRIGGER entity_change_resource_rows
      AFTER INSERT OR UPDATE OR DELETE ON gfs_resources
      FOR EACH ROW EXECUTE FUNCTION entity_change_capture_resource();
    DROP TRIGGER IF EXISTS entity_change_resource_truncate ON gfs_resources;
    CREATE TRIGGER entity_change_resource_truncate
      AFTER TRUNCATE ON gfs_resources
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();

    DROP TRIGGER IF EXISTS entity_change_grant_statements ON gfs_grants;
    CREATE TRIGGER entity_change_grant_statements
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON gfs_grants
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();
    DROP TRIGGER IF EXISTS entity_change_share_statements ON gfs_shares;
    CREATE TRIGGER entity_change_share_statements
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON gfs_shares
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();

    DROP TRIGGER IF EXISTS entity_change_team_members_statements ON team_members;
    CREATE TRIGGER entity_change_team_members_statements
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON team_members
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();

    DROP TRIGGER IF EXISTS entity_change_user_lifecycle ON users;
    CREATE TRIGGER entity_change_user_lifecycle
      AFTER INSERT OR DELETE OR UPDATE OF lifecycle_state, lifecycle_version ON users
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();
    DROP TRIGGER IF EXISTS entity_change_admin_lifecycle ON control_admin_users;
    CREATE TRIGGER entity_change_admin_lifecycle
      AFTER INSERT OR DELETE OR UPDATE OF status, session_version ON control_admin_users
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();
    DROP TRIGGER IF EXISTS entity_change_desktop_operator_links ON gfs_desktop_operator_links;
    CREATE TRIGGER entity_change_desktop_operator_links
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON gfs_desktop_operator_links
      FOR EACH STATEMENT EXECUTE FUNCTION entity_change_capture_scope();

    REVOKE ALL ON entity_change_outbox, entity_change_watermark, entity_change_feed
      FROM PUBLIC, control_api_runtime, gfs_controller, gfs_controller_reader;
    REVOKE ALL ON SEQUENCE entity_change_outbox_id_seq
      FROM PUBLIC, control_api_runtime, gfs_controller, gfs_controller_reader;
    REVOKE ALL ON FUNCTION entity_change_capture_resource() FROM PUBLIC;
    REVOKE ALL ON FUNCTION entity_change_capture_scope() FROM PUBLIC;
  `)

  await db.query(`
    CREATE OR REPLACE FUNCTION entity_change_dispatch_batch(
      requested_batch_size INTEGER,
      retention_seconds INTEGER
    ) RETURNS TABLE (feed_sequence BIGINT, feed_cursor UUID, feed_scope TEXT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE
      changed_scopes TEXT[];
      changed_scope TEXT;
      next_sequence BIGINT;
      removed_through BIGINT;
    BEGIN
      IF requested_batch_size < 1 OR requested_batch_size > 10000 OR
         retention_seconds < 3600 OR retention_seconds > 2592000 THEN
        RAISE EXCEPTION 'entity change dispatcher bounds rejected';
      END IF;
      IF NOT pg_try_advisory_xact_lock(1849220361, 1) THEN
        RETURN;
      END IF;

      WITH picked AS MATERIALIZED (
        SELECT id FROM public.entity_change_outbox
         ORDER BY id
         LIMIT requested_batch_size
         FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM public.entity_change_outbox pending
         USING picked
         WHERE pending.id = picked.id
         RETURNING pending.scope
      )
      SELECT array_agg(DISTINCT scope ORDER BY scope) INTO changed_scopes FROM removed;

      IF changed_scopes IS NOT NULL THEN
        PERFORM 1 FROM public.entity_change_watermark WHERE singleton = true FOR UPDATE;
        FOREACH changed_scope IN ARRAY changed_scopes LOOP
          UPDATE public.entity_change_watermark
             SET sequence = sequence + 1, current_cursor = gen_random_uuid()
           WHERE singleton = true
           RETURNING sequence, current_cursor INTO next_sequence, feed_cursor;
          INSERT INTO public.entity_change_feed (sequence, scope, created_at, cursor)
            VALUES (next_sequence, changed_scope, clock_timestamp(), feed_cursor);
          feed_sequence := next_sequence;
          feed_scope := changed_scope;
          RETURN NEXT;
        END LOOP;
        PERFORM pg_notify('entity_change_feed', '');
      END IF;

      WITH removed AS (
        DELETE FROM public.entity_change_feed
         WHERE created_at < clock_timestamp() - make_interval(secs => retention_seconds)
        RETURNING sequence
      ) SELECT max(sequence) INTO removed_through FROM removed;
      IF removed_through IS NOT NULL THEN
        UPDATE public.entity_change_watermark
           SET pruned_through = GREATEST(pruned_through, removed_through)
         WHERE singleton = true;
      END IF;
      RETURN;
    END;
    $$;

    DROP FUNCTION IF EXISTS entity_change_read_checkpoint(UUID);
    CREATE OR REPLACE FUNCTION entity_change_read_checkpoint(
      requested_cursor UUID,
      maximum_recovery_events INTEGER
    )
      RETURNS TABLE (
        needs_resync BOOLEAN,
        current_cursor UUID,
        current_sequence BIGINT,
        invalidated_scopes TEXT[]
      )
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE
      cursor_sequence BIGINT;
      current_watermark BIGINT;
      pruned_watermark BIGINT;
    BEGIN
      IF maximum_recovery_events < 1 OR maximum_recovery_events > 100000 THEN
        RAISE EXCEPTION 'entity change recovery bounds rejected';
      END IF;
      SELECT watermark.sequence, watermark.pruned_through, watermark.current_cursor
        INTO current_watermark, pruned_watermark, current_cursor
        FROM public.entity_change_watermark watermark
       WHERE watermark.singleton = true
       FOR SHARE;
      IF requested_cursor IS NULL THEN
        needs_resync := true;
        current_sequence := current_watermark;
        invalidated_scopes := ARRAY['gfs', 'authorization'];
        RETURN NEXT;
        RETURN;
      END IF;

      IF requested_cursor = '00000000-0000-0000-0000-000000000000' THEN
        cursor_sequence := 0;
      ELSE
        SELECT sequence INTO cursor_sequence FROM public.entity_change_feed
         WHERE cursor = requested_cursor;
      END IF;
      IF cursor_sequence IS NULL AND requested_cursor = current_cursor THEN
        cursor_sequence := current_watermark;
      END IF;
      IF cursor_sequence IS NULL OR cursor_sequence < pruned_watermark OR
         current_watermark - cursor_sequence > maximum_recovery_events THEN
        needs_resync := true;
        current_sequence := current_watermark;
        invalidated_scopes := ARRAY['gfs', 'authorization'];
        RETURN NEXT;
        RETURN;
      END IF;

      needs_resync := false;
      SELECT COALESCE(array_agg(DISTINCT scope ORDER BY scope), ARRAY[]::TEXT[]),
             COALESCE(max(sequence), cursor_sequence)
        INTO invalidated_scopes, current_sequence
        FROM public.entity_change_feed WHERE sequence > cursor_sequence;
      RETURN NEXT;
    END;
    $$;

    REVOKE ALL ON FUNCTION entity_change_dispatch_batch(INTEGER, INTEGER) FROM PUBLIC;
    REVOKE ALL ON FUNCTION entity_change_read_checkpoint(UUID, INTEGER) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION entity_change_dispatch_batch(INTEGER, INTEGER) TO control_api_runtime;
    GRANT EXECUTE ON FUNCTION entity_change_read_checkpoint(UUID, INTEGER) TO control_api_runtime;
  `)
}

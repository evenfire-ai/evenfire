import type { DbClient } from '../../db.js'
import { GFS_AUTHZ_CHANGED_CHANNEL, GFS_WATCH_SESSION_CHANNEL } from './notifySchemas.js'

/**
 * Revocation signals for the GFS watch: per-row NOTIFYs on every table that
 * feeds gfsc's authorization of a principal, and on the user lifecycle.
 *
 * `gfs_authz_changed` carries one key per NOTIFY: `s:<type>:<id>` for grants
 * and shares, `u:<user_id>` for memberships and operator links, `a:<admin_id>`
 * for control admins. When OLD and NEW of a row map to different keys the
 * trigger emits two NOTIFYs, never a list in one payload, so every payload
 * stays a single parseable key. Identical payloads in one transaction are
 * folded by Postgres.
 *
 * `gfs_watch_session` carries `<user_id>:<state>:<version>`; a deleted row
 * reports `deleted` with its last version.
 *
 * One migration per table, each in its own transaction. CREATE TRIGGER waits
 * behind every open writer of its table; in a single transaction each lock
 * already taken would be held through the next waits, and a writer that
 * touches users and then team_members (the Google login) would deadlock
 * against it and be the one aborted.
 *
 * Constraints a later edit must keep:
 * - A grant or share subject id is TEXT and the routes bound only `user` and
 *   `team` ids to a uuid; a direct SQL writer is not bound at all. pg_notify
 *   raises on a payload of 8000 bytes or more, and inside an AFTER ROW trigger
 *   that aborts the grant or share write. So the key carries the id only for
 *   `user`/`team` and only up to a uuid's length; any other id is emitted
 *   empty. An id that long is not a uuid and names nobody either way.
 * - Every column in a payload is cast to text before concatenation.
 * - Not SECURITY DEFINER: pg_notify needs no privilege, so the functions run
 *   with the writer's rights. search_path is pinned so a temp-schema type
 *   named `text` cannot shadow the casts. `gfs_authz_subject_key` keeps
 *   EXECUTE for PUBLIC: unlike a trigger function, a function called from a
 *   trigger body is checked against the writer, and revoking it would abort
 *   every grant and share write. It is pure and reads nothing.
 * - UPDATE triggers filter with WHEN on the columns of the key and the state,
 *   never with `UPDATE OF`: a column list matches the statement's SET list,
 *   so a change made by a BEFORE trigger, or a key column changed without the
 *   state column in the SET, would be missed. A WHEN cannot reference OLD on
 *   INSERT nor NEW on DELETE, hence a separate UPDATE trigger.
 * - OR REPLACE instead of DROP + CREATE: DROP TRIGGER takes an ACCESS
 *   EXCLUSIVE lock on the table, which would block reads while a re-apply
 *   waits for the lock.
 */

/** The functions of every table's trigger, and the gfs_grants trigger. */
export async function applyGfsAuthzGrantsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION gfs_authz_subject_key(t text, sid text) RETURNS text
      LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT 's:' || t || ':' ||
        CASE WHEN t IN ('user', 'team') AND length(sid) <= 36 THEN sid ELSE '' END
    $$;

    CREATE OR REPLACE FUNCTION gfs_authz_subject_notify() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      old_key TEXT;
      new_key TEXT;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        old_key := gfs_authz_subject_key(OLD.subject_type::text, OLD.subject_id::text);
        PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', old_key);
      END IF;
      IF TG_OP <> 'DELETE' THEN
        new_key := gfs_authz_subject_key(NEW.subject_type::text, NEW.subject_id::text);
        IF new_key IS DISTINCT FROM old_key THEN
          PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', new_key);
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE OR REPLACE FUNCTION gfs_authz_user_notify() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      old_key TEXT;
      new_key TEXT;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        old_key := 'u:' || OLD.user_id::text;
        PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', old_key);
      END IF;
      IF TG_OP <> 'DELETE' THEN
        new_key := 'u:' || NEW.user_id::text;
        IF new_key IS DISTINCT FROM old_key THEN
          PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', new_key);
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE OR REPLACE FUNCTION gfs_authz_admin_notify() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      old_key TEXT;
      new_key TEXT;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        old_key := 'a:' || OLD.id::text;
        PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', old_key);
      END IF;
      IF TG_OP <> 'DELETE' THEN
        new_key := 'a:' || NEW.id::text;
        IF new_key IS DISTINCT FROM old_key THEN
          PERFORM pg_notify('${GFS_AUTHZ_CHANGED_CHANNEL}', new_key);
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE OR REPLACE FUNCTION gfs_watch_session_notify() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify(
          '${GFS_WATCH_SESSION_CHANNEL}',
          OLD.id::text || ':deleted:' || OLD.lifecycle_version::text
        );
      ELSE
        PERFORM pg_notify(
          '${GFS_WATCH_SESSION_CHANNEL}',
          NEW.id::text || ':' || NEW.lifecycle_state::text || ':' || NEW.lifecycle_version::text
        );
      END IF;
      RETURN NULL;
    END;
    $$;

    REVOKE ALL ON FUNCTION gfs_authz_subject_notify() FROM PUBLIC;
    REVOKE ALL ON FUNCTION gfs_authz_user_notify() FROM PUBLIC;
    REVOKE ALL ON FUNCTION gfs_authz_admin_notify() FROM PUBLIC;
    REVOKE ALL ON FUNCTION gfs_watch_session_notify() FROM PUBLIC;

    CREATE OR REPLACE TRIGGER gfs_authz_changed_notify
      AFTER INSERT OR UPDATE OR DELETE ON gfs_grants
      FOR EACH ROW EXECUTE FUNCTION gfs_authz_subject_notify();
  `)
}

export async function applyGfsAuthzSharesSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE TRIGGER gfs_authz_changed_notify
      AFTER INSERT OR UPDATE OR DELETE ON gfs_shares
      FOR EACH ROW EXECUTE FUNCTION gfs_authz_subject_notify();
  `)
}

export async function applyGfsAuthzOperatorLinksSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE TRIGGER gfs_authz_changed_notify
      AFTER INSERT OR UPDATE OR DELETE ON gfs_desktop_operator_links
      FOR EACH ROW EXECUTE FUNCTION gfs_authz_user_notify();
  `)
}

/** A new admin has no sessions or links yet, so INSERT emits nothing. */
export async function applyGfsAuthzControlAdminsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE TRIGGER gfs_authz_changed_notify
      AFTER DELETE ON control_admin_users
      FOR EACH ROW EXECUTE FUNCTION gfs_authz_admin_notify();

    CREATE OR REPLACE TRIGGER gfs_authz_changed_update_notify
      AFTER UPDATE ON control_admin_users
      FOR EACH ROW
      WHEN ((OLD.id, OLD.status, OLD.session_version)
            IS DISTINCT FROM (NEW.id, NEW.status, NEW.session_version))
      EXECUTE FUNCTION gfs_authz_admin_notify();
  `)
}

/**
 * A role change is not an authorization change, so only user_id and status are watched. team_id
 * is left out because no writer moves a membership between teams and its FK does not cascade
 * updates; a writer that did would need it here.
 */
export async function applyGfsAuthzTeamMembersSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE TRIGGER gfs_authz_changed_notify
      AFTER INSERT OR DELETE ON team_members
      FOR EACH ROW EXECUTE FUNCTION gfs_authz_user_notify();

    CREATE OR REPLACE TRIGGER gfs_authz_changed_update_notify
      AFTER UPDATE ON team_members
      FOR EACH ROW
      WHEN ((OLD.user_id, OLD.status) IS DISTINCT FROM (NEW.user_id, NEW.status))
      EXECUTE FUNCTION gfs_authz_user_notify();
  `)
}

export async function applyGfsWatchSessionUsersSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE TRIGGER gfs_watch_session_update_notify
      AFTER UPDATE ON users
      FOR EACH ROW
      WHEN ((OLD.lifecycle_state, OLD.lifecycle_version)
            IS DISTINCT FROM (NEW.lifecycle_state, NEW.lifecycle_version))
      EXECUTE FUNCTION gfs_watch_session_notify();

    CREATE OR REPLACE TRIGGER gfs_watch_session_delete_notify
      AFTER DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION gfs_watch_session_notify();
  `)
}

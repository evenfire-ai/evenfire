import type { DbClient } from '../../db.js'
import { GFS_RESOURCE_CHANGED_CHANNEL } from './notifySchemas.js'

/**
 * Per-row change signal for the GFS watch: one NOTIFY per written row of
 * gfs_resources, delivered only when the writer commits. It covers every
 * writer (gfsc and control-api) without touching any of them.
 *
 * Payload: "rid,old_parent,new_parent,h,a,op" (well under 140 bytes).
 *
 * Constraints a later edit must keep:
 * - Every uuid is cast to text before coalesce. `coalesce(uuid, '')` raises
 *   invalid input syntax for type uuid, and in an AFTER ROW trigger that
 *   aborts the writer's transaction: no GFS write would commit.
 * - Not SECURITY DEFINER: it only calls pg_notify, which needs no privilege,
 *   so it runs with the writer's own rights. search_path is still pinned so a
 *   temp-schema type named `text` cannot shadow the casts.
 */
export async function applyGfsResourceChangedSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION gfs_resource_changed_notify() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      changed_id TEXT;
      old_parent TEXT;
      new_parent TEXT;
      listing_flag TEXT;
      ancestry_flag TEXT;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        changed_id := OLD.resource_id::text;
      ELSE
        changed_id := NEW.resource_id::text;
      END IF;
      IF TG_OP = 'INSERT' THEN
        old_parent := '';
      ELSE
        old_parent := coalesce(OLD.parent_resource_id::text, '');
      END IF;
      IF TG_OP = 'DELETE' THEN
        new_parent := '';
      ELSE
        new_parent := coalesce(NEW.parent_resource_id::text, '');
      END IF;

      IF TG_OP IN ('INSERT', 'DELETE') THEN
        listing_flag := '1';
      ELSIF OLD.name IS DISTINCT FROM NEW.name
         OR OLD.parent_resource_id IS DISTINCT FROM NEW.parent_resource_id
         OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
         OR OLD.kind IS DISTINCT FROM NEW.kind THEN
        listing_flag := '1';
      ELSE
        listing_flag := '0';
      END IF;

      -- A rename alone keeps ancestry: consumers reauthorize only on a = 1.
      IF TG_OP = 'DELETE' THEN
        ancestry_flag := '1';
      ELSIF TG_OP = 'UPDATE' AND (
            OLD.parent_resource_id IS DISTINCT FROM NEW.parent_resource_id
         OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) THEN
        ancestry_flag := '1';
      ELSE
        ancestry_flag := '0';
      END IF;

      PERFORM pg_notify(
        '${GFS_RESOURCE_CHANGED_CHANNEL}',
        changed_id || ',' || old_parent || ',' || new_parent || ',' ||
          listing_flag || ',' || ancestry_flag || ',' ||
          CASE TG_OP WHEN 'INSERT' THEN 'i' WHEN 'UPDATE' THEN 'u' ELSE 'd' END
      );
      RETURN NULL;
    END;
    $$;

    -- OR REPLACE instead of DROP + CREATE: DROP TRIGGER takes an
    -- ACCESS EXCLUSIVE lock on gfs_resources, which would block GFS reads
    -- while a re-apply waits for the lock.
    CREATE OR REPLACE TRIGGER gfs_resource_changed_notify
      AFTER INSERT OR UPDATE OR DELETE ON gfs_resources
      FOR EACH ROW EXECUTE FUNCTION gfs_resource_changed_notify();

    REVOKE ALL ON FUNCTION gfs_resource_changed_notify() FROM PUBLIC;
  `)
}

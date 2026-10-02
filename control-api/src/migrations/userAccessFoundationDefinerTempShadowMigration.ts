import type { DbClient } from '../db.js'

/**
 * Harden the installed access-foundation SECURITY DEFINER functions without
 * changing their bodies, ownership, grants, or behavior.
 * The obsolete authorization_bump_catalog_revision() routine is intentionally
 * excluded because 0128_composable_catalog_revisions drops it before this runs.
 */
export async function applyUserAccessFoundationDefinerTempShadowHardening(
  db: DbClient
): Promise<void> {
  await db.query(`
    ALTER FUNCTION public.authorization_bump_user_revision(pg_catalog.uuid)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_team_revision(pg_catalog.uuid)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_subject_revision(pg_catalog.text, pg_catalog.text)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_user_row_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_team_row_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_workflow_run_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_workflow_approval_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_notification_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_gfs_subject_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_gfs_resource_component(pg_catalog.uuid)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_gfs_authority_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_gfs_resource_subjects(pg_catalog.uuid)
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_gfs_resource_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_resource_revision(
      pg_catalog.text, pg_catalog.text, pg_catalog.text
    ) SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_team_membership_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_user_grant_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_team_grant_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_operational_resource_revision()
      SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION public.authorization_bump_operational_relationship_revision()
      SET search_path = pg_catalog, public, pg_temp;
  `)
}

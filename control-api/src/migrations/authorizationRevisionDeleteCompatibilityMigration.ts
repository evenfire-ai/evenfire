import type { DbClient } from '../db.js'

/**
 * Forward repair for the 0125 identity-revision trigger behavior.
 *
 * The immutable 0125 body unconditionally upserts a revision. During a user or
 * team delete cascade that can reference an identity already removed by the
 * parent statement. Select only still-existing parents, matching the later
 * composable-revision behavior without changing either function's ACL.
 */
export async function applyAuthorizationRevisionDeleteCompatibility(db: DbClient): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION public.authorization_bump_user_revision(target_user_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS $$
      INSERT INTO authorization_user_revisions(user_id, revision, updated_at)
      SELECT users.id, 1, clock_timestamp()
        FROM users
       WHERE users.id = target_user_id
      ON CONFLICT (user_id) DO UPDATE
        SET revision = authorization_user_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;

    CREATE OR REPLACE FUNCTION public.authorization_bump_team_revision(target_team_id UUID)
    RETURNS VOID
    LANGUAGE SQL
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS $$
      INSERT INTO authorization_team_revisions(team_id, revision, updated_at)
      SELECT teams.id, 1, clock_timestamp()
        FROM teams
       WHERE teams.id = target_team_id
      ON CONFLICT (team_id) DO UPDATE
        SET revision = authorization_team_revisions.revision + 1,
            updated_at = clock_timestamp();
    $$;
  `)
}

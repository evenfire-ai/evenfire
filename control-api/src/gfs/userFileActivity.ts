import type { GrantsDb } from '../routes/gfs/grants.js'

/**
 * Record that `userId` opened or changed `resourceIds`
 * (`gfs_record_user_file_activity`).
 *
 * One statement on the caller's connection: the function upserts the rows and
 * trims the user back to the 100 most recent, and its failure fails the caller's
 * request — there is no fallback. The user id is always the Desktop actor that
 * the proxy already authorized, never the token subject of a linked admin.
 */
export async function recordUserFileActivity(
  db: GrantsDb,
  userId: string,
  resourceIds: readonly string[]
): Promise<void> {
  await db.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
    userId,
    [...resourceIds],
  ])
}

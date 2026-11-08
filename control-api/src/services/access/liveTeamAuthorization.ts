import { type DbClient, pool } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'

export type LiveTeamMembership = {
  teamId: string
  role: TeamRole
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getLiveTeamMembership(
  userId: string,
  teamId: string,
  options: {
    db?: Pick<DbClient, 'query'>
    onDatabaseFailure?: (error: unknown) => unknown
  } = {}
): Promise<LiveTeamMembership | null> {
  // team_members.user_id and team_id are UUID columns: a value that is not a
  // UUID cannot name a team or user row, so it has no membership.
  if (!CANONICAL_UUID_RE.test(teamId) || !CANONICAL_UUID_RE.test(userId)) return null
  const db = options.db ?? pool
  const text = `SELECT tm.team_id, tm.role
       FROM team_members tm
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`
  const values = [userId, teamId]
  let result
  if (options.onDatabaseFailure) {
    try {
      result = await db.query(text, values)
    } catch (error) {
      throw options.onDatabaseFailure(error)
    }
  } else {
    result = await db.query(text, values)
  }
  const row = result.rows[0] as { team_id: string; role: TeamRole } | undefined
  return row ? { teamId: row.team_id, role: row.role } : null
}

import { type DbClient, pool } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'

export type LiveTeamMembership = {
  teamId: string
  role: TeamRole
}

export async function getLiveTeamMembership(
  userId: string,
  teamId: string,
  db: Pick<DbClient, 'query'> = pool
): Promise<LiveTeamMembership | null> {
  const result = await db.query(
    `SELECT tm.team_id, tm.role
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  const row = result.rows[0] as { team_id: string; role: TeamRole } | undefined
  return row ? { teamId: row.team_id, role: row.role } : null
}

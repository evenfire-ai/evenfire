import { type DbClient, pool } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'

export type LiveTeamMembership = {
  teamId: string
  role: TeamRole
}

export async function getLiveTeamMembership(
  userId: string,
  teamId: string,
  options: {
    db?: Pick<DbClient, 'query'>
    budget?: AccessExecutionBudget
  } = {}
): Promise<LiveTeamMembership | null> {
  const db = options.db ?? pool
  const text = `SELECT tm.team_id, tm.role
       FROM team_members tm
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`
  const values = [userId, teamId]
  const result = options.budget
    ? await runAccessDatabaseQuery(db, options.budget, text, values)
    : await db.query(text, values)
  const row = result.rows[0] as { team_id: string; role: TeamRole } | undefined
  return row ? { teamId: row.team_id, role: row.role } : null
}

import { pool, withTransaction } from '../../db.js'
import type { DbClient } from '../../db.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import { validateExternalSessionAuthorityContext } from '../auth/userSessionService.js'
import type { AdminDeleteTeamResult, TeamRole } from './types.js'

export async function listTeams(userId: string, currentTeamId: string) {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
      ORDER BY t.created_at ASC`,
    [userId]
  )

  return {
    currentTeamId,
    items: result.rows,
  }
}

export async function listAllTeams() {
  const result = await pool.query(
    `SELECT t.id,
            t.name,
            COUNT(CASE WHEN tm.status = 'active' AND u.lifecycle_state = 'active' THEN 1 END) AS member_count
       FROM teams t
  LEFT JOIN team_members tm ON tm.team_id = t.id
  LEFT JOIN users u ON u.id = tm.user_id
   GROUP BY t.id, t.name
   ORDER BY t.name ASC`
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    name: String((row as { name: string }).name),
    memberCount: Number((row as { member_count: string | number }).member_count || 0),
  }))
}

export async function getTeamById(teamId: string) {
  const result = await pool.query(
    `SELECT id, name
       FROM teams
      WHERE id = $1
      LIMIT 1`,
    [teamId]
  )
  return (result.rows[0] as { id: string; name: string } | undefined) || null
}

export async function getCurrentTeam(
  userId: string,
  teamId: string,
  db: Pick<DbClient, 'query'> = pool
) {
  const result = await db.query(
    `SELECT t.id, t.name, tm.role
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as { id: string; name: string; role: TeamRole } | undefined) || null
}

export async function createTeam(name: string) {
  const team = await pool.query(`INSERT INTO teams(name) VALUES($1) RETURNING id, name`, [name])
  return team.rows[0] as { id: string; name: string }
}

export async function createTeamForUser(userId: string | undefined, name: string) {
  const team = await createTeam(name)

  if (userId) {
    await pool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $2, 'admin', 'active')`,
      [team.id, userId]
    )
  }

  return team
}

export async function renameTeam(teamId: string, name: string) {
  const updated = await pool.query(
    `UPDATE teams
        SET name = $2
      WHERE id = $1
    RETURNING id, name`,
    [teamId, name]
  )
  return (updated.rows[0] as { id: string; name: string } | undefined) || null
}

export async function renameTeamForUser(
  userId: string,
  teamId: string,
  name: string,
  authority?: ExternalSessionAuthorityContext
) {
  return withTransaction(async db => {
    if (authority) {
      const session = await validateExternalSessionAuthorityContext(authority, { db })
      if (session.status !== 'valid' || session.identity.userId !== userId.trim()) {
        return { error: 'forbidden' as const }
      }
    }
    const membership = await db.query(
      `SELECT role
         FROM team_members
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
        FOR UPDATE`,
      [teamId, userId]
    )
    if ((membership.rows[0] as { role?: string } | undefined)?.role !== 'admin') {
      return { error: 'forbidden' as const }
    }
    const updated = await db.query(
      `UPDATE teams
          SET name = $2
        WHERE id = $1
      RETURNING id, name`,
      [teamId, name]
    )
    const team = (updated.rows[0] as { id: string; name: string } | undefined) || null
    return team ? { team } : { error: 'not_found' as const }
  })
}

/**
 * Hard-delete an empty team and all dependent rows (CASCADE from schema: invitations,
 * team_contexts, team_agents). Active memberships block deletion.
 */
export async function adminDeleteTeam(teamId: string): Promise<AdminDeleteTeamResult> {
  return withTransaction(async db => {
    const team = await db.query(`SELECT id FROM teams WHERE id = $1 FOR UPDATE`, [teamId])
    const row = team.rows[0] as { id: string } | undefined
    if (!row) return { error: 'not_found' }

    const members = await db.query(
      `SELECT 1
         FROM team_members
        WHERE team_id = $1
          AND status = 'active'
        LIMIT 1`,
      [teamId]
    )
    if ((members.rowCount ?? 0) > 0) return { error: 'team_not_empty' }

    const result = await db.query(`DELETE FROM teams WHERE id = $1 RETURNING id`, [teamId])
    const deleted = result.rows[0] as { id: string } | undefined
    return deleted ? { ok: true, id: String(deleted.id) } : { error: 'not_found' }
  })
}

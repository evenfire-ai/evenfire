import { type DbClient, pool, withTransaction } from '../../db.js'
import type { AdminDeleteTeamResult, TeamRole } from './types.js'

export class TeamNameConflictError extends Error {
  constructor(name: string) {
    super(`A team named "${name}" already exists`)
    this.name = 'TeamNameConflictError'
  }
}

export async function listTeams(userId: string, currentTeamId: string) {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
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
            COUNT(CASE WHEN tm.status = 'active' THEN 1 END) AS member_count
       FROM teams t
  LEFT JOIN team_members tm ON tm.team_id = t.id
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
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as { id: string; name: string; role: TeamRole } | undefined) || null
}

export async function createTeamWithDb(db: Pick<DbClient, 'query'>, name: string) {
  const normalizedName = name.trim()
  // Acquire the transaction-scoped lock in its own statement. PostgreSQL takes
  // a READ COMMITTED snapshot at the start of each statement, so combining the
  // lock and existence check in one CTE can retain a snapshot from before a
  // concurrent creator commits.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('team-name:' || LOWER(BTRIM($1))))`, [
    normalizedName,
  ])
  const team = await db.query(
    `INSERT INTO teams(name)
     SELECT $1
      WHERE NOT EXISTS (
        SELECT 1
          FROM teams
         WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1))
      )
     RETURNING id, name`,
    [normalizedName]
  )
  const created = team.rows[0] as { id: string; name: string } | undefined
  if (!created) throw new TeamNameConflictError(normalizedName)
  return created
}

export async function createTeam(name: string) {
  return withTransaction(db => createTeamWithDb(db, name))
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
  const normalizedName = name.trim()
  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('team-name:' || LOWER(BTRIM($1))))`, [
      normalizedName,
    ])
    const updated = await db.query(
      `UPDATE teams
          SET name = $2
        WHERE teams.id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM teams existing
             WHERE existing.id <> $1
               AND LOWER(BTRIM(existing.name)) = LOWER(BTRIM($2))
          )
      RETURNING id, name`,
      [teamId, normalizedName]
    )
    const renamed = updated.rows[0] as { id: string; name: string } | undefined
    if (renamed) return renamed
    const target = await db.query(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [teamId])
    if ((target.rowCount ?? 0) > 0) throw new TeamNameConflictError(normalizedName)
    return null
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

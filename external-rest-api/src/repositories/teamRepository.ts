import { pool } from '../db.js'

export type TeamRow = {
  id: string
  name: string
  role?: string
}

export type TeamMemberRow = {
  id: string
  email: string
  name: string | null
  role: string
  status: string
  display_name: string | null
  channels: unknown
}

export type RoleRow = {
  role: string
}

export type InvitationRow = {
  id: string
  team_id: string
  email: string
  role: string
  token: string
  status: string
  created_at: string
}

export type ExistingTeamMembershipRow = {
  team_id: string
  role: string
  name: string
}

export async function getTeamForUser(userId: string, teamId: string): Promise<TeamRow | null> {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as TeamRow | undefined) || null
}

export async function findFirstActiveTeamForUser(
  userId: string
): Promise<ExistingTeamMembershipRow | null> {
  const result = await pool.query(
    `SELECT tm.team_id, tm.role, t.name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
      LIMIT 1`,
    [userId]
  )
  return (result.rows[0] as ExistingTeamMembershipRow | undefined) || null
}

export async function createTeam(name: string): Promise<TeamRow> {
  const result = await pool.query(`INSERT INTO teams(name) VALUES($1) RETURNING id, name`, [name])
  return result.rows[0] as TeamRow
}

export async function addAdminMembership(teamId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
     VALUES($1, $2, 'admin', 'active')`,
    [teamId, userId]
  )
}

export async function renameTeam(teamId: string, name: string): Promise<TeamRow | null> {
  const result = await pool.query(
    `UPDATE teams
        SET name = $2
      WHERE id = $1
    RETURNING id, name`,
    [teamId, name]
  )
  return (result.rows[0] as TeamRow | undefined) || null
}

export async function listTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, tm.role, tm.status, p.display_name, p.channels
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
   ORDER BY u.email ASC`,
    [teamId]
  )
  return result.rows as TeamMemberRow[]
}

export async function findMemberRole(teamId: string, userId: string): Promise<RoleRow | null> {
  const result = await pool.query(
    `SELECT role
       FROM team_members
      WHERE team_id = $1
        AND user_id = $2
        AND status = 'active'
      LIMIT 1`,
    [teamId, userId]
  )
  return (result.rows[0] as RoleRow | undefined) || null
}

export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: string
): Promise<{
  team_id: string
  user_id: string
  role: string
  status: string
}> {
  const result = await pool.query(
    `UPDATE team_members
        SET role = $3,
            updated_at = NOW()
      WHERE team_id = $1
        AND user_id = $2
        AND status = 'active'
    RETURNING team_id, user_id, role, status`,
    [teamId, userId, role]
  )
  return result.rows[0] as { team_id: string; user_id: string; role: string; status: string }
}

export async function createInvitation(
  teamId: string,
  email: string,
  role: string,
  token: string
): Promise<InvitationRow> {
  const result = await pool.query(
    `INSERT INTO invitations(team_id, email, role, token, status)
     VALUES($1, $2, $3, $4, 'pending')
     RETURNING id, team_id, email, role, token, status, created_at`,
    [teamId, email, role, token]
  )
  return result.rows[0] as InvitationRow
}

export async function softDeleteMember(
  teamId: string,
  userId: string
): Promise<{ team_id: string; user_id: string; role: string; status: string } | null> {
  const result = await pool.query(
    `UPDATE team_members
        SET status = 'deleted',
            updated_at = NOW()
      WHERE team_id = $1
        AND user_id = $2
        AND status = 'active'
    RETURNING team_id, user_id, role, status`,
    [teamId, userId]
  )
  return (
    (result.rows[0] as
      | { team_id: string; user_id: string; role: string; status: string }
      | undefined) || null
  )
}

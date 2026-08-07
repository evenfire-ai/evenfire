import { pool } from '../db.js'

export type TeamListRow = {
  id: string
  name: string
  role: string
}

export type MembershipRow = {
  team_id: string
  role: string
  team_name: string
}

export type MeRow = {
  id: string
  email: string
  name: string | null
  picture: string | null
  role: string | null
  team_id: string | null
  team_name: string | null
  display_name: string | null
  channels: unknown
}

export type ProfileRow = {
  user_id: string
  display_name: string | null
  channels: unknown
}

export async function listActiveTeamsByUserId(userId: string): Promise<TeamListRow[]> {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
      ORDER BY t.created_at ASC`,
    [userId]
  )
  return result.rows as TeamListRow[]
}

export async function findMembership(
  userId: string,
  teamId: string
): Promise<MembershipRow | null> {
  const result = await pool.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as MembershipRow | undefined) || null
}

export async function getMe(userId: string, teamId: string): Promise<MeRow | null> {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture,
            tm.role, t.id AS team_id, t.name AS team_name,
            p.display_name, p.channels
       FROM users u
  LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = $2 AND tm.status = 'active'
  LEFT JOIN teams t ON t.id = tm.team_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as MeRow | undefined) || null
}

export async function upsertProfile(
  userId: string,
  displayName: string | null,
  channelsJson: string
): Promise<ProfileRow> {
  const result = await pool.query(
    `INSERT INTO profiles(user_id, display_name, channels)
     VALUES($1, $2, $3::jsonb)
     ON CONFLICT (user_id)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       channels = EXCLUDED.channels,
       updated_at = NOW()
     RETURNING user_id, display_name, channels`,
    [userId, displayName, channelsJson]
  )
  return result.rows[0] as ProfileRow
}

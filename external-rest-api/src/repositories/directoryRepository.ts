import { pool } from '../db.js'

export async function searchTeamDirectory(
  teamId: string,
  query: string
): Promise<
  Array<{
    id: string
    email: string
    name: string | null
    display_name: string | null
    channels: unknown
  }>
> {
  const rows = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name, p.channels
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
        AND (
          u.email ILIKE $2
          OR COALESCE(u.name, '') ILIKE $2
          OR COALESCE(p.display_name, '') ILIKE $2
        )
   ORDER BY COALESCE(p.display_name, u.name, u.email) ASC
      LIMIT 25`,
    [teamId, `%${query}%`]
  )
  return rows.rows as Array<{
    id: string
    email: string
    name: string | null
    display_name: string | null
    channels: unknown
  }>
}

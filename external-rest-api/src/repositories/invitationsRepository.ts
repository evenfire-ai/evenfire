import { pool } from '../db.js'
import { DbClient } from './dbClient.js'

export type PendingInviteRow = {
  id: string
  team_id: string
  email: string
  role: string
  token: string
  status: string
  created_at: string
  team_name: string
}

export type InvitationRow = {
  id: string
  team_id: string
  email: string
  role: string
  status: string
}

export async function listPendingInvitationsByEmail(email: string): Promise<PendingInviteRow[]> {
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.email, i.role, i.token, i.status, i.created_at,
            t.name AS team_name
       FROM invitations i
       JOIN teams t ON t.id = i.team_id
      WHERE i.email = $1
        AND i.status = 'pending'
      ORDER BY i.created_at DESC`,
    [email]
  )
  return result.rows as PendingInviteRow[]
}

export async function findInvitationByTokenOrId(
  token: string,
  invitationId: string
): Promise<InvitationRow | null> {
  const result = await pool.query(
    `SELECT id, team_id, email, role, status
       FROM invitations
      WHERE token = $1 OR id::text = $2
      LIMIT 1`,
    [token, invitationId]
  )
  return (result.rows[0] as InvitationRow | undefined) || null
}

export async function upsertMembershipFromInvitation(
  db: DbClient,
  teamId: string,
  userId: string,
  role: string
): Promise<void> {
  await db.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
     VALUES($1, $2, $3, 'active')
     ON CONFLICT (team_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()`,
    [teamId, userId, role]
  )
}

export async function markInvitationAccepted(db: DbClient, invitationId: string): Promise<void> {
  await db.query(
    `UPDATE invitations
        SET status = 'accepted',
            accepted_at = NOW()
      WHERE id = $1`,
    [invitationId]
  )
}

import { type DbClient, pool } from '../../db.js'
import { type InviteRole, normalizeTeamRoleInput } from './types.js'

export const INVITATION_TTL_HOURS = 7 * 24
const PASSWORD_RESET_INVITATION_TTL_HOURS = 48

export type InvitationRow = {
  id: string
  team_id: string | null
  invitee_name: string | null
  email: string
  role: InviteRole
  token: string
  status: string
  purpose: InvitationPurpose
  created_at: Date
  expires_at: Date
  accepted_at: Date | null
  accepted_user_id: string | null
  team_name: string | null
}

export type InvitationPurpose = 'member_invitation' | 'password_reset' | 'admin_desktop_access'

export type InvitationTeamAssignment = {
  teamId: string
  role: InviteRole
}

export type InvitationTeamRow = {
  team_id: string
  team_name: string
  role: InviteRole
}

export type InvitationUserRow = {
  id: string
  email: string
  name: string | null
  picture: string | null
  password_hash: string | null
  lifecycle_state?: 'active' | 'retired' | string | null
  lifecycle_version?: number | string | null
}

export type InvitationWithTeams = {
  invitation: InvitationRow
  teams: InvitationTeamRow[]
}

export type InvitationForTeamsInput = {
  inviteeName: string
  email: string
  teamAssignments?: readonly InvitationTeamAssignment[]
  purpose?: InvitationPurpose
  fallbackRole?: InviteRole
}

export function normalizeInvitationPurpose(purpose?: InvitationPurpose): InvitationPurpose {
  if (purpose === 'password_reset') return 'password_reset'
  if (purpose === 'admin_desktop_access') return 'admin_desktop_access'
  return 'member_invitation'
}

export async function getInvitationRecordByToken(
  db: Pick<DbClient, 'query'>,
  token: string
): Promise<InvitationRow | null> {
  const result = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at, i.accepted_at,
            i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.token = $1
      LIMIT 1`,
    [token]
  )
  return (result.rows[0] as InvitationRow | undefined) || null
}

export async function getInvitationRecordByTokenOrId(
  db: Pick<DbClient, 'query'>,
  token: string,
  invitationId: string
): Promise<InvitationRow | null> {
  const normalizedToken = token.trim()
  const normalizedInvitationId = invitationId.trim()
  if (!normalizedToken && !normalizedInvitationId) {
    return null
  }

  const result = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at, i.accepted_at,
            i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE ($1 <> '' AND i.token = $1)
         OR ($2 <> '' AND i.id::text = $2)
      ORDER BY i.created_at DESC
      LIMIT 1`,
    [normalizedToken, normalizedInvitationId]
  )

  return (result.rows[0] as InvitationRow | undefined) || null
}

export async function getInvitationRecordById(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  lockForUpdate = false
): Promise<InvitationRow | null> {
  const normalizedInvitationId = invitationId.trim()
  if (!normalizedInvitationId) return null

  const result = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at, i.accepted_at,
            i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.id::text = $1
      LIMIT 1
      ${lockForUpdate ? 'FOR UPDATE OF i' : ''}`,
    [normalizedInvitationId]
  )
  return (result.rows[0] as InvitationRow | undefined) || null
}

export async function lockPasswordResetUser(
  db: Pick<DbClient, 'query'>,
  email: string
): Promise<InvitationUserRow | null> {
  const result = await db.query(
    `SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version
       FROM users
      WHERE email = $1
      LIMIT 1
      FOR NO KEY UPDATE`,
    [email]
  )
  return (result.rows[0] as InvitationUserRow | undefined) ?? null
}

export async function ensureInvitationUser(
  db: Pick<DbClient, 'query'>,
  email: string,
  inviteeName: string | null
): Promise<InvitationUserRow> {
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedInviteeName = String(inviteeName || '').trim() || null
  const existing = await db.query(
    `SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [normalizedEmail]
  )

  let user = (existing.rows[0] as InvitationUserRow | undefined) || null
  if (!user) {
    user = (
      await db.query(
        `INSERT INTO users(email, name)
       VALUES($1, $2)
       ON CONFLICT (email) DO UPDATE
           SET name = COALESCE(users.name, EXCLUDED.name),
               updated_at = NOW()
       RETURNING id, email, name, picture, password_hash, lifecycle_state, lifecycle_version`,
        [normalizedEmail, normalizedInviteeName]
      )
    ).rows[0] as InvitationUserRow
  } else if (normalizedInviteeName && !user.name) {
    user = (
      await db.query(
        `UPDATE users
            SET name = $2,
                updated_at = NOW()
          WHERE id = $1
       RETURNING id, email, name, picture, password_hash, lifecycle_state, lifecycle_version`,
        [user.id, normalizedInviteeName]
      )
    ).rows[0] as InvitationUserRow
  }

  await db.query(
    `INSERT INTO profiles(user_id, display_name)
     VALUES($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, user.name || null]
  )
  if (normalizedInviteeName) {
    await db.query(
      `UPDATE profiles
          SET display_name = $2,
              updated_at = NOW()
        WHERE user_id = $1
          AND display_name IS NULL`,
      [user.id, normalizedInviteeName]
    )
  }

  return user
}

export function invitationUserIsRetired(user: InvitationUserRow): boolean {
  return user.lifecycle_state === 'retired'
}

export function normalizeInvitationTeamAssignments(
  assignments: readonly InvitationTeamAssignment[] | null | undefined
): InvitationTeamAssignment[] {
  const byTeamId = new Map<string, InviteRole>()
  for (const assignment of assignments || []) {
    const teamId = String(assignment?.teamId || '').trim()
    const role = normalizeTeamRoleInput(assignment?.role)
    if (!teamId || !role) continue
    byTeamId.set(teamId, role)
  }
  return Array.from(byTeamId.entries()).map(([teamId, role]) => ({ teamId, role }))
}

export async function loadInvitationTeams(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  fallback?: Pick<InvitationRow, 'team_id' | 'team_name' | 'role'>
): Promise<InvitationTeamRow[]> {
  const result = await db.query(
    `SELECT it.team_id, t.name AS team_name, it.role
       FROM invitation_teams it
       JOIN teams t ON t.id = it.team_id
      WHERE it.invitation_id = $1
      ORDER BY CASE WHEN it.team_id = $2::uuid THEN 0 ELSE 1 END, t.name ASC`,
    [invitationId, fallback?.team_id || null]
  )
  const rows = result.rows as InvitationTeamRow[]
  if (rows.length > 0) return rows
  if (fallback?.team_id) {
    return [
      {
        team_id: fallback.team_id,
        team_name: fallback.team_name || 'Team',
        role: fallback.role,
      },
    ]
  }
  return []
}

export async function insertInvitationTeams(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  assignments: readonly InvitationTeamAssignment[]
): Promise<void> {
  if (assignments.length === 0) return
  await db.query(
    `INSERT INTO invitation_teams(invitation_id, team_id, role)
     SELECT $1::uuid, item.team_id::uuid, item.role
       FROM jsonb_to_recordset($2::jsonb) AS item(team_id text, role text)
     ON CONFLICT (invitation_id, team_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [
      invitationId,
      JSON.stringify(assignments.map(item => ({ team_id: item.teamId, role: item.role }))),
    ]
  )
}

export function invitationResponse(
  invitation: InvitationRow,
  user: InvitationUserRow | null,
  teams: InvitationTeamRow[] = []
): {
  id: string
  teamId: string | null
  teamName: string | null
  teams: Array<{ id: string; name: string; role: InviteRole }>
  email: string
  role: InviteRole
  purpose: InvitationPurpose
  status: string
  expiresAt: string
  acceptedAt: string | null
  userId: string | null
  passwordPending: boolean
  authGeneration: number | null
  lifecycleState: string | null
} {
  const primaryTeam = teams[0] || null
  return {
    id: invitation.id,
    teamId: primaryTeam?.team_id || invitation.team_id,
    teamName: primaryTeam?.team_name || invitation.team_name,
    teams: teams.map(team => ({
      id: team.team_id,
      name: team.team_name,
      role: team.role,
    })),
    email: invitation.email,
    role: primaryTeam?.role || invitation.role,
    purpose: invitation.purpose,
    status: invitation.status,
    expiresAt: invitation.expires_at.toISOString(),
    acceptedAt: invitation.accepted_at ? invitation.accepted_at.toISOString() : null,
    userId: invitation.accepted_user_id || user?.id || null,
    passwordPending: !user?.password_hash,
    authGeneration:
      user?.lifecycle_version === undefined || user.lifecycle_version === null
        ? null
        : Number(user.lifecycle_version),
    lifecycleState: user?.lifecycle_state ?? null,
  }
}

export async function insertInvitationForTeams(
  db: Pick<DbClient, 'query'>,
  input: InvitationForTeamsInput & { status: 'draft' | 'pending' }
): Promise<InvitationWithTeams> {
  const normalizedAssignments = normalizeInvitationTeamAssignments(input.teamAssignments)
  const primaryAssignment = normalizedAssignments[0] || null
  const fallbackRole =
    normalizeTeamRoleInput(input.fallbackRole) || primaryAssignment?.role || 'member'
  const purpose = normalizeInvitationPurpose(input.purpose)
  const ttlHours =
    purpose === 'password_reset' ? PASSWORD_RESET_INVITATION_TTL_HOURS : INVITATION_TTL_HOURS
  const invited = await db.query(
    `WITH inserted AS (
       INSERT INTO invitations(team_id, invitee_name, email, role, token, status, purpose, expires_at)
       VALUES($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, NOW() + ($7::text || ' hours')::interval)
       RETURNING id, team_id, invitee_name, email, role, token, status, purpose, created_at, expires_at, accepted_at, accepted_user_id
     )
     SELECT inserted.id,
            inserted.team_id,
            inserted.invitee_name,
            inserted.email,
            inserted.role,
            inserted.token,
            inserted.status,
            inserted.purpose,
            inserted.created_at,
            inserted.expires_at,
            inserted.accepted_at,
            inserted.accepted_user_id,
            t.name AS team_name
       FROM inserted
  LEFT JOIN teams t ON t.id = inserted.team_id`,
    [
      primaryAssignment?.teamId || null,
      input.inviteeName.trim(),
      input.email.trim().toLowerCase(),
      primaryAssignment?.role || fallbackRole,
      input.status,
      purpose,
      String(ttlHours),
    ]
  )
  const invitation = invited.rows[0] as InvitationRow
  await insertInvitationTeams(db, invitation.id, normalizedAssignments)
  return {
    invitation,
    teams: await loadInvitationTeams(db, invitation.id, invitation),
  }
}

export function invitationForTeamsResponse(invitation: InvitationRow, teams: InvitationTeamRow[]) {
  return {
    ...invitation,
    teams: teams.map(team => ({
      id: team.team_id,
      name: team.team_name,
      role: team.role,
    })),
  }
}

const DRAFT_INVITATION_CLEANUP_HOURS = 24

export async function cleanupStaleDraftInvitations(): Promise<void> {
  await pool.query(
    `DELETE FROM invitations
      WHERE status = 'draft'
        AND created_at < NOW() - ($1::text || ' hours')::interval`,
    [String(DRAFT_INVITATION_CLEANUP_HOURS)]
  )
}

export type GenericInvitationPurpose = Exclude<InvitationPurpose, 'password_reset'>
export type GenericInvitationForTeamsInput = Omit<InvitationForTeamsInput, 'purpose'> & {
  purpose?: GenericInvitationPurpose
}

export async function activateDraftInvitation(
  db: Pick<DbClient, 'query'>,
  invitationId: string
): Promise<InvitationRow | undefined> {
  const activated = await db.query(
    `UPDATE invitations
        SET status = 'pending'
      WHERE id = $1
        AND status = 'draft'
      RETURNING id, team_id, invitee_name, email, role, token, status, purpose, created_at, expires_at, accepted_at, accepted_user_id`,
    [invitationId]
  )
  return activated.rows[0] as InvitationRow | undefined
}

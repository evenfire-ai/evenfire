import { type DbClient, pool, withTransaction } from '../../db.js'
import { registerAndSendInvitation } from '../invitationFlowRegistrationService.js'
import { appendControlApiPermissionEventsInTransaction } from '../tracing/controlApiPermissionEvents.js'
import {
  type GenericInvitationForTeamsInput,
  type GenericInvitationPurpose,
  type InvitationPurpose,
  type InvitationRow,
  type InvitationTeamAssignment,
  type InvitationTeamRow,
  type InvitationUserRow,
  type InvitationWithTeams,
  activateDraftInvitation,
  cleanupStaleDraftInvitations,
  ensureInvitationUser,
  getInvitationRecordById,
  getInvitationRecordByToken,
  getInvitationRecordByTokenOrId,
  insertInvitationForTeams,
  invitationForTeamsResponse,
  invitationResponse,
  invitationUserIsRetired,
  loadInvitationTeams,
  normalizeInvitationPurpose,
  normalizeInvitationTeamAssignments,
} from './invitationStore.js'
import type { InviteRole, TeamRole } from './types.js'
import {
  normalizeChannels,
  normalizeTeamRoleInput,
  roleCanDeleteMembers,
  roleCanInviteMembers,
} from './types.js'
import { DesktopUserRetirementError, retireDesktopUser } from './users.js'

export { INVITATION_TTL_HOURS } from './invitationStore.js'
export type { InvitationPurpose, InvitationTeamAssignment } from './invitationStore.js'
export {
  setInvitationPasswordForUser,
  setInvitationPasswordForEmail,
  updateUserPassword,
} from './memberPassword.js'
export { withPasswordWorkLease as withMemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'
export type { MemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'

const DRAFT_INVITATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
let draftInvitationCleanupTimer: ReturnType<typeof setInterval> | null = null

export function startDraftInvitationCleanup(intervalMs = DRAFT_INVITATION_CLEANUP_INTERVAL_MS) {
  if (draftInvitationCleanupTimer) return
  cleanupStaleDraftInvitations().catch(() => undefined)
  draftInvitationCleanupTimer = setInterval(() => {
    cleanupStaleDraftInvitations().catch(() => undefined)
  }, intervalMs)
  draftInvitationCleanupTimer.unref?.()
}

export function stopDraftInvitationCleanup() {
  if (!draftInvitationCleanupTimer) return
  clearInterval(draftInvitationCleanupTimer)
  draftInvitationCleanupTimer = null
}

async function loadInvitationTeamsByInvitationIds(
  db: Pick<DbClient, 'query'>,
  invitationIds: readonly string[]
): Promise<Map<string, InvitationTeamRow[]>> {
  const byInvitationId = new Map<string, InvitationTeamRow[]>()
  if (invitationIds.length === 0) return byInvitationId

  const result = await db.query(
    `SELECT it.invitation_id, it.team_id, t.name AS team_name, it.role
       FROM invitation_teams it
       JOIN teams t ON t.id = it.team_id
      WHERE it.invitation_id = ANY($1::uuid[])
      ORDER BY it.invitation_id ASC, t.name ASC`,
    [invitationIds]
  )
  for (const row of result.rows as Array<InvitationTeamRow & { invitation_id: string }>) {
    const rows = byInvitationId.get(row.invitation_id) || []
    rows.push({
      team_id: row.team_id,
      team_name: row.team_name,
      role: row.role,
    })
    byInvitationId.set(row.invitation_id, rows)
  }
  return byInvitationId
}

async function invitationListResponse(rows: InvitationRow[]) {
  const teamsByInvitationId = await loadInvitationTeamsByInvitationIds(
    pool,
    rows.map(row => row.id)
  )
  return rows.map(row => ({
    ...row,
    teams: (teamsByInvitationId.get(row.id) || []).map(team => ({
      id: team.team_id,
      name: team.team_name,
      role: team.role,
    })),
  }))
}

async function applyInvitationMemberships(
  db: Pick<DbClient, 'query'>,
  invitation: InvitationRow,
  userId: string
): Promise<InvitationTeamRow[]> {
  const teams = await loadInvitationTeams(db, invitation.id, invitation)
  if (teams.length === 0) return teams

  await db.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
     SELECT item.team_id::uuid, $2::uuid, item.role, 'active'
       FROM jsonb_to_recordset($1::jsonb) AS item(team_id text, role text)
     ON CONFLICT (team_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()`,
    [JSON.stringify(teams.map(team => ({ team_id: team.team_id, role: team.role }))), userId]
  )

  return teams
}

export async function findMembership(userId: string, teamId: string) {
  const result = await pool.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (
    (result.rows[0] as { team_id: string; role: TeamRole; team_name: string } | undefined) || null
  )
}

export async function getMe(userId: string, teamId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture,
            tm.role, t.id AS team_id, t.name AS team_name,
            p.display_name, p.channels
       FROM users u
  LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id::text = $2 AND tm.status = 'active'
  LEFT JOIN teams t ON t.id = tm.team_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1
        AND u.lifecycle_state = 'active'
      LIMIT 1`,
    [userId, teamId]
  )

  const row = result.rows[0] as
    | {
        id: string
        email: string
        name: string | null
        picture: string | null
        role: TeamRole | null
        team_id: string | null
        team_name: string | null
        display_name: string | null
        channels: unknown
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    role: row.role || null,
    profile: {
      displayName: row.display_name || row.name || row.email,
      channels: normalizeChannels(row.channels),
    },
  }
}

export async function updateProfile(userId: string, displayName: string, channelsInput: unknown) {
  const channels = normalizeChannels(channelsInput)
  const updated = await pool.query(
    `INSERT INTO profiles(user_id, display_name, channels)
     VALUES($1, $2, $3::jsonb)
     ON CONFLICT (user_id)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       channels = EXCLUDED.channels,
       updated_at = NOW()
     RETURNING user_id, display_name, channels`,
    [userId, displayName || null, JSON.stringify(channels)]
  )
  const row = updated.rows[0] as { user_id: string; display_name: string | null; channels: unknown }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    channels: normalizeChannels(row.channels),
  }
}

export async function listMembers(teamId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, tm.role, tm.status
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
   ORDER BY u.email ASC`,
    [teamId]
  )
  return result.rows
}

export async function findMemberRole(teamId: string, userId: string) {
  const result = await pool.query(
    `SELECT role
       FROM team_members
       JOIN users u ON u.id = team_members.user_id
      WHERE team_id = $1
        AND user_id = $2
        AND status = 'active'
        AND u.lifecycle_state = 'active'
      LIMIT 1`,
    [teamId, userId]
  )
  return (result.rows[0] as { role: TeamRole } | undefined) || null
}

export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
  operatorSub: string
) {
  return withTransaction(async db => {
    const before = await db.query(
      `SELECT role
         FROM team_members
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
        FOR UPDATE`,
      [teamId, userId]
    )
    const previousRole = (before.rows[0] as { role: TeamRole } | undefined)?.role ?? null
    const result = await db.query(
      `UPDATE team_members
          SET role = $3,
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [teamId, userId, role]
    )
    if ((result.rowCount ?? 0) > 0 && previousRole && previousRole !== role) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub,
        changes: [
          {
            action: 'revoke',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${previousRole}`,
            subject: { kind: 'user', id: userId },
            teamId,
            status: 'role_replaced',
          },
          {
            action: 'grant',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${role}`,
            subject: { kind: 'user', id: userId },
            teamId,
            status: 'role_assigned',
          },
        ],
      })
    }
    return result.rows[0]
  })
}

export async function addMemberToTeam(
  teamId: string,
  userId: string,
  operatorSub: string,
  role: TeamRole = 'member'
) {
  return withTransaction(async db => {
    const before = await db.query(
      `SELECT role, status
         FROM team_members
        WHERE team_id = $1 AND user_id = $2
        FOR UPDATE`,
      [teamId, userId]
    )
    const previous = before.rows[0] as { role: TeamRole; status: string } | undefined
    const result = await db.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $2, $3, 'active')
       ON CONFLICT (team_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()
       RETURNING team_id, user_id, role, status`,
      [teamId, userId, role]
    )
    const changes = []
    if (previous?.status === 'active' && previous.role !== role) {
      changes.push({
        action: 'revoke' as const,
        resourceClass: 'team_membership',
        resourceRef: `team_membership:${teamId}:role:${previous.role}`,
        subject: { kind: 'user' as const, id: userId },
        teamId,
        status: 'role_replaced',
      })
    }
    if (!previous || previous.status !== 'active' || previous.role !== role) {
      changes.push({
        action: 'grant' as const,
        resourceClass: 'team_membership',
        resourceRef: `team_membership:${teamId}:role:${role}`,
        subject: { kind: 'user' as const, id: userId },
        teamId,
        status: previous?.status === 'active' ? 'role_assigned' : 'membership_activated',
      })
    }
    await appendControlApiPermissionEventsInTransaction(db, { operatorSub, changes })
    return result.rows[0]
  })
}

async function createInvitationForTeamsRecord(
  input: GenericInvitationForTeamsInput,
  options: { sendEmail: boolean }
) {
  cleanupStaleDraftInvitations().catch(() => undefined)
  const purpose = normalizeInvitationPurpose(input.purpose)
  const inserted = await withTransaction(async db => {
    return insertInvitationForTeams(db, {
      ...input,
      purpose,
      status: options.sendEmail ? 'draft' : 'pending',
    })
  })

  if (!options.sendEmail) {
    return invitationForTeamsResponse(inserted.invitation, inserted.teams)
  }

  await registerAndSendInvitation(
    inserted.invitation.email,
    inserted.invitation.token,
    inserted.teams.length > 0
      ? inserted.teams.map(team => team.team_name).join(', ')
      : inserted.invitation.team_name,
    inserted.invitation.created_at.toISOString(),
    inserted.invitation.expires_at.toISOString(),
    {
      purpose,
      teamNames: inserted.teams.map(team => team.team_name),
    }
  )

  const pending = await activateDraftInvitation(pool, inserted.invitation.id)
  if (!pending) {
    throw new Error('Failed to activate invitation after registration')
  }
  return invitationForTeamsResponse(
    {
      ...pending,
      team_name: inserted.invitation.team_name,
    },
    inserted.teams
  )
}

export async function createInvitation(
  teamId: string | null | undefined,
  inviteeName: string,
  email: string,
  role: InviteRole
) {
  const normalizedRole = normalizeTeamRoleInput(role) || 'member'
  const normalizedTeamId = String(teamId || '').trim()
  return createInvitationForTeams({
    inviteeName,
    email,
    purpose: 'member_invitation',
    teamAssignments: normalizedTeamId ? [{ teamId: normalizedTeamId, role: normalizedRole }] : [],
    fallbackRole: normalizedRole,
  })
}

export async function createInvitationForTeams(input: {
  inviteeName: string
  email: string
  teamAssignments?: readonly InvitationTeamAssignment[]
  purpose?: GenericInvitationPurpose
  fallbackRole?: InviteRole
}) {
  return createInvitationForTeamsRecord(input, { sendEmail: true })
}

export async function createSilentInvitationForTeams(input: {
  inviteeName: string
  email: string
  teamAssignments?: readonly InvitationTeamAssignment[]
  fallbackRole?: InviteRole
  purpose?: GenericInvitationPurpose
}) {
  return createInvitationForTeamsRecord(input, { sendEmail: false })
}

export async function getPendingMemberInvitationForEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE lower(i.email) = lower($1)
        AND i.status = 'pending'
        AND i.purpose = 'admin_desktop_access'
        AND i.expires_at > NOW()
      ORDER BY i.created_at DESC
      LIMIT 1`,
    [normalizedEmail]
  )
  const invitation = result.rows[0] as InvitationRow | undefined
  if (!invitation) return null
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)
  return invitationResponse(invitation, null, teams)
}

export async function createPasswordSetupInvitationForUser(userId: string) {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) {
    return { error: 'not_found' as const }
  }

  const userResult = await pool.query(
    `SELECT id, email, password_hash
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [normalizedUserId]
  )
  const user =
    (userResult.rows[0] as
      | { id: string; email: string; password_hash: string | null }
      | undefined) || null
  if (!user) {
    return { error: 'not_found' as const }
  }
  if (user.password_hash) {
    return { error: 'password_already_set' as const }
  }

  const invitationResult = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at, i.accepted_at,
            i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.status = 'accepted'
        AND (
          i.accepted_user_id = $1
          OR LOWER(i.email) = LOWER($2)
        )
      ORDER BY i.accepted_at DESC NULLS LAST, i.created_at DESC
      LIMIT 1`,
    [normalizedUserId, user.email]
  )
  const acceptedInvitation = (invitationResult.rows[0] as InvitationRow | undefined) || null
  if (!acceptedInvitation) {
    return { error: 'no_accepted_invitation' as const }
  }

  const teams = await loadInvitationTeams(pool, acceptedInvitation.id, acceptedInvitation)
  const fallbackName = acceptedInvitation.email.split('@')[0] || acceptedInvitation.email
  const created = await createInvitationForTeams({
    inviteeName: acceptedInvitation.invitee_name || fallbackName,
    email: acceptedInvitation.email,
    teamAssignments: teams.map(team => ({ teamId: team.team_id, role: team.role })),
    fallbackRole: acceptedInvitation.role,
  })
  return {
    sent: true as const,
    id: created.id,
    email: created.email,
    teamId: created.team_id,
  }
}

export async function softDeleteMember(teamId: string, userId: string, operatorSub: string) {
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE team_members
          SET status = 'deleted',
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [teamId, userId]
    )
    const deleted =
      (result.rows[0] as
        | { team_id: string; user_id: string; role: TeamRole; status: string }
        | undefined) ?? null
    if (deleted) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub,
        changes: [
          {
            action: 'revoke',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${deleted.role}`,
            subject: { kind: 'user', id: userId },
            teamId,
            status: 'membership_removed',
          },
        ],
      })
    }
    return deleted
  })
}

export async function listPendingInvitations(email: string) {
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.email = $1
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      ORDER BY i.created_at DESC`,
    [email.toLowerCase()]
  )
  return invitationListResponse(result.rows as InvitationRow[])
}

export async function listPendingInvitationsForTeam(teamId: string) {
  const result = await pool.query(
    `SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN invitation_teams it ON it.invitation_id = i.id
      WHERE (i.team_id = $1 OR it.team_id = $1)
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      ORDER BY i.created_at ASC`,
    [teamId]
  )
  return invitationListResponse(result.rows as InvitationRow[])
}

export async function listAllPendingInvitationsAdmin() {
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      ORDER BY COALESCE(t.name, '') ASC, i.created_at ASC`
  )
  return invitationListResponse(result.rows as InvitationRow[])
}

export async function resendInvitation(teamId: string | null | undefined, invitationId: string) {
  const normalizedTeamId = String(teamId || '').trim()
  const result = await pool.query(
    `SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN invitation_teams it ON it.invitation_id = i.id
      WHERE i.id = $1
        AND (
          ($2 = '' AND i.team_id IS NULL)
          OR i.team_id::text = $2
          OR it.team_id::text = $2
        )
        AND i.status = 'pending'
        AND i.expires_at > NOW()
      LIMIT 1`,
    [invitationId.trim(), normalizedTeamId]
  )

  const invitation = (result.rows[0] as InvitationRow | undefined) || null
  if (!invitation) {
    return null
  }
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)

  await registerAndSendInvitation(
    invitation.email,
    invitation.token,
    teams.length > 0 ? teams.map(team => team.team_name).join(', ') : invitation.team_name,
    new Date().toISOString(),
    invitation.expires_at.toISOString(),
    {
      purpose: invitation.purpose,
      teamNames: teams.map(team => team.team_name),
    }
  )

  return {
    id: invitation.id,
    email: invitation.email,
  }
}

export async function revokePendingInvitation(
  teamId: string | null | undefined,
  invitationId: string
) {
  const normalizedTeamId = String(teamId || '').trim()
  const result = await pool.query(
    `UPDATE invitations
        SET status = 'revoked'
      WHERE id = $1
        AND (
          ($2 = '' AND team_id IS NULL)
          OR team_id::text = $2
          OR EXISTS (
            SELECT 1
              FROM invitation_teams it
             WHERE it.invitation_id = invitations.id
               AND it.team_id::text = $2
          )
        )
        AND status = 'pending'
      RETURNING id, email`,
    [invitationId.trim(), normalizedTeamId]
  )
  return (result.rows[0] as { id: string; email: string } | undefined) || null
}

async function invitationResponseForActiveRecord(invitation: InvitationRow | null) {
  if (!invitation) return null
  if (invitation.status === 'draft' || invitation.status === 'revoked') return null
  if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
    return null
  }
  const user = invitation.accepted_user_id
    ? ((
        await pool.query(
          `SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version
           FROM users
          WHERE id = $1
          LIMIT 1`,
          [invitation.accepted_user_id]
        )
      ).rows[0] as InvitationUserRow | undefined) || null
    : ((
        await pool.query(
          `SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version
           FROM users
          WHERE email = $1
          LIMIT 1`,
          [invitation.email.toLowerCase()]
        )
      ).rows[0] as InvitationUserRow | undefined) || null
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)
  return invitationResponse(invitation, user, teams)
}

export async function getInvitationByToken(token: string) {
  return invitationResponseForActiveRecord(await getInvitationRecordByToken(pool, token.trim()))
}

export async function acceptInvitation(
  userId: string,
  email: string,
  token: string,
  invitationId: string
) {
  return withTransaction(async db => {
    const invitation = await getInvitationRecordByTokenOrId(db, token, invitationId)
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return { error: 'forbidden' as const }
    }
    if (invitation.purpose === 'password_reset') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'revoked') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'draft') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (invitationUserIsRetired(user)) return { error: 'user_retired' as const }
    if (user.id !== userId) {
      return { error: 'forbidden' as const }
    }

    if (invitation.status === 'pending') {
      await applyInvitationMemberships(db, invitation, user.id)

      await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1`,
        [invitation.id, user.id]
      )
    } else if (invitation.status === 'accepted' && !invitation.accepted_user_id) {
      await db.query(`UPDATE invitations SET accepted_user_id = $2 WHERE id = $1`, [
        invitation.id,
        user.id,
      ])
    }

    const refreshed = await getInvitationRecordByToken(db, invitation.token)
    if (!refreshed) {
      return { error: 'not_found' as const }
    }
    const teams = await loadInvitationTeams(db, refreshed.id, refreshed)
    const payload = invitationResponse(refreshed, user, teams)

    return {
      data: {
        accepted: true as const,
        ...payload,
      },
    }
  })
}

export async function acceptInvitationForEmail(email: string, token: string, invitationId = '') {
  return withTransaction(async db => {
    const invitation = await getInvitationRecordByTokenOrId(db, token, invitationId)
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return { error: 'forbidden' as const }
    }
    if (invitation.purpose === 'password_reset') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'revoked' || invitation.status === 'draft') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (invitationUserIsRetired(user)) return { error: 'user_retired' as const }

    if (invitation.status === 'pending') {
      await applyInvitationMemberships(db, invitation, user.id)

      await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1`,
        [invitation.id, user.id]
      )
    } else if (invitation.status === 'accepted' && !invitation.accepted_user_id) {
      await db.query(`UPDATE invitations SET accepted_user_id = $2 WHERE id = $1`, [
        invitation.id,
        user.id,
      ])
    }

    const refreshed = await getInvitationRecordByToken(db, invitation.token)
    if (!refreshed) {
      return { error: 'not_found' as const }
    }
    const teams = await loadInvitationTeams(db, refreshed.id, refreshed)
    const payload = invitationResponse(refreshed, user, teams)

    return {
      data: {
        accepted: true as const,
        ...payload,
        userId: user.id,
      },
    }
  })
}

export async function acceptInvitationById(email: string, invitationId: string) {
  return withTransaction(async db => {
    const invitation = await getInvitationRecordById(db, invitationId)
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return { error: 'forbidden' as const }
    }
    if (invitation.purpose === 'password_reset') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'revoked' || invitation.status === 'draft') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (invitationUserIsRetired(user)) return { error: 'user_retired' as const }

    if (invitation.status === 'pending') {
      await applyInvitationMemberships(db, invitation, user.id)

      await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1`,
        [invitation.id, user.id]
      )
    } else if (invitation.status === 'accepted' && !invitation.accepted_user_id) {
      await db.query(`UPDATE invitations SET accepted_user_id = $2 WHERE id = $1`, [
        invitation.id,
        user.id,
      ])
    }

    const refreshed = await getInvitationRecordByToken(db, invitation.token)
    if (!refreshed) {
      return { error: 'not_found' as const }
    }
    const teams = await loadInvitationTeams(db, refreshed.id, refreshed)
    const payload = invitationResponse(refreshed, user, teams)

    return {
      data: {
        accepted: true as const,
        ...payload,
        userId: user.id,
      },
    }
  })
}

export async function searchDirectory(teamId: string, q: string) {
  const query = q.trim()
  if (!query) return []

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name, p.channels
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
        AND (
          u.email ILIKE $2
          OR COALESCE(u.name, '') ILIKE $2
          OR COALESCE(p.display_name, '') ILIKE $2
        )
   ORDER BY COALESCE(p.display_name, u.name, u.email) ASC
      LIMIT 25`,
    [teamId, `%${query}%`]
  )
  return result.rows
}

export async function listManageableTeamsForUser(userId: string) {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
        AND tm.role IN ('admin', 'inviter')
        AND u.lifecycle_state = 'active'
      ORDER BY t.name ASC`,
    [userId.trim()]
  )
  return (result.rows as Array<{ id: string; name: string; role: TeamRole }>).map(row => ({
    id: row.id,
    name: row.name,
    role: row.role,
    canAssignLeader: roleCanDeleteMembers(row.role),
  }))
}

export async function listManagedMembersForUser(userId: string, targetUserId?: string) {
  const normalizedUserId = userId.trim()
  const normalizedTargetUserId = String(targetUserId || '').trim()
  const result = normalizedTargetUserId
    ? await pool.query(
        `WITH managed_teams AS (
         SELECT tm.team_id, tm.role AS manager_role, t.name AS team_name
             FROM team_members tm
             JOIN teams t ON t.id = tm.team_id
             JOIN users manager ON manager.id = tm.user_id
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND tm.role IN ('admin', 'inviter')
              AND manager.lifecycle_state = 'active'
         ),
         eligible_target AS (
           SELECT 1
             FROM managed_teams mt
             JOIN team_members target_visible
               ON target_visible.team_id = mt.team_id
              AND target_visible.user_id::text = $2
              AND target_visible.status = 'active'
            LIMIT 1
         )
         SELECT u.id,
                u.email,
                u.name,
                u.picture,
                p.display_name,
                EXISTS (
                  SELECT 1
                    FROM invitations i
                   WHERE i.status = 'accepted'
                     AND (
                       i.accepted_user_id = u.id
                       OR LOWER(i.email) = LOWER(u.email)
                     )
                     AND u.password_hash IS NULL
                ) AS password_pending_from_accepted_invitation,
                jsonb_agg(
                  jsonb_build_object(
                    'id', t.id,
                    'name', t.name,
                    'role', target_tm.role,
                    'managerRole', COALESCE(mt.manager_role, 'member')
                  )
                  ORDER BY t.name ASC
                ) AS teams
           FROM users u
           JOIN team_members target_tm ON target_tm.user_id = u.id AND target_tm.status = 'active'
           JOIN teams t ON t.id = target_tm.team_id
      LEFT JOIN managed_teams mt ON mt.team_id = target_tm.team_id
      LEFT JOIN profiles p ON p.user_id = u.id
          WHERE u.id::text = $2
            AND u.lifecycle_state = 'active'
            AND EXISTS (SELECT 1 FROM eligible_target)
       GROUP BY u.id, u.email, u.name, u.picture, p.display_name
       ORDER BY COALESCE(p.display_name, u.name, u.email) ASC`,
        [normalizedUserId, normalizedTargetUserId]
      )
    : await pool.query(
        `WITH managed_teams AS (
           SELECT tm.team_id, tm.role AS manager_role, t.name AS team_name
             FROM team_members tm
             JOIN teams t ON t.id = tm.team_id
             JOIN users manager ON manager.id = tm.user_id
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND tm.role IN ('admin', 'inviter')
              AND manager.lifecycle_state = 'active'
         ),
         visible_users AS (
           SELECT DISTINCT target_tm.user_id
             FROM managed_teams mt
             JOIN team_members target_tm
               ON target_tm.team_id = mt.team_id
              AND target_tm.status = 'active'
             JOIN users visible ON visible.id = target_tm.user_id
              AND visible.lifecycle_state = 'active'
         )
         SELECT u.id,
                u.email,
                u.name,
                u.picture,
                p.display_name,
                EXISTS (
                  SELECT 1
                    FROM invitations i
                   WHERE i.status = 'accepted'
                     AND (
                       i.accepted_user_id = u.id
                       OR LOWER(i.email) = LOWER(u.email)
                     )
                     AND u.password_hash IS NULL
                ) AS password_pending_from_accepted_invitation,
                jsonb_agg(
                  jsonb_build_object(
                    'id', t.id,
                    'name', t.name,
                    'role', target_tm.role,
                    'managerRole', COALESCE(mt.manager_role, 'member')
                  )
                  ORDER BY t.name ASC
                ) AS teams
           FROM visible_users vu
           JOIN team_members target_tm
             ON target_tm.user_id = vu.user_id
            AND target_tm.status = 'active'
           JOIN teams t ON t.id = target_tm.team_id
           JOIN users u ON u.id = target_tm.user_id
      LEFT JOIN managed_teams mt ON mt.team_id = target_tm.team_id
      LEFT JOIN profiles p ON p.user_id = u.id
       GROUP BY u.id, u.email, u.name, u.picture, p.display_name
       ORDER BY COALESCE(p.display_name, u.name, u.email) ASC`,
        [normalizedUserId]
      )
  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    email: String((row as { email: string }).email),
    name: ((row as { name?: string | null }).name ?? null) as string | null,
    picture: ((row as { picture?: string | null }).picture ?? null) as string | null,
    displayName: ((row as { display_name?: string | null }).display_name ?? null) as string | null,
    passwordPendingFromAcceptedInvitation: Boolean(
      (row as { password_pending_from_accepted_invitation?: unknown })
        .password_pending_from_accepted_invitation
    ),
    teams: (Array.isArray((row as { teams?: unknown }).teams)
      ? (row as { teams: unknown[] }).teams
      : []
    ).map(teamValue => {
      const team =
        teamValue && typeof teamValue === 'object' ? (teamValue as Record<string, unknown>) : {}
      const role = normalizeTeamRoleInput(team.role) || 'member'
      const managerRole = normalizeTeamRoleInput(team.managerRole) || 'member'
      return {
        id: String(team.id || ''),
        name: String(team.name || ''),
        role,
        managerRole,
        canEdit: roleCanDeleteMembers(managerRole),
        canDelete: roleCanDeleteMembers(managerRole),
      }
    }),
  }))
}

async function getManagerRolesForTeams(
  managerUserId: string,
  teamIds: readonly string[]
): Promise<Map<string, TeamRole>> {
  if (teamIds.length === 0) return new Map()
  const result = await pool.query(
    `SELECT tm.team_id, tm.role
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = ANY($2::uuid[])
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'`,
    [managerUserId.trim(), teamIds]
  )
  return new Map(
    (result.rows as Array<{ team_id: string; role: TeamRole }>).map(row => [row.team_id, row.role])
  )
}

function canManagerInviteAssignment(
  managerRole: TeamRole | undefined,
  assignmentRole: InviteRole
): boolean {
  if (!roleCanInviteMembers(managerRole)) return false
  if (assignmentRole === 'admin') return roleCanDeleteMembers(managerRole)
  return true
}

async function managerCanControlAllInvitationTeams(
  managerUserId: string,
  teams: readonly InvitationTeamRow[]
): Promise<boolean> {
  if (teams.length === 0) return false
  const managerRoles = await getManagerRolesForTeams(
    managerUserId,
    teams.map(team => team.team_id)
  )
  return teams.every(team => canManagerInviteAssignment(managerRoles.get(team.team_id), team.role))
}

export async function listManagedPendingInvitationsForUser(managerUserId: string) {
  const normalizedManagerUserId = managerUserId.trim()
  const result = await pool.query(
    `WITH managed_teams AS (
     SELECT tm.team_id, tm.role AS manager_role
         FROM team_members tm
         JOIN users manager ON manager.id = tm.user_id
        WHERE tm.user_id = $1
          AND tm.status = 'active'
          AND tm.role IN ('admin', 'inviter')
          AND manager.lifecycle_state = 'active'
     )
     SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
       JOIN invitation_teams it ON it.invitation_id = i.id
       JOIN managed_teams mt ON mt.team_id = it.team_id
      WHERE i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      ORDER BY i.created_at ASC`,
    [normalizedManagerUserId]
  )
  const invitations = await invitationListResponse(result.rows as InvitationRow[])
  const allTeamIds = Array.from(
    new Set(
      invitations.flatMap(invitation =>
        invitation.teams.map(team => String((team as { id: string }).id))
      )
    )
  )
  const managerRoles = await getManagerRolesForTeams(normalizedManagerUserId, allTeamIds)
  return invitations.map(invitation => {
    const teams = invitation.teams as Array<{ id: string; name: string; role: InviteRole }>
    const canManage =
      teams.length > 0 &&
      teams.every(team => canManagerInviteAssignment(managerRoles.get(team.id), team.role))
    return {
      ...invitation,
      canCancel: canManage,
      canResend: canManage,
    }
  })
}

export async function createManagedInvitationForUser(
  managerUserId: string,
  email: string,
  teamAssignments: readonly InvitationTeamAssignment[],
  inviteeName = ''
) {
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedInviteeName = inviteeName.trim()
  const assignments = normalizeInvitationTeamAssignments(teamAssignments)
  if (!normalizedEmail || assignments.length === 0) {
    return { error: 'invalid_payload' as const }
  }

  const rolesResult = await pool.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users manager ON manager.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = ANY($2::uuid[])
        AND tm.status = 'active'
        AND tm.role IN ('admin', 'inviter')
        AND manager.lifecycle_state = 'active'`,
    [managerUserId.trim(), assignments.map(assignment => assignment.teamId)]
  )
  const managerRoles = new Map(
    (rolesResult.rows as Array<{ team_id: string; role: TeamRole; team_name: string }>).map(row => [
      row.team_id,
      row.role,
    ])
  )
  for (const assignment of assignments) {
    const managerRole = managerRoles.get(assignment.teamId)
    if (!roleCanInviteMembers(managerRole)) {
      return { error: 'forbidden' as const }
    }
    if (assignment.role === 'admin' && !roleCanDeleteMembers(managerRole)) {
      return { error: 'forbidden' as const }
    }
  }

  const fallbackName = normalizedEmail.split('@')[0] || normalizedEmail
  if (normalizedInviteeName) {
    const updatedUser = await pool.query(
      `UPDATE users
          SET name = $2,
              updated_at = NOW()
        WHERE email = $1
    RETURNING id`,
      [normalizedEmail, normalizedInviteeName]
    )
    const userId = String((updatedUser.rows[0] as { id?: string } | undefined)?.id || '')
    if (userId) {
      await pool.query(
        `INSERT INTO profiles(user_id, display_name)
         VALUES($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET display_name = EXCLUDED.display_name,
                       updated_at = NOW()`,
        [userId, normalizedInviteeName]
      )
    }
  }

  return {
    invitation: await createInvitationForTeams({
      inviteeName: normalizedInviteeName || fallbackName,
      email: normalizedEmail,
      purpose: 'member_invitation',
      teamAssignments: assignments,
      fallbackRole: 'member',
    }),
  }
}

export async function updateManagedMemberRoleForUser(
  managerUserId: string,
  targetUserId: string,
  teamId: string,
  role: TeamRole
) {
  if (managerUserId.trim() === targetUserId.trim()) {
    return { error: 'invalid_target' as const }
  }
  const normalizedRole = normalizeTeamRoleInput(role)
  if (!normalizedRole) {
    return { error: 'invalid_role' as const }
  }
  const manager = await findMemberRole(teamId, managerUserId)
  if (!roleCanDeleteMembers(manager?.role)) {
    return { error: 'forbidden' as const }
  }
  const target = await findMemberRole(teamId, targetUserId)
  if (!target) {
    return { error: 'not_found' as const }
  }
  return {
    membership: await updateMemberRole(teamId, targetUserId, normalizedRole, managerUserId),
  }
}

export async function deleteManagedMemberForUser(
  managerUserId: string,
  targetUserId: string,
  teamId: string
) {
  if (managerUserId.trim() === targetUserId.trim()) {
    return { error: 'invalid_target' as const }
  }
  const manager = await findMemberRole(teamId, managerUserId)
  if (!roleCanDeleteMembers(manager?.role)) {
    return { error: 'forbidden' as const }
  }
  const deleted = await softDeleteMember(teamId, targetUserId, managerUserId)
  if (!deleted) {
    return { error: 'not_found' as const }
  }
  return { deleted }
}

export async function deleteManagedUserForUser(
  managerUserId: string,
  targetUserId: string,
  retirement: { reason: string; idempotencyKey: string; requestId: string | null }
) {
  const normalizedManagerUserId = managerUserId.trim()
  const normalizedTargetUserId = targetUserId.trim()
  if (!normalizedManagerUserId || !normalizedTargetUserId) {
    return { error: 'not_found' as const }
  }
  if (normalizedManagerUserId === normalizedTargetUserId) {
    return { error: 'invalid_target' as const }
  }

  const teamsResult = await pool.query(
    `SELECT team_id
       FROM team_members tm
       JOIN users target ON target.id = tm.user_id
      WHERE user_id = $1
        AND status = 'active'
        AND target.lifecycle_state = 'active'`,
    [normalizedTargetUserId]
  )
  const teamIds = (teamsResult.rows as Array<{ team_id: string }>).map(row => row.team_id)
  if (teamIds.length === 0) {
    return { error: 'not_found' as const }
  }
  const managerRoles = await getManagerRolesForTeams(normalizedManagerUserId, teamIds)
  if (!teamIds.every(teamId => roleCanDeleteMembers(managerRoles.get(teamId)))) {
    return { error: 'forbidden_uncontrolled_teams' as const }
  }

  try {
    const outcome = await retireDesktopUser(
      { kind: 'platform_user', desktopUserId: normalizedManagerUserId },
      normalizedTargetUserId,
      retirement.reason,
      retirement.idempotencyKey,
      retirement.requestId
    )
    return { deleted: { ok: true as const, id: outcome.id }, outcome }
  } catch (error) {
    if (error instanceof DesktopUserRetirementError) {
      if (error.code === 'not_found') return { error: 'not_found' as const }
      if (error.code === 'invalid_input') return { error: 'invalid_retirement_input' as const }
      if (error.code === 'idempotency_conflict') return { error: 'idempotency_conflict' as const }
      return { error: 'retirement_conflict' as const }
    }
    throw error
  }
}

export async function resendManagedInvitationForUser(managerUserId: string, invitationId: string) {
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.id = $1
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      LIMIT 1`,
    [invitationId.trim()]
  )
  const invitation = (result.rows[0] as InvitationRow | undefined) || null
  if (!invitation) return { error: 'not_found' as const }
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)
  if (!(await managerCanControlAllInvitationTeams(managerUserId, teams))) {
    return { error: 'forbidden' as const }
  }

  await registerAndSendInvitation(
    invitation.email,
    invitation.token,
    teams.length > 0 ? teams.map(team => team.team_name).join(', ') : invitation.team_name,
    new Date().toISOString(),
    invitation.expires_at.toISOString(),
    {
      purpose: invitation.purpose,
      teamNames: teams.map(team => team.team_name),
    }
  )
  return { resent: true as const, id: invitation.id, email: invitation.email }
}

export async function revokeManagedInvitationForUser(managerUserId: string, invitationId: string) {
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.id = $1
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      LIMIT 1`,
    [invitationId.trim()]
  )
  const invitation = (result.rows[0] as InvitationRow | undefined) || null
  if (!invitation) return { error: 'not_found' as const }
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)
  if (!(await managerCanControlAllInvitationTeams(managerUserId, teams))) {
    return { error: 'forbidden' as const }
  }

  await pool.query(`UPDATE invitations SET status = 'revoked' WHERE id = $1`, [invitation.id])
  return { revoked: true as const, id: invitation.id, email: invitation.email }
}

export { requestProfilePasswordReset } from './passwordResetInvitations.js'

import { type DbClient, pool, withTransaction } from '../../db.js'
import { registerAndSendInvitation } from '../invitationFlowRegistrationService.js'
import { appendControlApiPermissionEventsInTransaction } from '../tracing/controlApiPermissionEvents.js'
import {
  type InvitationForTeamsInput,
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

export {
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  updateUserPassword,
} from './memberPassword.js'
export { withPasswordWorkLease as withMemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'
export type { MemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'
export { requestProfilePasswordReset } from './passwordResetInvitations.js'

export { INVITATION_TTL_HOURS } from './invitationStore.js'
export type { InvitationPurpose, InvitationTeamAssignment } from './invitationStore.js'

const DRAFT_INVITATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const USER_LOCK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
  invitationIds: readonly string[],
  managerUserId?: string
): Promise<Map<string, InvitationTeamRow[]>> {
  const byInvitationId = new Map<string, InvitationTeamRow[]>()
  if (invitationIds.length === 0) return byInvitationId

  const result = await db.query(
    `SELECT it.invitation_id, it.team_id, t.name AS team_name, it.role
       FROM invitation_teams it
       JOIN teams t ON t.id = it.team_id
  LEFT JOIN team_members manager
         ON manager.team_id = it.team_id
        AND manager.user_id::text = $2
        AND manager.status = 'active'
        AND manager.role IN ('admin', 'inviter')
      WHERE it.invitation_id = ANY($1::uuid[])
        AND ($2 = '' OR manager.user_id IS NOT NULL)
      ORDER BY it.invitation_id ASC, t.name ASC`,
    [invitationIds, managerUserId?.trim() || '']
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

async function invitationListResponse(
  rows: Array<InvitationRow & { assignment_count?: unknown }>,
  managerUserId?: string
) {
  const teamsByInvitationId = await loadInvitationTeamsByInvitationIds(
    pool,
    rows.map(row => row.id),
    managerUserId
  )
  return rows.map(row => {
    const { token: _secretCapability, ...safeInvitation } = row
    const managerSafeInvitation = managerUserId
      ? (() => {
          const {
            team_id: _hiddenPrimaryTeamId,
            team_name: _hiddenPrimaryTeamName,
            role: _hiddenPrimaryRole,
            assignment_count: _internalAssignmentCount,
            ...safeManagerFields
          } = safeInvitation
          return safeManagerFields
        })()
      : safeInvitation
    return {
      ...managerSafeInvitation,
      teams: (teamsByInvitationId.get(row.id) || []).map(team => ({
        id: team.team_id,
        name: team.team_name,
        role: team.role,
      })),
    }
  })
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

/**
 * The single-use transition of a pending invitation. Its predicates are the
 * last guard against consuming a revoked, expired or password-reset row, so
 * they hold even when a caller skipped its own refusals.
 */
export async function acceptPendingMembershipInvitation(
  db: Pick<DbClient, 'query'>,
  invitation: InvitationRow,
  userId: string
): Promise<boolean> {
  const consumed = await db.query(
    `UPDATE invitations
        SET status = 'accepted',
            accepted_at = NOW(),
            accepted_user_id = $2
      WHERE id = $1
        AND status = 'pending'
        AND purpose <> 'password_reset'
        AND expires_at > NOW()
  RETURNING id`,
    [invitation.id, userId]
  )
  if ((consumed.rowCount ?? 0) === 0) return false
  await applyInvitationMemberships(db, invitation, userId)
  return true
}

/**
 * Applies an invitation acceptance after the caller locked the invitation row.
 *
 * Pending invitations take the single-use transition. An already accepted
 * invitation owned by the same user is replayed without any invitation or
 * membership write, so a retried acceptance cannot create a second membership
 * or move the acceptance timestamp. The replay is signalled to the caller
 * because a replayed acceptance must not issue a user session: only the
 * transaction that consumed a pending invitation proves the capability. The
 * base's one-time backfill of a legacy accepted row whose accepted_user_id is
 * still null stays conditional and is also a replay, not a new authentication.
 * A different user never inherits an accepted invitation.
 */
async function applyInvitationAcceptance(
  db: Pick<DbClient, 'query'>,
  invitation: InvitationRow,
  userId: string
): Promise<{ error: 'forbidden' } | { error: 'not_pending' } | { replay: true } | null> {
  if (invitation.status === 'accepted') {
    if (invitation.accepted_user_id && invitation.accepted_user_id !== userId) {
      return { error: 'forbidden' as const }
    }
    if (!invitation.accepted_user_id) {
      await db.query(
        `UPDATE invitations SET accepted_user_id = $2
          WHERE id = $1 AND accepted_user_id IS NULL`,
        [invitation.id, userId]
      )
    }
    return { replay: true as const }
  }
  if (!(await acceptPendingMembershipInvitation(db, invitation, userId))) {
    return { error: 'not_pending' as const }
  }
  return null
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

export function externalManagedInvitationResponse(
  invitation: Record<string, unknown>
): Record<string, unknown> {
  const { token: _secretCapability, ...safeInvitation } = invitation
  return safeInvitation
}

async function deliverAndActivateInvitation(
  inserted: InvitationWithTeams,
  purpose: InvitationPurpose
) {
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

async function createInvitationForTeamsRecord(
  input: InvitationForTeamsInput,
  options: { sendEmail: boolean }
) {
  cleanupStaleDraftInvitations().catch(() => undefined)
  const purpose = normalizeInvitationPurpose(input.purpose)
  const inserted = await withTransaction(async db =>
    insertInvitationForTeams(db, {
      ...input,
      purpose,
      status: options.sendEmail ? 'draft' : 'pending',
    })
  )

  if (!options.sendEmail) {
    return invitationForTeamsResponse(inserted.invitation, inserted.teams)
  }

  return deliverAndActivateInvitation(inserted, purpose)
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
  purpose?: InvitationPurpose
  fallbackRole?: InviteRole
}) {
  return createInvitationForTeamsRecord(input, { sendEmail: true })
}

export async function createSilentInvitationForTeams(input: {
  inviteeName: string
  email: string
  teamAssignments?: readonly InvitationTeamAssignment[]
  fallbackRole?: InviteRole
  purpose?: InvitationPurpose
}) {
  return createInvitationForTeamsRecord(input, { sendEmail: false })
}

export async function getPendingMemberInvitationForEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null
  const result = await pool.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
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
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
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
    `SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
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
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
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

export async function getInvitationByToken(token: string) {
  const invitation = await getInvitationRecordByToken(pool, token.trim())
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

type InvitationAcceptanceLookup =
  | { by: 'token_or_id'; token: string; invitationId: string }
  | { by: 'id'; invitationId: string }

type InvitationAcceptanceRefusal = 'not_found' | 'forbidden' | 'not_pending' | 'expired'

function readInvitationForAcceptance(
  db: Pick<DbClient, 'query'>,
  lookup: InvitationAcceptanceLookup,
  lock: boolean
): Promise<InvitationRow | null> {
  return lookup.by === 'id'
    ? getInvitationRecordById(db, lookup.invitationId, { lock })
    : getInvitationRecordByTokenOrId(db, lookup.token, lookup.invitationId, { lock })
}

function invitationAcceptanceRefusal(
  invitation: InvitationRow,
  email: string
): InvitationAcceptanceRefusal | null {
  if (invitation.email.toLowerCase() !== email.toLowerCase()) return 'forbidden'
  if (invitation.purpose === 'password_reset') return 'not_pending'
  if (invitation.status === 'revoked' || invitation.status === 'draft') return 'not_pending'
  if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
    return 'expired'
  }
  return null
}

/**
 * Accepts an invitation for `email` inside the caller's transaction.
 *
 * Lock order: the user row, then the invitation, then that user's
 * team_members. Every transaction that writes an invitation and a user of the
 * same person takes the user first (user deletion with its ON DELETE SET NULL
 * on invitations.accepted_user_id, Google login, password reset, first
 * password setup, managed resend and revoke), so acceptance must not hold the
 * invitation row while it waits for the user. The unlocked first read only
 * spares the user insert on an obviously refused call: every refusal is
 * decided again on the locked invitation row, and the lifecycle decision, the
 * response and session issuance use the locked user row.
 */
async function acceptInvitationInTransaction(
  db: Pick<DbClient, 'query'>,
  email: string,
  lookup: InvitationAcceptanceLookup
) {
  const candidate = await readInvitationForAcceptance(db, lookup, false)
  if (!candidate) return { error: 'not_found' as const }
  const candidateRefusal = invitationAcceptanceRefusal(candidate, email)
  if (candidateRefusal) return { error: candidateRefusal }

  // ensureInvitationUser locks the user before the profile insert (users ->
  // profiles, the order Google login uses). This by-id read re-locks the row
  // this transaction already holds and stays the authoritative lifecycle read.
  const ensured = await ensureInvitationUser(db, candidate.email, candidate.invitee_name)
  const locked = await db.query(
    `SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version FROM users WHERE id = $1 FOR NO KEY UPDATE`,
    [ensured.id]
  )
  const user = locked.rows[0] as InvitationUserRow | undefined
  if (!user) return { error: 'not_found' as const }
  // A retirement that committed while this transaction waited on the lock wins
  // before any invitation or membership write.
  if (user.lifecycle_state !== 'active') return { error: 'user_retired' as const }

  const invitation = await readInvitationForAcceptance(db, lookup, true)
  if (!invitation) return { error: 'not_found' as const }
  const refusal = invitationAcceptanceRefusal(invitation, email)
  if (refusal) return { error: refusal }

  const acceptance = await applyInvitationAcceptance(db, invitation, user.id)
  if (acceptance && 'error' in acceptance) return acceptance
  const replay = acceptance?.replay === true

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
      ...(replay ? { replay: true as const } : {}),
    },
    // Session issuance reuses this locked row instead of locking it again.
    lockedUser: {
      lifecycleState: user.lifecycle_state,
      lifecycleVersion: user.lifecycle_version,
    },
  }
}

export async function acceptInvitationForEmailInTransaction(
  db: Pick<DbClient, 'query'>,
  email: string,
  token: string,
  invitationId = ''
) {
  return acceptInvitationInTransaction(db, email, { by: 'token_or_id', token, invitationId })
}

export async function acceptInvitationForEmail(email: string, token: string, invitationId = '') {
  return withTransaction(db =>
    acceptInvitationForEmailInTransaction(db, email, token, invitationId)
  )
}

export async function acceptInvitationById(email: string, invitationId: string) {
  return withTransaction(db => acceptInvitationInTransaction(db, email, { by: 'id', invitationId }))
}

export const DIRECTORY_SEARCH_MAX_QUERY_LENGTH = 100

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

export async function searchDirectory(teamId: string, q: string) {
  const query = q.trim()
  if (!query) return { items: [] }
  const pattern = `%${escapeLikeLiteral(query)}%`

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
        AND (
          u.email ILIKE $2 ESCAPE '\\'
          OR COALESCE(u.name, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(p.display_name, '') ILIKE $2 ESCAPE '\\'
        )
   ORDER BY LOWER(COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email)) ASC,
            u.id ASC
      LIMIT 25`,
    [teamId, pattern]
  )
  return { items: result.rows }
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
           JOIN managed_teams mt ON mt.team_id = target_tm.team_id
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
           JOIN managed_teams mt ON mt.team_id = target_tm.team_id
           JOIN teams t ON t.id = target_tm.team_id
           JOIN users u ON u.id = target_tm.user_id
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

async function lockManagerUser(db: Pick<DbClient, 'query'>, managerUserId: string): Promise<void> {
  await db.query(`SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, [managerUserId.trim()])
}

async function getManagerRolesForTeams(
  db: Pick<DbClient, 'query'>,
  managerUserId: string,
  teamIds: readonly string[],
  lock = false
): Promise<Map<string, TeamRole>> {
  if (teamIds.length === 0) return new Map()
  if (lock) {
    // Lock order: the manager's user row before its team_members rows, as the
    // team-session exchange does. A single FOR UPDATE over the join would lock
    // each team_members row before the user row. A caller that already locked
    // the manager re-issues a no-op lock here.
    await lockManagerUser(db, managerUserId)
  }
  const result = await db.query(
    `SELECT tm.team_id, tm.role
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1
        AND tm.team_id = ANY($2::uuid[])
        AND tm.status = 'active'
        AND u.lifecycle_state = 'active'
      ORDER BY tm.team_id
      ${lock ? 'FOR UPDATE OF tm' : ''}`,
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
  db: Pick<DbClient, 'query'>,
  managerUserId: string,
  teams: readonly InvitationTeamRow[],
  lock = false
): Promise<boolean> {
  if (teams.length === 0) return false
  const managerRoles = await getManagerRolesForTeams(
    db,
    managerUserId,
    teams.map(team => team.team_id),
    lock
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
     SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            (SELECT COUNT(*)::integer
               FROM invitation_teams all_it
              WHERE all_it.invitation_id = i.id) AS assignment_count,
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
  const invitations = await invitationListResponse(
    result.rows as InvitationRow[],
    normalizedManagerUserId
  )
  const assignmentCounts = new Map(
    result.rows.map(row => [
      String((row as { id: string }).id),
      Number((row as { assignment_count?: unknown }).assignment_count ?? 0),
    ])
  )
  const allTeamIds = Array.from(
    new Set(
      invitations.flatMap(invitation =>
        invitation.teams.map(team => String((team as { id: string }).id))
      )
    )
  )
  const managerRoles = await getManagerRolesForTeams(pool, normalizedManagerUserId, allTeamIds)
  return invitations.map(invitation => {
    const teams = invitation.teams as Array<{ id: string; name: string; role: InviteRole }>
    const canManage =
      teams.length > 0 &&
      assignmentCounts.get(invitation.id) === teams.length &&
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

  const fallbackName = normalizedEmail.split('@')[0] || normalizedEmail
  const inserted = await withTransaction(async db => {
    const managerRoles = await getManagerRolesForTeams(
      db,
      managerUserId.trim(),
      assignments.map(assignment => assignment.teamId),
      true
    )
    for (const assignment of assignments) {
      if (!canManagerInviteAssignment(managerRoles.get(assignment.teamId), assignment.role)) {
        return { error: 'forbidden' as const }
      }
    }

    return insertInvitationForTeams(db, {
      inviteeName: normalizedInviteeName || fallbackName,
      email: normalizedEmail,
      purpose: 'member_invitation',
      teamAssignments: assignments,
      fallbackRole: 'member',
      status: 'draft',
    })
  })
  if ('error' in inserted) return { error: inserted.error }
  const delivered = await deliverAndActivateInvitation(inserted, 'member_invitation')
  return {
    invitation: externalManagedInvitationResponse(delivered),
  }
}

export async function updateManagedMemberRoleForUser(
  managerUserId: string,
  targetUserId: string,
  teamId: string,
  role: TeamRole
) {
  const normalizedRole = normalizeTeamRoleInput(role)
  if (!normalizedRole) {
    return { error: 'invalid_role' as const }
  }
  // The lock map is keyed by the database's lower-case UUID text, so every id
  // is normalised once and the same value is used for lookups and events.
  const managerId = managerUserId.trim().toLowerCase()
  const targetId = targetUserId.trim().toLowerCase()
  const normalizedTeamId = teamId.trim().toLowerCase()
  return withTransaction(async db => {
    // A retired user keeps team_members.status = 'active'; as in dev's
    // findMemberRole, only users whose lifecycle is active hold a role here.
    // Global lock order for team_members rows: (team_id, user_id), shared
    // with deleteManagedMemberForUser and the deleteManagedUserForUser
    // authorization; one team, so ORDER BY user_id follows it.
    const locked = await db.query(
      `SELECT tm.user_id::text AS user_id, tm.role
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1
          AND tm.user_id = ANY($2::uuid[])
          AND tm.status = 'active'
          AND u.lifecycle_state = 'active'
        ORDER BY tm.user_id
        FOR UPDATE OF tm`,
      [normalizedTeamId, [managerId, targetId]]
    )
    const memberships = new Map(
      (locked.rows as Array<{ user_id: string; role: TeamRole }>).map(row => [
        row.user_id,
        row.role,
      ])
    )
    if (!roleCanDeleteMembers(memberships.get(managerId))) {
      return { error: 'forbidden' as const }
    }
    const previousRole = memberships.get(targetId)
    if (!previousRole) return { error: 'not_found' as const }

    const result = await db.query(
      `UPDATE team_members
          SET role = $3,
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [normalizedTeamId, targetId, normalizedRole]
    )
    const membership = result.rows[0]
    if (!membership) return { error: 'not_found' as const }
    if (previousRole !== normalizedRole) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: managerId,
        changes: [
          {
            action: 'revoke',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${normalizedTeamId}:role:${previousRole}`,
            subject: { kind: 'user', id: targetId },
            teamId: normalizedTeamId,
            status: 'role_replaced',
          },
          {
            action: 'grant',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${normalizedTeamId}:role:${normalizedRole}`,
            subject: { kind: 'user', id: targetId },
            teamId: normalizedTeamId,
            status: 'role_assigned',
          },
        ],
      })
    }
    return { membership }
  })
}

export async function deleteManagedMemberForUser(
  managerUserId: string,
  targetUserId: string,
  teamId: string
) {
  // The lock map is keyed by the database's lower-case UUID text, so every id
  // is normalised once and the same value is used for lookups and events.
  const managerId = managerUserId.trim().toLowerCase()
  const targetId = targetUserId.trim().toLowerCase()
  const normalizedTeamId = teamId.trim().toLowerCase()
  return withTransaction(async db => {
    // Global lock order for team_members rows: (team_id, user_id), shared
    // with updateManagedMemberRoleForUser and the deleteManagedUserForUser
    // authorization; one team, so ORDER BY user_id follows it.
    const locked = await db.query(
      `SELECT user_id::text AS user_id, role
         FROM team_members
        WHERE team_id = $1
          AND user_id = ANY($2::uuid[])
          AND status = 'active'
        ORDER BY user_id
        FOR UPDATE`,
      [normalizedTeamId, [managerId, targetId]]
    )
    const memberships = new Map(
      (locked.rows as Array<{ user_id: string; role: TeamRole }>).map(row => [
        row.user_id,
        row.role,
      ])
    )
    if (!roleCanDeleteMembers(memberships.get(managerId))) {
      return { error: 'forbidden' as const }
    }
    const targetRole = memberships.get(targetId)
    if (!targetRole) return { error: 'not_found' as const }

    const result = await db.query(
      `UPDATE team_members
          SET status = 'deleted',
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [normalizedTeamId, targetId]
    )
    const deleted = result.rows[0]
    if (!deleted) return { error: 'not_found' as const }
    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: managerId,
      changes: [
        {
          action: 'revoke',
          resourceClass: 'team_membership',
          resourceRef: `team_membership:${normalizedTeamId}:role:${targetRole}`,
          subject: { kind: 'user', id: targetId },
          teamId: normalizedTeamId,
          status: 'membership_removed',
        },
      ],
    })
    return { deleted }
  })
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
  // UUIDs compare case-insensitively in the database, so an upper-case copy of
  // the caller's own id is still the caller.
  if (normalizedManagerUserId.toLowerCase() === normalizedTargetUserId.toLowerCase()) {
    return { error: 'invalid_target' as const }
  }

  class ManagedRetirementAuthorizationError extends Error {
    constructor(readonly code: 'not_found' | 'forbidden_uncontrolled_teams') {
      super(code)
    }
  }

  try {
    return await withTransaction(async db => {
      // Reciprocal retirements must not each lock their own actor before the
      // other request's target. Lock the existing principal pair in the same
      // database UUID order before locking teams.
      // Filter malformed ids before the UUID cast so the indexed lookup does
      // not change their existing later validation/error path.
      const principalIds = [...new Set([normalizedManagerUserId, normalizedTargetUserId])]
        .filter(id => USER_LOCK_UUID_PATTERN.test(id))
        .map(id => id.toLowerCase())
      await db.query(
        `SELECT id
           FROM users
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [principalIds]
      )
      const outcome = await retireDesktopUser(
        { kind: 'platform_user', desktopUserId: normalizedManagerUserId },
        normalizedTargetUserId,
        retirement.reason,
        retirement.idempotencyKey,
        retirement.requestId,
        {
          db,
          authorize: async retirementDb => {
            // Global lock order for team_members rows: (team_id, user_id).
            // The member writers lock one team's rows ORDER BY user_id, so
            // the manager's and the target's rows across every team of the
            // target are locked in one statement in that same order. Two
            // statements (target rows, then manager rows) can hold a target
            // row while waiting for a manager row that a member writer holds
            // while it waits for that target row: a deadlock. The lifecycle
            // filter keeps the manager filter dev applied; retireDesktopUser
            // has already refused a target whose lifecycle is not active.
            // The ids are compared with the database's lower-case UUID text.
            const managerId = normalizedManagerUserId.toLowerCase()
            const targetId = normalizedTargetUserId.toLowerCase()
            const locked = await retirementDb.query(
              `SELECT tm.team_id::text AS team_id, tm.user_id::text AS user_id, tm.role
                 FROM team_members tm
                 JOIN users u ON u.id = tm.user_id
                WHERE tm.status = 'active'
                  AND u.lifecycle_state = 'active'
                  AND tm.user_id = ANY($1::uuid[])
                  AND tm.team_id IN (
                    SELECT team_id
                      FROM team_members
                     WHERE user_id = $2
                       AND status = 'active'
                  )
                ORDER BY tm.team_id, tm.user_id
                FOR UPDATE OF tm`,
              [[managerId, targetId], targetId]
            )
            const rows = locked.rows as Array<{ team_id: string; user_id: string; role: TeamRole }>
            const teamIds = rows.filter(row => row.user_id === targetId).map(row => row.team_id)
            if (teamIds.length === 0) {
              throw new ManagedRetirementAuthorizationError('not_found')
            }
            const managerRoles = new Map(
              rows.filter(row => row.user_id === managerId).map(row => [row.team_id, row.role])
            )
            if (!teamIds.every(teamId => roleCanDeleteMembers(managerRoles.get(teamId)))) {
              throw new ManagedRetirementAuthorizationError('forbidden_uncontrolled_teams')
            }
          },
        }
      )
      return { deleted: { ok: true as const, id: outcome.id }, outcome }
    })
  } catch (error) {
    if (error instanceof ManagedRetirementAuthorizationError) {
      return { error: error.code }
    }
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
  const authorized = await withTransaction(async db => {
    // Lock order: users before invitations. The manager may be the invitee,
    // and an acceptance holds that user while it waits for the invitation.
    await lockManagerUser(db, managerUserId)
    const result = await db.query(
      `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.id = $1
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      LIMIT 1
      FOR UPDATE OF i`,
      [invitationId.trim()]
    )
    const invitation = (result.rows[0] as InvitationRow | undefined) || null
    if (!invitation) return { error: 'not_found' as const }
    const teams = await loadInvitationTeams(db, invitation.id, invitation)
    if (!(await managerCanControlAllInvitationTeams(db, managerUserId, teams, true))) {
      return { error: 'forbidden' as const }
    }

    return { invitation, teams }
  })
  if ('error' in authorized) return authorized
  const { invitation, teams } = authorized

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
  return withTransaction(async db => {
    // Lock order: users before invitations, as in resendManagedInvitationForUser.
    await lockManagerUser(db, managerUserId)
    const result = await db.query(
      `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at,
            i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.id = $1
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > NOW()
      LIMIT 1
      FOR UPDATE OF i`,
      [invitationId.trim()]
    )
    const invitation = (result.rows[0] as InvitationRow | undefined) || null
    if (!invitation) return { error: 'not_found' as const }
    const teams = await loadInvitationTeams(db, invitation.id, invitation)
    if (!(await managerCanControlAllInvitationTeams(db, managerUserId, teams, true))) {
      return { error: 'forbidden' as const }
    }

    await db.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending'`,
      [invitation.id]
    )
    return { revoked: true as const, id: invitation.id, email: invitation.email }
  })
}

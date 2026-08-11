import bcrypt from 'bcryptjs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { type DbClient, pool, withTransaction } from '../../db.js'
import { revokeAllUserSessions } from '../auth/userSessionService.js'
import { registerAndSendInvitation } from '../invitationFlowRegistrationService.js'
import { appendControlApiPermissionEventsInTransaction } from '../tracing/controlApiPermissionEvents.js'
import type { InviteRole, TeamRole } from './types.js'
import {
  normalizeChannels,
  normalizeTeamRoleInput,
  roleCanDeleteMembers,
  roleCanInviteMembers,
} from './types.js'
import { adminDeleteUserInTransaction } from './users.js'

export const INVITATION_TTL_HOURS = 48
const DRAFT_INVITATION_CLEANUP_HOURS = 24
const DRAFT_INVITATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
let draftInvitationCleanupTimer: ReturnType<typeof setInterval> | null = null

type InvitationRow = {
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

type InvitationTeamRow = {
  team_id: string
  team_name: string
  role: InviteRole
}

type InvitationUserRow = {
  id: string
  email: string
  name: string | null
  picture: string | null
  password_hash: string | null
}

type InvitationWithTeams = {
  invitation: InvitationRow
  teams: InvitationTeamRow[]
}

type InvitationForTeamsInput = {
  inviteeName: string
  email: string
  teamAssignments?: readonly InvitationTeamAssignment[]
  purpose?: InvitationPurpose
  fallbackRole?: InviteRole
}

function normalizeInvitationPurpose(purpose?: InvitationPurpose): InvitationPurpose {
  if (purpose === 'password_reset') return 'password_reset'
  if (purpose === 'admin_desktop_access') return 'admin_desktop_access'
  return 'member_invitation'
}

async function getInvitationRecordByToken(
  db: Pick<DbClient, 'query'>,
  token: string,
  options: { lock?: boolean } = {}
): Promise<InvitationRow | null> {
  const result = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose, i.created_at, i.expires_at, i.accepted_at,
            i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.token = $1
      LIMIT 1
      ${options.lock ? 'FOR UPDATE OF i' : ''}`,
    [token]
  )
  return (result.rows[0] as InvitationRow | undefined) || null
}

async function cleanupStaleDraftInvitations(): Promise<void> {
  await pool.query(
    `DELETE FROM invitations
      WHERE status = 'draft'
        AND created_at < NOW() - ($1::text || ' hours')::interval`,
    [String(DRAFT_INVITATION_CLEANUP_HOURS)]
  )
}

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

async function getInvitationRecordByTokenOrId(
  db: Pick<DbClient, 'query'>,
  token: string,
  invitationId: string,
  options: { lock?: boolean } = {}
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
      LIMIT 1
      ${options.lock ? 'FOR UPDATE OF i' : ''}`,
    [normalizedToken, normalizedInvitationId]
  )

  return (result.rows[0] as InvitationRow | undefined) || null
}

async function getInvitationRecordById(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  options: { lock?: boolean } = {}
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
      ${options.lock ? 'FOR UPDATE OF i' : ''}`,
    [normalizedInvitationId]
  )
  return (result.rows[0] as InvitationRow | undefined) || null
}

async function ensureInvitationUser(
  db: Pick<DbClient, 'query'>,
  email: string,
  inviteeName: string | null
): Promise<InvitationUserRow> {
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedInviteeName = String(inviteeName || '').trim() || null
  const existing = await db.query(
    `SELECT id, email, name, picture, password_hash
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [normalizedEmail]
  )

  let user = (existing.rows[0] as InvitationUserRow | undefined) || null
  if (!user) {
    const inserted = await db.query(
      `INSERT INTO users(email, name)
       VALUES($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name, picture, password_hash`,
      [normalizedEmail, normalizedInviteeName]
    )
    user = (inserted.rows[0] as InvitationUserRow | undefined) || null
    if (!user) {
      const racedExisting = await db.query(
        `SELECT id, email, name, picture, password_hash
           FROM users
          WHERE email = $1
          LIMIT 1`,
        [normalizedEmail]
      )
      user = (racedExisting.rows[0] as InvitationUserRow | undefined) || null
    }
  }
  if (!user) throw new Error('Failed to resolve invitation user')

  await db.query(
    `INSERT INTO profiles(user_id, display_name)
     VALUES($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, user.name || null]
  )

  return user
}

function normalizeInvitationTeamAssignments(
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

async function loadInvitationTeams(
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

async function invitationListResponse(rows: InvitationRow[], managerUserId?: string) {
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

async function acceptPendingMembershipInvitation(
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

async function insertInvitationTeams(
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

function invitationResponse(
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
  }
}

export async function findMembership(userId: string, teamId: string) {
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
   ORDER BY u.email ASC`,
    [teamId]
  )
  return result.rows
}

export async function findMemberRole(teamId: string, userId: string) {
  const result = await pool.query(
    `SELECT role
       FROM team_members
      WHERE team_id = $1
        AND user_id = $2
        AND status = 'active'
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

async function insertInvitationForTeams(
  db: Pick<DbClient, 'query'>,
  input: InvitationForTeamsInput & { status: 'draft' | 'pending' }
): Promise<InvitationWithTeams> {
  const normalizedAssignments = normalizeInvitationTeamAssignments(input.teamAssignments)
  const primaryAssignment = normalizedAssignments[0] || null
  const fallbackRole =
    normalizeTeamRoleInput(input.fallbackRole) || primaryAssignment?.role || 'member'
  const purpose = normalizeInvitationPurpose(input.purpose)
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
      String(INVITATION_TTL_HOURS),
    ]
  )
  const invitation = invited.rows[0] as InvitationRow
  await insertInvitationTeams(db, invitation.id, normalizedAssignments)
  return {
    invitation,
    teams: await loadInvitationTeams(db, invitation.id, invitation),
  }
}

function invitationForTeamsResponse(invitation: InvitationRow, teams: InvitationTeamRow[]) {
  return {
    ...invitation,
    teams: teams.map(team => ({
      id: team.team_id,
      name: team.team_name,
      role: team.role,
    })),
  }
}

async function recordInvitationDeliveryCommand(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  authorizedBy: string,
  deliveryKind: 'create' | 'resend'
): Promise<string> {
  const result = await db.query(
    `INSERT INTO invitation_delivery_commands(invitation_id, authorized_by, delivery_kind)
     VALUES($1, $2, $3)
     RETURNING id`,
    [invitationId, authorizedBy.trim(), deliveryKind]
  )
  const commandId = String((result.rows[0] as { id?: string } | undefined)?.id || '')
  if (!commandId) throw new Error('Failed to persist invitation delivery command')
  return commandId
}

async function finishInvitationDeliveryCommand(
  db: Pick<DbClient, 'query'>,
  commandId: string,
  status: 'delivered' | 'failed' | 'cancelled',
  failureCode?: string
): Promise<void> {
  const result = await db.query(
    `UPDATE invitation_delivery_commands
        SET status = $2,
            completed_at = NOW(),
            failure_code = $3
      WHERE id = $1
        AND status = 'authorized'`,
    [commandId, status, failureCode || null]
  )
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Invitation delivery command is no longer authorized')
  }
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

  const activated = await pool.query(
    `UPDATE invitations
        SET status = 'pending'
      WHERE id = $1
        AND status = 'draft'
      RETURNING id, team_id, invitee_name, email, role, token, status, purpose, created_at, expires_at, accepted_at, accepted_user_id`,
    [inserted.invitation.id]
  )
  const pending = activated.rows[0] as InvitationRow | undefined
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

async function deliverAndActivateManagedInvitation(
  inserted: InvitationWithTeams,
  commandId: string,
  managerUserId: string
) {
  try {
    await registerAndSendInvitation(
      inserted.invitation.email,
      inserted.invitation.token,
      inserted.teams.length > 0
        ? inserted.teams.map(team => team.team_name).join(', ')
        : inserted.invitation.team_name,
      inserted.invitation.created_at.toISOString(),
      inserted.invitation.expires_at.toISOString(),
      {
        purpose: 'member_invitation',
        teamNames: inserted.teams.map(team => team.team_name),
      }
    )
  } catch (error) {
    await withTransaction(async db => {
      await finishInvitationDeliveryCommand(db, commandId, 'failed', 'delivery_failed')
      await db.query(
        `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'draft'`,
        [inserted.invitation.id]
      )
    }).catch(() => undefined)
    throw error
  }

  return withTransaction(async db => {
    const locked = await db.query(
      `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose,
              i.created_at, i.expires_at, i.accepted_at, i.accepted_user_id,
              t.name AS team_name
         FROM invitation_delivery_commands c
         JOIN invitations i ON i.id = c.invitation_id
    LEFT JOIN teams t ON t.id = i.team_id
        WHERE c.id = $1
          AND c.invitation_id = $2
          AND c.authorized_by = $3
          AND c.delivery_kind = 'create'
          AND c.status = 'authorized'
          AND i.status = 'draft'
        LIMIT 1
        FOR UPDATE OF c, i`,
      [commandId, inserted.invitation.id, managerUserId.trim()]
    )
    const invitation = (locked.rows[0] as InvitationRow | undefined) || null
    if (!invitation) return { error: 'not_found' as const }
    const teams = await loadInvitationTeams(db, invitation.id, invitation)
    if (!(await managerCanControlAllInvitationTeams(db, managerUserId, teams, true))) {
      await finishInvitationDeliveryCommand(db, commandId, 'cancelled', 'authority_changed')
      await db.query(
        `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'draft'`,
        [invitation.id]
      )
      return { error: 'forbidden' as const }
    }

    const activated = await db.query(
      `UPDATE invitations
          SET status = 'pending'
        WHERE id = $1
          AND status = 'draft'
      RETURNING id, team_id, invitee_name, email, role, token, status, purpose, created_at,
                expires_at, accepted_at, accepted_user_id`,
      [invitation.id]
    )
    const pending = activated.rows[0] as InvitationRow | undefined
    if (!pending) throw new Error('Failed to activate authorized invitation')
    await finishInvitationDeliveryCommand(db, commandId, 'delivered')
    return invitationForTeamsResponse({ ...pending, team_name: invitation.team_name }, teams)
  })
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

export async function requestProfilePasswordReset(email: string): Promise<{ requested: true }> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return { requested: true }

  const userResult = await pool.query(
    `SELECT id, email, name
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [normalizedEmail]
  )
  const user =
    (userResult.rows[0] as { id: string; email: string; name: string | null } | undefined) || null
  if (!user) {
    return { requested: true }
  }

  await createInvitationForTeams({
    inviteeName: user.name || user.email.split('@')[0] || user.email,
    email: user.email,
    purpose: 'password_reset',
    teamAssignments: [],
    fallbackRole: 'member',
  })
  return { requested: true }
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
          `SELECT id, email, name, picture, password_hash
           FROM users
          WHERE id = $1
          LIMIT 1`,
          [invitation.accepted_user_id]
        )
      ).rows[0] as InvitationUserRow | undefined) || null
    : ((
        await pool.query(
          `SELECT id, email, name, picture, password_hash
           FROM users
          WHERE email = $1
          LIMIT 1`,
          [invitation.email.toLowerCase()]
        )
      ).rows[0] as InvitationUserRow | undefined) || null
  const teams = await loadInvitationTeams(pool, invitation.id, invitation)
  return invitationResponse(invitation, user, teams)
}

export async function setInvitationPasswordForUser(
  userId: string,
  email: string,
  invitationId: string,
  password: string
) {
  const trimmedUserId = userId.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const trimmedInvitationId = invitationId.trim()
  const trimmedPassword = password.trim()
  if (!trimmedUserId || !normalizedEmail || !trimmedInvitationId) {
    return { error: 'not_found' as const }
  }
  if (trimmedPassword.length < 8 || trimmedPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  return withTransaction(async db => {
    const invitation = await getInvitationRecordById(db, trimmedInvitationId, { lock: true })
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== normalizedEmail) {
      return { error: 'forbidden' as const }
    }
    if (invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }
    if (invitation.purpose === 'password_reset') {
      if (invitation.status !== 'pending') {
        return { error: 'not_pending' as const }
      }
    } else if (
      invitation.purpose === 'member_invitation' ||
      invitation.purpose === 'admin_desktop_access'
    ) {
      if (invitation.status !== 'accepted') {
        return { error: 'not_accepted' as const }
      }
    } else {
      return { error: 'not_found' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (user.id !== trimmedUserId) {
      return { error: 'forbidden' as const }
    }
    if (invitation.purpose !== 'password_reset' && user.password_hash) {
      return { error: 'password_already_set' as const }
    }
    if (invitation.purpose === 'password_reset') {
      const consumed = await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1
            AND status = 'pending'
      RETURNING id`,
        [invitation.id, user.id]
      )
      if ((consumed.rowCount ?? 0) === 0) return { error: 'not_pending' as const }
    }
    const passwordHash = await bcrypt.hash(trimmedPassword, 12)
    await db.query(
      `UPDATE users
          SET password_hash = $2,
              password_set_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [user.id, passwordHash]
    )
    await revokeAllUserSessions(user.id, 'password_changed', db)
    if (invitation.purpose !== 'password_reset' && !invitation.accepted_user_id) {
      await db.query(
        `UPDATE invitations SET accepted_user_id = $2
          WHERE id = $1 AND accepted_user_id IS NULL`,
        [invitation.id, user.id]
      )
    }

    const refreshed = await getInvitationRecordById(db, invitation.id)
    if (!refreshed) {
      return { error: 'not_found' as const }
    }

    const teams = await loadInvitationTeams(db, refreshed.id, refreshed)
    return {
      data: {
        passwordUpdated: true,
        ...invitationResponse(refreshed, { ...user, password_hash: passwordHash }, teams),
      },
    }
  })
}

export async function setInvitationPasswordForEmail(
  email: string,
  invitationToken: string,
  invitationId: string,
  password: string
) {
  const normalizedEmail = email.trim().toLowerCase()
  const trimmedInvitationToken = invitationToken.trim()
  const trimmedInvitationId = invitationId.trim()
  const trimmedPassword = password.trim()
  if (!normalizedEmail || !trimmedInvitationToken || !trimmedInvitationId) {
    return { error: 'not_found' as const }
  }
  if (trimmedPassword.length < 8 || trimmedPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  return withTransaction(async db => {
    const invitation = await getInvitationRecordByToken(db, trimmedInvitationToken, { lock: true })
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.id !== trimmedInvitationId) {
      return { error: 'forbidden' as const }
    }
    if (invitation.email.toLowerCase() !== normalizedEmail) {
      return { error: 'forbidden' as const }
    }
    const pendingMembershipSetup =
      invitation.status === 'pending' &&
      (invitation.purpose === 'member_invitation' || invitation.purpose === 'admin_desktop_access')
    if (invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }
    if (invitation.purpose === 'password_reset') {
      if (invitation.status !== 'pending') {
        return { error: 'not_pending' as const }
      }
    } else if (
      invitation.purpose === 'member_invitation' ||
      invitation.purpose === 'admin_desktop_access'
    ) {
      if (!pendingMembershipSetup) {
        return { error: 'not_pending' as const }
      }
    } else {
      return { error: 'not_found' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (invitation.purpose !== 'password_reset' && user.password_hash) {
      return { error: 'password_already_set' as const }
    }
    if (pendingMembershipSetup) {
      if (!(await acceptPendingMembershipInvitation(db, invitation, user.id))) {
        return { error: 'not_pending' as const }
      }
    } else if (invitation.purpose === 'password_reset') {
      const consumed = await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1
            AND status = 'pending'
      RETURNING id`,
        [invitation.id, user.id]
      )
      if ((consumed.rowCount ?? 0) === 0) return { error: 'not_pending' as const }
    }
    const passwordHash = await bcrypt.hash(trimmedPassword, 12)
    await db.query(
      `UPDATE users
          SET password_hash = $2,
              password_set_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [user.id, passwordHash]
    )
    await revokeAllUserSessions(user.id, 'password_changed', db)
    const refreshed = await getInvitationRecordById(db, invitation.id)
    if (!refreshed) {
      return { error: 'not_found' as const }
    }

    const teams = await loadInvitationTeams(db, refreshed.id, refreshed)
    return {
      data: {
        passwordUpdated: true,
        ...invitationResponse(refreshed, { ...user, password_hash: passwordHash }, teams),
      },
    }
  })
}

export async function acceptInvitation(
  userId: string,
  email: string,
  token: string,
  invitationId: string
) {
  return withTransaction(async db => {
    const invitation = await getInvitationRecordByTokenOrId(db, token, invitationId, {
      lock: true,
    })
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return { error: 'forbidden' as const }
    }
    if (invitation.status !== 'pending' || invitation.purpose === 'password_reset') {
      return { error: 'not_pending' as const }
    }
    if (invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
    if (user.id !== userId) {
      return { error: 'forbidden' as const }
    }

    if (!(await acceptPendingMembershipInvitation(db, invitation, user.id))) {
      return { error: 'not_pending' as const }
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

export async function acceptInvitationForEmailInTransaction(
  db: Pick<DbClient, 'query'>,
  email: string,
  token: string,
  invitationId = ''
) {
  const invitation = await getInvitationRecordByTokenOrId(db, token, invitationId, {
    lock: true,
  })
  if (!invitation) {
    return { error: 'not_found' as const }
  }
  if (invitation.email.toLowerCase() !== email.toLowerCase()) {
    return { error: 'forbidden' as const }
  }
  if (invitation.status !== 'pending' || invitation.purpose === 'password_reset') {
    return { error: 'not_pending' as const }
  }
  if (invitation.expires_at.getTime() <= Date.now()) {
    return { error: 'expired' as const }
  }

  const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)

  if (!(await acceptPendingMembershipInvitation(db, invitation, user.id))) {
    return { error: 'not_pending' as const }
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
}

export async function acceptInvitationForEmail(email: string, token: string, invitationId = '') {
  return withTransaction(db =>
    acceptInvitationForEmailInTransaction(db, email, token, invitationId)
  )
}

export async function acceptInvitationById(email: string, invitationId: string) {
  return withTransaction(async db => {
    const invitation = await getInvitationRecordById(db, invitationId, { lock: true })
    if (!invitation) {
      return { error: 'not_found' as const }
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return { error: 'forbidden' as const }
    }
    if (invitation.status === 'revoked' || invitation.status === 'draft') {
      return { error: 'not_pending' as const }
    }
    if (invitation.status === 'pending' && invitation.expires_at.getTime() <= Date.now()) {
      return { error: 'expired' as const }
    }

    const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)

    if (invitation.status === 'pending' && invitation.purpose !== 'password_reset') {
      if (!(await acceptPendingMembershipInvitation(db, invitation, user.id))) {
        return { error: 'not_pending' as const }
      }
    } else if (invitation.status === 'accepted' && !invitation.accepted_user_id) {
      await db.query(
        `UPDATE invitations SET accepted_user_id = $2
          WHERE id = $1 AND accepted_user_id IS NULL`,
        [invitation.id, user.id]
      )
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

export const DIRECTORY_SEARCH_MAX_QUERY_LENGTH = 100
export const DIRECTORY_SEARCH_PAGE_SIZE = 25

export class DirectorySearchCursorError extends Error {
  constructor() {
    super('invalid directory search cursor')
    this.name = 'DirectorySearchCursorError'
  }
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function directorySearchCursorSignature(value: string): string {
  return createHmac('sha256', config.sessionJwtPrivateKey).update(value).digest('base64url')
}

function encodeDirectorySearchCursor(input: {
  teamId: string
  query: string
  sortKey: string
  userId: string
}): string {
  const body = Buffer.from(JSON.stringify(input)).toString('base64url')
  return `ds1.${body}.${directorySearchCursorSignature(body)}`
}

function decodeDirectorySearchCursor(
  value: string,
  teamId: string,
  query: string
): { sortKey: string; userId: string } {
  const [prefix, body, signature, extra] = value.split('.')
  if (prefix !== 'ds1' || !body || !signature || extra) throw new DirectorySearchCursorError()
  const expected = directorySearchCursorSignature(body)
  const suppliedBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new DirectorySearchCursorError()
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const sortKey = typeof parsed.sortKey === 'string' ? parsed.sortKey : ''
    const userId = typeof parsed.userId === 'string' ? parsed.userId : ''
    if (parsed.teamId !== teamId || parsed.query !== query || !sortKey || !userId) {
      throw new Error('cursor mismatch')
    }
    return { sortKey, userId }
  } catch {
    throw new DirectorySearchCursorError()
  }
}

export async function searchDirectory(teamId: string, q: string, cursor?: string) {
  const query = q.trim()
  if (!query) return { items: [], nextCursor: null }
  if (query.length > DIRECTORY_SEARCH_MAX_QUERY_LENGTH) {
    throw new DirectorySearchCursorError()
  }
  const after = cursor ? decodeDirectorySearchCursor(cursor, teamId, query) : null
  const pattern = `%${escapeLikeLiteral(query)}%`

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name,
            LOWER(COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email)) AS sort_key
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE tm.team_id = $1
        AND tm.status = 'active'
        AND (
          u.email ILIKE $2 ESCAPE '\\'
          OR COALESCE(u.name, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(p.display_name, '') ILIKE $2 ESCAPE '\\'
        )
        AND (
          $3::text IS NULL
          OR (
            LOWER(COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email)),
            u.id
          ) > ($3, $4::uuid)
        )
   ORDER BY sort_key ASC, u.id ASC
      LIMIT $5`,
    [teamId, pattern, after?.sortKey ?? null, after?.userId ?? null, DIRECTORY_SEARCH_PAGE_SIZE + 1]
  )
  const rows = result.rows as Array<{
    id: string
    email: string
    name: string | null
    display_name: string | null
    sort_key: string
  }>
  const page = rows.slice(0, DIRECTORY_SEARCH_PAGE_SIZE)
  const last = page[page.length - 1]
  return {
    items: page.map(row => ({
      id: row.id,
      email: row.email,
      name: row.name,
      displayName: row.display_name,
    })),
    nextCursor:
      rows.length > DIRECTORY_SEARCH_PAGE_SIZE && last
        ? encodeDirectorySearchCursor({
            teamId,
            query,
            sortKey: last.sort_key,
            userId: last.id,
          })
        : null,
  }
}

export async function listManageableTeamsForUser(userId: string) {
  const result = await pool.query(
    `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
        AND tm.role IN ('admin', 'inviter')
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
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND tm.role IN ('admin', 'inviter')
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
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND tm.role IN ('admin', 'inviter')
         ),
         visible_users AS (
           SELECT DISTINCT target_tm.user_id
             FROM managed_teams mt
             JOIN team_members target_tm
               ON target_tm.team_id = mt.team_id
              AND target_tm.status = 'active'
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

async function getManagerRolesForTeams(
  db: Pick<DbClient, 'query'>,
  managerUserId: string,
  teamIds: readonly string[],
  lock = false
): Promise<Map<string, TeamRole>> {
  if (teamIds.length === 0) return new Map()
  const result = await db.query(
    `SELECT team_id, role
       FROM team_members
      WHERE user_id = $1
        AND team_id = ANY($2::uuid[])
        AND status = 'active'
      ORDER BY team_id
      ${lock ? 'FOR UPDATE' : ''}`,
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
        WHERE tm.user_id = $1
          AND tm.status = 'active'
          AND tm.role IN ('admin', 'inviter')
     )
     SELECT DISTINCT i.id, i.team_id, i.invitee_name, i.email, i.role, i.status, i.purpose, i.created_at, i.expires_at,
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
  const invitations = await invitationListResponse(
    result.rows as InvitationRow[],
    normalizedManagerUserId
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
  const authorized = await withTransaction(async db => {
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

    const inserted = await insertInvitationForTeams(db, {
      inviteeName: normalizedInviteeName || fallbackName,
      email: normalizedEmail,
      purpose: 'member_invitation',
      teamAssignments: assignments,
      fallbackRole: 'member',
      status: 'draft',
    })
    const commandId = await recordInvitationDeliveryCommand(
      db,
      inserted.invitation.id,
      managerUserId,
      'create'
    )
    return { inserted, commandId }
  })
  if ('error' in authorized && authorized.error) return { error: authorized.error }
  const delivered = await deliverAndActivateManagedInvitation(
    authorized.inserted,
    authorized.commandId,
    managerUserId
  )
  if ('error' in delivered) return { error: delivered.error }
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
  if (managerUserId.trim() === targetUserId.trim()) {
    return { error: 'invalid_target' as const }
  }
  const normalizedRole = normalizeTeamRoleInput(role)
  if (!normalizedRole) {
    return { error: 'invalid_role' as const }
  }
  return withTransaction(async db => {
    const locked = await db.query(
      `SELECT user_id::text AS user_id, role
         FROM team_members
        WHERE team_id = $1
          AND user_id = ANY($2::uuid[])
          AND status = 'active'
        ORDER BY user_id
        FOR UPDATE`,
      [teamId.trim(), [managerUserId.trim(), targetUserId.trim()]]
    )
    const memberships = new Map(
      (locked.rows as Array<{ user_id: string; role: TeamRole }>).map(row => [
        row.user_id,
        row.role,
      ])
    )
    if (!roleCanDeleteMembers(memberships.get(managerUserId.trim()))) {
      return { error: 'forbidden' as const }
    }
    const previousRole = memberships.get(targetUserId.trim())
    if (!previousRole) return { error: 'not_found' as const }

    const result = await db.query(
      `UPDATE team_members
          SET role = $3,
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [teamId.trim(), targetUserId.trim(), normalizedRole]
    )
    const membership = result.rows[0]
    if (!membership) return { error: 'not_found' as const }
    if (previousRole !== normalizedRole) {
      await appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: managerUserId.trim(),
        changes: [
          {
            action: 'revoke',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${previousRole}`,
            subject: { kind: 'user', id: targetUserId.trim() },
            teamId: teamId.trim(),
            status: 'role_replaced',
          },
          {
            action: 'grant',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${normalizedRole}`,
            subject: { kind: 'user', id: targetUserId.trim() },
            teamId: teamId.trim(),
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
  if (managerUserId.trim() === targetUserId.trim()) {
    return { error: 'invalid_target' as const }
  }
  return withTransaction(async db => {
    const locked = await db.query(
      `SELECT user_id::text AS user_id, role
         FROM team_members
        WHERE team_id = $1
          AND user_id = ANY($2::uuid[])
          AND status = 'active'
        ORDER BY user_id
        FOR UPDATE`,
      [teamId.trim(), [managerUserId.trim(), targetUserId.trim()]]
    )
    const memberships = new Map(
      (locked.rows as Array<{ user_id: string; role: TeamRole }>).map(row => [
        row.user_id,
        row.role,
      ])
    )
    if (!roleCanDeleteMembers(memberships.get(managerUserId.trim()))) {
      return { error: 'forbidden' as const }
    }
    const targetRole = memberships.get(targetUserId.trim())
    if (!targetRole) return { error: 'not_found' as const }

    const result = await db.query(
      `UPDATE team_members
          SET status = 'deleted',
              updated_at = NOW()
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
      RETURNING team_id, user_id, role, status`,
      [teamId.trim(), targetUserId.trim()]
    )
    const deleted = result.rows[0]
    if (!deleted) return { error: 'not_found' as const }
    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: managerUserId.trim(),
      changes: [
        {
          action: 'revoke',
          resourceClass: 'team_membership',
          resourceRef: `team_membership:${teamId}:role:${targetRole}`,
          subject: { kind: 'user', id: targetUserId.trim() },
          teamId: teamId.trim(),
          status: 'membership_removed',
        },
      ],
    })
    return { deleted }
  })
}

export async function deleteManagedUserForUser(managerUserId: string, targetUserId: string) {
  const normalizedManagerUserId = managerUserId.trim()
  const normalizedTargetUserId = targetUserId.trim()
  if (!normalizedManagerUserId || !normalizedTargetUserId) {
    return { error: 'not_found' as const }
  }
  if (normalizedManagerUserId === normalizedTargetUserId) {
    return { error: 'invalid_target' as const }
  }

  return withTransaction(async db => {
    const targetExists = await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
      normalizedTargetUserId,
    ])
    if ((targetExists.rowCount ?? 0) === 0) return { error: 'not_found' as const }

    const teamsResult = await db.query(
      `SELECT team_id
         FROM team_members
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY team_id
        FOR UPDATE`,
      [normalizedTargetUserId]
    )
    const teamIds = (teamsResult.rows as Array<{ team_id: string }>).map(row => row.team_id)
    if (teamIds.length === 0) return { error: 'not_found' as const }

    const managerResult = await db.query(
      `SELECT team_id, role
         FROM team_members
        WHERE user_id = $1
          AND team_id = ANY($2::uuid[])
          AND status = 'active'
        ORDER BY team_id
        FOR UPDATE`,
      [normalizedManagerUserId, teamIds]
    )
    const managerRoles = new Map(
      (managerResult.rows as Array<{ team_id: string; role: TeamRole }>).map(row => [
        row.team_id,
        row.role,
      ])
    )
    if (!teamIds.every(teamId => roleCanDeleteMembers(managerRoles.get(teamId)))) {
      return { error: 'forbidden_uncontrolled_teams' as const }
    }

    const deleted = await adminDeleteUserInTransaction(db, normalizedTargetUserId)
    if ('error' in deleted) return { error: 'not_found' as const }
    return { deleted }
  })
}

export async function resendManagedInvitationForUser(managerUserId: string, invitationId: string) {
  const authorized = await withTransaction(async db => {
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

    const commandId = await recordInvitationDeliveryCommand(
      db,
      invitation.id,
      managerUserId,
      'resend'
    )
    return { invitation, teams, commandId }
  })
  if ('error' in authorized) return authorized
  const { invitation, teams, commandId } = authorized

  try {
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
  } catch (error) {
    await withTransaction(db =>
      finishInvitationDeliveryCommand(db, commandId, 'failed', 'delivery_failed')
    ).catch(() => undefined)
    throw error
  }
  await withTransaction(db => finishInvitationDeliveryCommand(db, commandId, 'delivered'))
  return { resent: true as const, id: invitation.id, email: invitation.email }
}

export async function revokeManagedInvitationForUser(managerUserId: string, invitationId: string) {
  return withTransaction(async db => {
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

export async function updateUserPassword(
  userId: string,
  email: string,
  currentPassword: string,
  newPassword: string
) {
  const normalizedUserId = userId.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const nextPassword = newPassword.trim()
  if (!normalizedUserId || !normalizedEmail) {
    return { error: 'not_found' as const }
  }
  if (nextPassword.length < 8 || nextPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  const result = await pool.query(
    `SELECT password_hash
       FROM users
      WHERE id = $1
        AND email = $2
      LIMIT 1`,
    [normalizedUserId, normalizedEmail]
  )
  const user = (result.rows[0] as { password_hash: string | null } | undefined) || null
  if (!user) {
    return { error: 'not_found' as const }
  }
  if (!user.password_hash) {
    return { error: 'password_not_set' as const }
  }
  const currentOk = await bcrypt.compare(currentPassword, user.password_hash)
  if (!currentOk) {
    return { error: 'invalid_current_password' as const }
  }

  const nextPasswordHash = await bcrypt.hash(nextPassword, 12)
  return withTransaction(async db => {
    const updated = await db.query(
      `UPDATE users
          SET password_hash = $3,
              password_set_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND email = $2
          AND password_hash = $4
      RETURNING id`,
      [normalizedUserId, normalizedEmail, nextPasswordHash, user.password_hash]
    )
    if ((updated.rowCount ?? 0) === 0) {
      return { error: 'invalid_current_password' as const }
    }
    await revokeAllUserSessions(normalizedUserId, 'password_changed', db)
    return { updated: true as const }
  })
}

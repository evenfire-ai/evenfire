import { type Response, Router } from 'express'
import {
  createInvitation,
  createInvitationForTeams,
  getTeamById,
  listPendingInvitationsForTeam,
  listUsers,
  resendInvitation,
  revokePendingInvitation,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'
import type { UserLifecycleState } from '../../services/directory/users.js'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

type ExistingMember = { id: string; email: string; lifecycleState: UserLifecycleState }

/**
 * Includes retired users: a retired row still holds the address and the
 * invitation could never be accepted, so it is refused too.
 */
async function findExistingMemberByEmail(email: string): Promise<ExistingMember | null> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null
  const matches = await listUsers(normalizedEmail, { includeRetired: true })
  return (
    matches.find(member => String(member.email || '').toLowerCase() === normalizedEmail) || null
  )
}

/**
 * An active member is pointed to their record. A removed (retired) member is
 * not: the admin user list no longer shows them, so there is no member to
 * open, and no path makes a retired user active again.
 */
function sendExistingMemberConflict(res: Response, member: ExistingMember): void {
  if (member.lifecycleState === 'retired') {
    res.status(409).json({
      error: 'member_email_retired',
      message: "This email belongs to a removed member and can't be invited again.",
      email: member.email,
    })
    return
  }
  res.status(409).json({
    error: 'member_email_exists',
    message:
      'A member with this email already exists. Open the existing member and add them to more teams instead.',
    memberId: member.id,
    email: member.email,
  })
}

export function registerAdminTeamInvitationRoutes(router: Router): void {
  router.post('/admin/invitations', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const fallbackRole = normalizeTeamRoleInput(req.body?.role) || 'member'
      const teamsInput: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      const teamAssignments = teamsInput
        .map((item: unknown) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = String(row.teamId || row.id || '').trim()
          const role = normalizeTeamRoleInput(row.role) || fallbackRole
          return teamId ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: 'admin' | 'inviter' | 'member' } =>
          Boolean(item)
        )
      if (!name || !email) {
        res.status(400).json({ error: 'invalid invitation payload' })
        return
      }
      const existingMember = await findExistingMemberByEmail(email)
      if (existingMember) return sendExistingMemberConflict(res, existingMember)
      res.status(200).json(
        await createInvitationForTeams({
          inviteeName: name,
          email,
          purpose: 'member_invitation',
          teamAssignments,
          fallbackRole,
        })
      )
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/invitations/:invitationId/resend', async (req, res, next) => {
    try {
      const invitationId = String(req.params.invitationId || '').trim()
      if (!isUuid(invitationId))
        return void res.status(400).json({ error: 'invalid_invitation_id' })
      const resent = await resendInvitation(null, invitationId)
      if (!resent) return void res.status(404).json({ error: 'not_found' })
      res.status(200).json({ sent: true, id: resent.id, email: resent.email })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/admin/invitations/:invitationId', async (req, res, next) => {
    try {
      const invitationId = String(req.params.invitationId || '').trim()
      if (!isUuid(invitationId))
        return void res.status(400).json({ error: 'invalid_invitation_id' })
      const revoked = await revokePendingInvitation(null, invitationId)
      if (!revoked) return void res.status(404).json({ error: 'not_found' })
      res.status(200).json({ revoked: true, id: revoked.id, email: revoked.email })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/teams/:teamId/invitations', async (req, res, next) => {
    try {
      if (!(await getTeamById(req.params.teamId)))
        return void res.status(404).json({ error: 'not_found' })
      res.status(200).json({ items: await listPendingInvitationsForTeam(req.params.teamId) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/teams/:teamId/invitations', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const role = normalizeTeamRoleInput(req.body?.role)
      if (!name || !email || !role)
        return void res.status(400).json({ error: 'invalid invitation payload' })
      const existingMember = await findExistingMemberByEmail(email)
      if (existingMember) return sendExistingMemberConflict(res, existingMember)
      res.status(200).json(await createInvitation(req.params.teamId, name, email, role))
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/teams/:teamId/invitations/:invitationId/resend', async (req, res, next) => {
    try {
      const resent = await resendInvitation(req.params.teamId, req.params.invitationId)
      if (!resent) return void res.status(404).json({ error: 'not_found' })
      res.status(200).json({ sent: true, id: resent.id, email: resent.email })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/admin/teams/:teamId/invitations/:invitationId', async (req, res, next) => {
    try {
      const revoked = await revokePendingInvitation(req.params.teamId, req.params.invitationId)
      if (!revoked) return void res.status(404).json({ error: 'not_found' })
      res.status(200).json({ revoked: true, id: revoked.id, email: revoked.email })
    } catch (error) {
      next(error)
    }
  })
}

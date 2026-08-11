import { Router } from 'express'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import {
  createManagedInvitationForUser,
  deleteManagedMemberForUser,
  deleteManagedUserForUser,
  listManageableTeamsForUser,
  listManagedMembersForUser,
  listManagedPendingInvitationsForUser,
  resendManagedInvitationForUser,
  revokeManagedInvitationForUser,
  updateManagedMemberRoleForUser,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_INVITATION_TEAM_ASSIGNMENTS = 50
const MAX_INVITEE_NAME_LENGTH = 120

function currentUserId(req: ExternalAuthedRequest): string | null {
  return req.externalAuth?.userId || null
}

export function createExternalMembersRouter(): Router {
  const router = Router()
  router.use('/external/members', requireValidExternalSessionToken)

  router.get(
    '/external/members/manageable-teams',
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const userId = currentUserId(req)
        if (!userId) return res.status(403).json({ error: 'Forbidden' })
        return res.status(200).json({ items: await listManageableTeamsForUser(userId) })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get('/external/members', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const userId = currentUserId(req)
      if (!userId) return res.status(403).json({ error: 'Forbidden' })
      return res.status(200).json({ items: await listManagedMembersForUser(userId) })
    } catch (error) {
      return next(error)
    }
  })

  router.get('/external/members/invitations', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const userId = currentUserId(req)
      if (!userId) return res.status(403).json({ error: 'Forbidden' })
      return res.status(200).json({ items: await listManagedPendingInvitationsForUser(userId) })
    } catch (error) {
      return next(error)
    }
  })

  router.get('/external/members/:userId', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const managerUserId = currentUserId(req)
      if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
      const items = await listManagedMembersForUser(managerUserId, req.params.userId)
      const member = items[0] || null
      if (!member) return res.status(404).json({ error: 'not_found' })
      return res.status(200).json(member)
    } catch (error) {
      return next(error)
    }
  })

  router.post('/external/members/invitations', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const managerUserId = currentUserId(req)
      if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const name = String(req.body?.name || '').trim()
      const teams: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: 'invalid_email' })
      }
      if (name.length > MAX_INVITEE_NAME_LENGTH) {
        return res.status(400).json({ error: 'invalid_name' })
      }
      if (teams.length > MAX_INVITATION_TEAM_ASSIGNMENTS) {
        return res.status(400).json({ error: 'too_many_teams' })
      }
      const teamAssignments = teams
        .map((item: unknown) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = String(row.teamId || row.id || '').trim()
          const role = normalizeTeamRoleInput(row.role) || 'member'
          return teamId ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: 'admin' | 'inviter' | 'member' } =>
          Boolean(item)
        )
      const result = await createManagedInvitationForUser(
        managerUserId,
        email,
        teamAssignments,
        name
      )
      if ('error' in result) {
        if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
        return res.status(400).json({ error: 'invalid_payload' })
      }
      return res.status(201).json(result.invitation)
    } catch (error) {
      return next(error)
    }
  })

  router.post(
    '/external/members/invitations/:invitationId/resend',
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const managerUserId = currentUserId(req)
        if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
        const result = await resendManagedInvitationForUser(managerUserId, req.params.invitationId)
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(result)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.delete(
    '/external/members/invitations/:invitationId',
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const managerUserId = currentUserId(req)
        if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
        const result = await revokeManagedInvitationForUser(managerUserId, req.params.invitationId)
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(result)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.patch(
    '/external/members/:userId/teams/:teamId/role',
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const managerUserId = currentUserId(req)
        if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
        const role = normalizeTeamRoleInput(req.body?.role)
        if (!role) return res.status(400).json({ error: 'invalid_role' })
        const result = await updateManagedMemberRoleForUser(
          managerUserId,
          req.params.userId,
          req.params.teamId,
          role
        )
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' })
          if (result.error === 'invalid_target') {
            return res.status(400).json({ error: 'invalid_target' })
          }
          return res.status(400).json({ error: 'invalid_role' })
        }
        return res.status(200).json(result.membership)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.delete('/external/members/:userId', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const managerUserId = currentUserId(req)
      if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
      if (!reason) return res.status(400).json({ error: 'reason_required' })
      const idempotencyKey = String(req.header('Idempotency-Key') || '').trim()
      if (!idempotencyKey) return res.status(400).json({ error: 'idempotency_key_required' })
      const result = await deleteManagedUserForUser(managerUserId, req.params.userId, {
        reason,
        idempotencyKey,
        requestId: req.correlationId ?? null,
      })
      if ('error' in result) {
        if (result.error === 'forbidden_uncontrolled_teams') {
          return res.status(403).json({ error: 'forbidden_uncontrolled_teams' })
        }
        if (result.error === 'invalid_target') {
          return res.status(400).json({ error: 'invalid_target' })
        }
        if (result.error === 'invalid_retirement_input') {
          return res.status(400).json({ error: 'invalid_retirement_input' })
        }
        if (result.error === 'idempotency_conflict' || result.error === 'retirement_conflict') {
          return res.status(409).json({ error: result.error })
        }
        return res.status(404).json({ error: 'not_found' })
      }
      return res.status(200).json(result.deleted)
    } catch (error) {
      return next(error)
    }
  })

  router.delete(
    '/external/members/:userId/teams/:teamId',
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const managerUserId = currentUserId(req)
        if (!managerUserId) return res.status(403).json({ error: 'Forbidden' })
        const result = await deleteManagedMemberForUser(
          managerUserId,
          req.params.userId,
          req.params.teamId
        )
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          if (result.error === 'invalid_target') {
            return res.status(400).json({ error: 'invalid_target' })
          }
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(result.deleted)
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}

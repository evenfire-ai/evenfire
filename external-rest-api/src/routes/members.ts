import { Router } from 'express'
import { ControlApiError } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  cancelManagedInvitation,
  deleteManagedMember,
  deleteManagedUser,
  getManagedMember,
  inviteManagedMember,
  listManageableTeams,
  listManagedInvitations,
  listManagedMembers,
  resendManagedInvitation,
  updateManagedMemberRole,
} from '../services/memberManagementService.js'
import { TEAM_ROLES, TeamRole } from '../types.js'

const MAX_INVITATION_EMAIL_LENGTH = 320
const MAX_INVITATION_TEAM_ASSIGNMENTS = 50
const MAX_INVITEE_NAME_LENGTH = 120

function isControlApiBadRequest(error: unknown, code: string): boolean {
  if (!(error instanceof ControlApiError) || error.status !== 400) return false
  if (!error.body || typeof error.body !== 'object') return false
  return (error.body as { error?: unknown }).error === code
}

export function createMembersRouter(): Router {
  const router = Router()

  router.get('/members/manageable-teams', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.status(200).json(await listManageableTeams(extractAuthToken(req)))
    } catch (error) {
      next(error)
    }
  })

  router.get('/members', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.status(200).json(await listManagedMembers(extractAuthToken(req)))
    } catch (error) {
      next(error)
    }
  })

  router.get('/members/invitations', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.status(200).json(await listManagedInvitations(extractAuthToken(req)))
    } catch (error) {
      next(error)
    }
  })

  router.get('/members/:userId', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.status(200).json(await getManagedMember(req.params.userId, extractAuthToken(req)))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(404)')) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      next(error)
    }
  })

  router.post('/members/invite', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const rawEmail = req.body?.email
      if (typeof rawEmail !== 'string' || rawEmail.length > MAX_INVITATION_EMAIL_LENGTH) {
        res.status(400).json({ error: 'Valid email is required' })
        return
      }
      const email = rawEmail.trim().toLowerCase()
      const normalizedName = String(req.body?.name || '').trim()
      const name =
        normalizedName.length > MAX_INVITEE_NAME_LENGTH
          ? 'x'.repeat(MAX_INVITEE_NAME_LENGTH + 1)
          : normalizedName
      const rawTeams: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      const teams =
        rawTeams.length > MAX_INVITATION_TEAM_ASSIGNMENTS
          ? Array.from({ length: MAX_INVITATION_TEAM_ASSIGNMENTS + 1 }, () => null)
          : rawTeams
              .map((item: unknown) => {
                const row =
                  item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
                const teamId = String(row.teamId || row.id || '').trim()
                const role = String(row.role || 'member').trim() as TeamRole
                return teamId && TEAM_ROLES.includes(role) ? { teamId, role } : null
              })
              .filter((item): item is { teamId: string; role: TeamRole } => Boolean(item))
      res.status(201).json(await inviteManagedMember(email, name, teams, extractAuthToken(req)))
    } catch (error) {
      if (isControlApiBadRequest(error, 'invalid_email')) {
        res.status(400).json({ error: 'Valid email is required' })
        return
      }
      if (isControlApiBadRequest(error, 'invalid_payload')) {
        res.status(400).json({ error: 'Email and at least one team are required' })
        return
      }
      if (isControlApiBadRequest(error, 'invalid_name')) {
        res.status(400).json({ error: 'Name is too long' })
        return
      }
      if (isControlApiBadRequest(error, 'too_many_teams')) {
        res.status(400).json({ error: 'Too many teams selected' })
        return
      }
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(403)')) {
        res.status(403).json({ error: 'You are not allowed to invite with those permissions' })
        return
      }
      next(error)
    }
  })

  router.post(
    '/members/invitations/:invitationId/resend',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        res
          .status(200)
          .json(await resendManagedInvitation(req.params.invitationId, extractAuthToken(req)))
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.includes('(403)')) {
          res.status(403).json({ error: 'You are not allowed to resend this invitation' })
          return
        }
        if (message.includes('(404)')) {
          res.status(404).json({ error: 'Invitation not found' })
          return
        }
        next(error)
      }
    }
  )

  router.delete(
    '/members/invitations/:invitationId',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        res
          .status(200)
          .json(await cancelManagedInvitation(req.params.invitationId, extractAuthToken(req)))
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.includes('(403)')) {
          res.status(403).json({ error: 'You are not allowed to cancel this invitation' })
          return
        }
        if (message.includes('(404)')) {
          res.status(404).json({ error: 'Invitation not found' })
          return
        }
        next(error)
      }
    }
  )

  router.patch('/members/:userId/teams/:teamId/role', requireAuth, async (req, res, next) => {
    try {
      const role = String(req.body?.role || '').trim() as TeamRole
      if (!TEAM_ROLES.includes(role)) {
        res.status(400).json({ error: 'Valid role is required' })
        return
      }
      res
        .status(200)
        .json(
          await updateManagedMemberRole(
            req.params.userId,
            req.params.teamId,
            role,
            extractAuthToken(req)
          )
        )
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(403)')) {
        res.status(403).json({ error: 'You are not allowed to change permissions' })
        return
      }
      if (message.includes('(404)')) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      next(error)
    }
  })

  router.delete('/members/:userId/teams/:teamId', requireAuth, async (req, res, next) => {
    try {
      res
        .status(200)
        .json(
          await deleteManagedMember(req.params.userId, req.params.teamId, extractAuthToken(req))
        )
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(403)')) {
        res.status(403).json({ error: 'You are not allowed to delete this member' })
        return
      }
      if (message.includes('(400)')) {
        res.status(400).json({ error: 'Cannot delete yourself from this endpoint' })
        return
      }
      if (message.includes('(404)')) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      next(error)
    }
  })

  router.delete('/members/:userId', requireAuth, async (req, res, next) => {
    try {
      res.status(200).json(await deleteManagedUser(req.params.userId, extractAuthToken(req)))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(403)')) {
        res.status(403).json({ error: 'You do not control all teams this member belongs to' })
        return
      }
      if (message.includes('(400)')) {
        res.status(400).json({ error: 'Cannot delete yourself from this endpoint' })
        return
      }
      if (message.includes('(404)')) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      next(error)
    }
  })

  return router
}

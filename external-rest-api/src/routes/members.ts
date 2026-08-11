import { type NextFunction, type Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_INVITATION_TEAM_ASSIGNMENTS = 50
const MAX_INVITEE_NAME_LENGTH = 120
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEMBER_RETIREMENT_RATE_LIMIT_PER_MINUTE = 30
const MAX_RETIREMENT_REASON_LENGTH = 512
const MAX_RETIREMENT_IDEMPOTENCY_KEY_LENGTH = 256

// Retirement is an authenticated destructive operation. Keep the guard at
// the public route boundary so CodeQL and deployed edge instrumentation both
// see a concrete limiter before the downstream authorization/service call.
const memberRetirementRateLimit = rateLimit({
  windowMs: 60_000,
  limit: MEMBER_RETIREMENT_RATE_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  identifier: 'external-member-retirement',
  keyGenerator: req => {
    const userId = (req as AuthedRequest).auth?.userId
    return userId ? `member-retirement:${userId}` : 'member-retirement:unauthenticated'
  },
})

function retirementCorrelationId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized && UUID_ANY_RE.test(normalized) ? normalized.toLowerCase() : randomUUID()
}

function printableBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null
  }
  return normalized
}

type MemberRetirementRequest = AuthedRequest & {
  memberRetirement?: {
    reason: string
    idempotencyKey: string
    correlationId: string
  }
}

/**
 * Establish the public retirement contract before the authorization-sensitive
 * handler runs. It never coerces user-controlled values, so arrays, objects,
 * control characters, overlong strings, and missing fields cannot reach the
 * Control API as a different request than the one validated here.
 */
function validateMemberRetirementRequest(
  req: MemberRetirementRequest,
  res: Response,
  next: NextFunction
): void {
  const reason = printableBoundedString(req.body?.reason, MAX_RETIREMENT_REASON_LENGTH)
  if (!reason) {
    res.status(400).json({ error: 'Retirement reason is required' })
    return
  }
  const idempotencyKey = printableBoundedString(
    req.header('Idempotency-Key'),
    MAX_RETIREMENT_IDEMPOTENCY_KEY_LENGTH
  )
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Idempotency-Key header is required' })
    return
  }
  req.memberRetirement = {
    reason,
    idempotencyKey,
    correlationId: retirementCorrelationId(req.header('x-correlation-id')),
  }
  next()
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
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const name = String(req.body?.name || '').trim()
      const teams: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      if (!EMAIL_PATTERN.test(email)) {
        res.status(400).json({ error: 'Valid email is required' })
        return
      }
      if (name.length > MAX_INVITEE_NAME_LENGTH) {
        res.status(400).json({ error: 'Name is too long' })
        return
      }
      if (teams.length > MAX_INVITATION_TEAM_ASSIGNMENTS) {
        res.status(400).json({ error: 'Too many teams selected' })
        return
      }
      const assignments = teams
        .map((item: unknown) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = String(row.teamId || row.id || '').trim()
          const role = String(row.role || 'member').trim() as TeamRole
          return teamId && TEAM_ROLES.includes(role) ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: TeamRole } => Boolean(item))
      if (!email || assignments.length === 0) {
        res.status(400).json({ error: 'Email and at least one team are required' })
        return
      }
      res
        .status(201)
        .json(await inviteManagedMember(email, name, assignments, extractAuthToken(req)))
    } catch (error) {
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

  router.delete(
    '/members/:userId',
    requireAuth,
    memberRetirementRateLimit,
    validateMemberRetirementRequest,
    async (req, res, next) => {
      try {
        // validateMemberRetirementRequest is ordered immediately before this
        // handler, so the normalized contract is an internal invariant here.
        const retirement = (req as MemberRetirementRequest).memberRetirement!
        res.status(200).json(
          await deleteManagedUser(req.params.userId, extractAuthToken(req), {
            reason: retirement.reason,
            idempotencyKey: retirement.idempotencyKey,
            correlationId: retirement.correlationId,
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (error instanceof ControlApiError && error.status === 400) {
          const code =
            error.body && typeof error.body === 'object' && 'error' in error.body
              ? String((error.body as { error: unknown }).error)
              : ''
          if (code === 'reason_required' || code === 'idempotency_key_required') {
            res.status(400).json(error.body)
            return
          }
        }
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
        if (message.includes('(409)')) {
          res.status(409).json({ error: 'Retirement request conflicts with an earlier request' })
          return
        }
        next(error)
      }
    }
  )

  return router
}

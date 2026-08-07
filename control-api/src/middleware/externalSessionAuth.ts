import { NextFunction, Request, Response } from 'express'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import {
  type LiveTeamMembershipAuthorization,
  authorizeLiveTeamMembership,
} from '../services/directory/index.js'
import { verifyExternalSessionToken } from '../utils/auth/externalSessionAuthToken.js'

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
  externalTeamAuth?: Extract<LiveTeamMembershipAuthorization, { status: 'active' }>['membership']
}

function extractUserSessionToken(req: Request): string {
  return String(req.header('x-user-session-token') || '').trim()
}

export function requireValidExternalSessionToken(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const token = extractUserSessionToken(req)
  if (!token || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyExternalSessionToken(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.externalAuth = claims
  next()
}

export function requireExternalUserParamMatch(paramName = 'userId') {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.externalAuth
    const requestedUserId = String(req.params?.[paramName] || '').trim()
    if (!claims || !requestedUserId || claims.userId !== requestedUserId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

export function requireExternalTeamParamMatch(
  paramName = 'teamId',
  source: 'params' | 'query' = 'params'
) {
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const claims = req.externalAuth
    const requestedTeamId = String(req[source]?.[paramName] || '').trim()
    if (!claims || !requestedTeamId || claims.teamId !== requestedTeamId) {
      res.status(403).json({ error: 'team_context_mismatch' })
      return
    }

    const authorization = await authorizeLiveTeamMembership(claims.userId, requestedTeamId)
    if (authorization.status === 'unavailable') {
      res.status(503).json({ error: authorization.code })
      return
    }
    if (authorization.status === 'denied') {
      res.status(403).json({ error: authorization.code })
      return
    }

    req.externalTeamAuth = authorization.membership
    next()
  }
}

export function rejectBodyUserTeamMismatch(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const claims = req.externalAuth
  if (!claims) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const body = req.body ?? {}
  const bodyUserId = String((body as { userId?: unknown }).userId || '').trim()
  const bodyTeamId = String((body as { teamId?: unknown }).teamId || '').trim()
  if (
    (bodyUserId && bodyUserId !== claims.userId) ||
    (bodyTeamId && bodyTeamId !== claims.teamId)
  ) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

export function requireExternalRole(allowedRoles: TeamRole[]) {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const role = req.externalTeamAuth?.role
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: 'team_role_insufficient' })
      return
    }
    next()
  }
}

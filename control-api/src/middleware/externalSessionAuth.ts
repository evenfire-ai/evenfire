import { NextFunction, Request, Response } from 'express'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import { verifyExternalSessionToken } from '../utils/auth/externalSessionAuthToken.js'

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
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

export function requireExternalTeamParamMatch(paramName = 'teamId') {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.externalAuth
    const requestedTeamId = String(req.params?.[paramName] || '').trim()
    if (!claims || !requestedTeamId || claims.teamId !== requestedTeamId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
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
    const role = req.externalAuth?.role
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

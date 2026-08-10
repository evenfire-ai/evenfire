import { NextFunction, Request, Response } from 'express'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import { getLiveTeamMembership } from '../services/access/liveTeamAuthorization.js'
import { validateUserSessionClaims } from '../services/auth/userSessionService.js'
import { verifyExternalSessionToken } from '../utils/auth/externalSessionAuthToken.js'

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
  externalTeamAuth?: {
    teamId: string
    role: TeamRole
  }
}

function extractUserSessionToken(req: Request): string {
  return String(req.header('x-user-session-token') || '').trim()
}

export async function requireValidExternalSessionToken(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractUserSessionToken(req)
  if (!token || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const claims = verifyExternalSessionToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (claims.sessionContract === 'v2') {
      const validation = await validateUserSessionClaims({
        sub: claims.userId,
        sid: claims.sid!,
        jti: claims.jti!,
        sv: claims.sv!,
        ver: 2,
        typ: 'user_session',
        ...(claims.email ? { email: claims.email } : {}),
        auth_time: claims.authTime!,
        amr: [...(claims.amr || [])],
        iat: claims.iat!,
        exp: claims.exp,
      })
      if (validation.status !== 'valid') {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      claims.email = validation.identity.email
      claims.jti = validation.identity.jti
      claims.sv = validation.identity.sessionVersion
    }

    req.externalAuth = claims
    next()
  } catch {
    res.status(503).json({ error: 'authority_unavailable' })
  }
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
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const claims = req.externalAuth
    const requestedTeamId = String(req.params?.[paramName] || req.query?.[paramName] || '').trim()
    if (!claims || !requestedTeamId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    try {
      const membership = await getLiveTeamMembership(claims.userId, requestedTeamId)
      if (!membership) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      req.externalTeamAuth = membership
      next()
    } catch {
      res.status(503).json({ error: 'authority_unavailable' })
    }
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
    (bodyTeamId && (!req.externalTeamAuth || bodyTeamId !== req.externalTeamAuth.teamId))
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
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

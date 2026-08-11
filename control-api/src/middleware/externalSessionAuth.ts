import { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import { getLiveTeamMembership } from '../services/access/liveTeamAuthorization.js'
import { userAccessRollout } from '../services/access/userAccessRollout.js'
import {
  validateLegacyUserSession,
  validateUserSessionClaims,
} from '../services/auth/userSessionService.js'
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

async function validateExternalSessionToken(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction,
  publicErrors: boolean
): Promise<void> {
  const token = extractUserSessionToken(req)
  if (!token || token.length > 4096) {
    if (publicErrors) {
      sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
    } else {
      res.status(401).json({ error: 'Unauthorized' })
    }
    return
  }

  try {
    const claims = verifyExternalSessionToken(token)
    if (!claims) {
      if (publicErrors) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
      } else {
        res.status(401).json({ error: 'Unauthorized' })
      }
      return
    }
    if (claims.sessionContract === 'v2') {
      if (!userAccessRollout.sessionV2Acceptance) {
        if (publicErrors) {
          sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        } else {
          res.status(401).json({ error: 'Unauthorized' })
        }
        return
      }
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
        if (publicErrors) {
          sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        } else {
          res.status(401).json({ error: 'Unauthorized' })
        }
        return
      }
      claims.email = validation.identity.email
      claims.jti = validation.identity.jti
      claims.sv = validation.identity.sessionVersion
    } else {
      if (!userAccessRollout.legacyV1Acceptance) {
        if (publicErrors) {
          sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        } else {
          res.status(401).json({ error: 'Unauthorized' })
        }
        return
      }
      const validation = await validateLegacyUserSession(token, claims)
      if (validation.status !== 'valid') {
        if (publicErrors) {
          sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        } else {
          res.status(401).json({ error: 'Unauthorized' })
        }
        return
      }
    }

    req.externalAuth = claims
    next()
  } catch {
    if (publicErrors) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Authorization is temporarily unavailable.',
        true
      )
    } else {
      res.status(503).json({ error: 'authority_unavailable' })
    }
  }
}

export async function requireValidExternalSessionToken(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  return validateExternalSessionToken(req, res, next, false)
}

export async function requireValidExternalSessionTokenWithPublicErrors(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  return validateExternalSessionToken(req, res, next, true)
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

function externalTeamParamMatcher(paramName: string, publicErrors: boolean) {
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const claims = req.externalAuth
    const requestedTeamId = String(req.params?.[paramName] || req.query?.[paramName] || '').trim()
    if (!claims || !requestedTeamId) {
      if (publicErrors) {
        sendPublicApiError(req, res, 403, 'forbidden', 'The requested operation is not allowed.')
      } else {
        res.status(403).json({ error: 'Forbidden' })
      }
      return
    }
    try {
      const membership = await getLiveTeamMembership(claims.userId, requestedTeamId)
      if (!membership) {
        if (publicErrors) {
          sendPublicApiError(req, res, 403, 'forbidden', 'The requested operation is not allowed.')
        } else {
          res.status(403).json({ error: 'Forbidden' })
        }
        return
      }
      req.externalTeamAuth = membership
      next()
    } catch {
      if (publicErrors) {
        sendPublicApiError(
          req,
          res,
          503,
          'authority_unavailable',
          'Authorization is temporarily unavailable.',
          true
        )
      } else {
        res.status(503).json({ error: 'authority_unavailable' })
      }
    }
  }
}

export function requireExternalTeamParamMatch(paramName = 'teamId') {
  return externalTeamParamMatcher(paramName, false)
}

export function requireExternalTeamParamMatchWithPublicErrors(paramName = 'teamId') {
  return externalTeamParamMatcher(paramName, true)
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

export function requireExternalRoleWithPublicErrors(allowedRoles: TeamRole[]) {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const role = req.externalTeamAuth?.role
    if (!role || !allowedRoles.includes(role)) {
      sendPublicApiError(req, res, 403, 'forbidden', 'The requested operation is not allowed.')
      return
    }
    next()
  }
}

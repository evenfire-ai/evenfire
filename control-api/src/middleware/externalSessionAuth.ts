import { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import type { AccessExecutionBudget } from '../services/access/accessExecutionBudget.js'
import { getLiveTeamMembership } from '../services/access/liveTeamAuthorization.js'
import { authenticateExternalUserSession } from '../services/auth/externalSessionAuthentication.js'
import type {
  ExternalSessionAuthentication,
  ExternalSessionAuthorityContext,
  ExternalSessionClient,
  ExternalSessionPurpose,
} from '../services/auth/externalSessionAuthentication.js'

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
  externalSessionAuthority?: ExternalSessionAuthorityContext
  externalSessionAuthentication?: Extract<
    ExternalSessionAuthentication,
    { status: 'authenticated' }
  >
  accessExecutionBudget?: AccessExecutionBudget
  externalTeamAuth?: {
    teamId: string
    role: TeamRole
  }
}

function extractUserSessionToken(req: Request): string {
  return String(req.header('x-user-session-token') || '').trim()
}

function extractRouteSessionToken(req: Request): string {
  const body = (req.body ?? {}) as { token?: unknown; sessionToken?: unknown }
  return String(req.header('x-user-session-token') || body.token || body.sessionToken || '').trim()
}

function sendSessionAuthenticationError(
  req: Request,
  res: Response,
  status: 'invalid' | 'upgrade_required'
): void {
  if (status === 'upgrade_required') {
    sendPublicApiError(req, res, 426, 'upgrade_required', 'A newer client is required.')
    return
  }
  sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
}

/**
 * Establishes trusted, live external-session context without performing a
 * protected operation. It is intended to precede post-auth rate limiting.
 */
export function requireExternalSessionRateLimitContext(options: {
  purpose: ExternalSessionPurpose
  client?: (req: Request) => ExternalSessionClient
  requireV2?: boolean
}) {
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = extractRouteSessionToken(req)
    if (!token || token.length > 4096) {
      sendSessionAuthenticationError(req, res, 'invalid')
      return
    }
    try {
      const authentication = await authenticateExternalUserSession(token, {
        purpose: options.purpose,
        ...(options.client ? { client: options.client(req) } : {}),
      })
      if (authentication.status === 'upgrade_required') {
        sendSessionAuthenticationError(req, res, 'upgrade_required')
        return
      }
      if (authentication.status !== 'authenticated') {
        sendSessionAuthenticationError(req, res, 'invalid')
        return
      }
      if (options.requireV2 && authentication.contract !== 'v2') {
        sendPublicApiError(
          req,
          res,
          409,
          'conflict',
          'A user-session v2 login is required for session management.'
        )
        return
      }
      req.externalAuth = authentication.claims
      req.externalSessionAuthority = authentication.authorityContext
      req.externalSessionAuthentication = authentication
      next()
    } catch {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
    }
  }
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
    const authentication = await authenticateExternalUserSession(token, {
      purpose: 'protected',
      client: { version: req.header('x-evenfire-client-version') || undefined },
      budget: req.accessExecutionBudget,
    })
    if (authentication.status === 'upgrade_required') {
      if (publicErrors) {
        sendPublicApiError(req, res, 426, 'upgrade_required', 'A newer client is required.')
      } else {
        res.status(426).json({ error: 'upgrade_required' })
      }
      return
    }
    if (authentication.status !== 'authenticated') {
      if (publicErrors) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
      } else {
        res.status(401).json({ error: 'Unauthorized' })
      }
      return
    }
    req.externalAuth = authentication.claims
    req.externalSessionAuthority = authentication.authorityContext
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

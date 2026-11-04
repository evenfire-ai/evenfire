import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../authToken.js'
import { sendPublicApiError } from '../http/publicApiError.js'
import { PROFILE_SESSION_COOKIE, readCookie } from '../sessionCookie.js'
import { AuthClaims } from '../types.js'

export type AuthedRequest = Request & {
  auth?: AuthClaims
}

export function extractAuthToken(req: Request): string {
  const raw = String(req.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, '').trim()
  }
  return readCookie(req, PROFILE_SESSION_COOKIE)
}

/** The edge's own token check: claims for a present, bounded and verified token, else null. */
export function authenticateRequest(req: Request): AuthClaims | null {
  const token = extractAuthToken(req)
  if (!token || token.length > 4096) return null
  return verifyToken(token)
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const claims = authenticateRequest(req)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  req.auth = claims
  next()
}

/**
 * `requireAuth` for the session probe (`GET /me`): a missing, malformed, expired or
 * badly signed token ends the session, so it is answered with the `invalid_session`
 * envelope that clients treat as the only proof of a session end.
 */
export function requireSessionAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const claims = authenticateRequest(req)
  if (!claims) {
    sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
    return
  }
  req.auth = claims
  next()
}

export function requireSelf(field = 'userId') {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const requestedUserId = String(req.body?.[field] || '').trim()
    if (requestedUserId && requestedUserId !== auth.userId) {
      res.status(403).json({ error: 'You can only update your own profile details' })
      return
    }

    next()
  }
}

import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../authToken.js'
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

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractAuthToken(req)
  if (!token || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyToken(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
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

import { NextFunction, Request, Response } from 'express'
import { verifyRpcToken } from '../authToken.js'
import { config } from '../config.js'
import { RpcAccessClaims, RpcScope } from '../types.js'

export type AuthedRequest = Request & {
  auth?: RpcAccessClaims
}

export function extractAuthToken(req: Request): string {
  const raw = String(req.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, '').trim()
  }
  return ''
}

export function requireRpcAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractAuthToken(req)
  if (!token || token.length > config.maxTokenLength) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyRpcToken(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  if (claims.typ !== 'user') {
    res.status(403).json({ error: 'Forbidden: user token required' })
    return
  }

  req.auth = claims
  next()
}

export function requireScope(scope: RpcScope) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth || !auth.scopes.includes(scope)) {
      res.status(403).json({ error: 'Forbidden: missing scope' })
      return
    }
    next()
  }
}

export function requireTeamAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const auth = req.auth
  if (!auth || auth.accessScope !== 'team' || !auth.teamId) {
    res.status(403).json({ error: 'Forbidden: team access required' })
    return
  }
  next()
}

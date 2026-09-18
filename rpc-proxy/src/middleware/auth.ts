import { NextFunction, Request, Response } from 'express'
import type { AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { verifyRpcToken } from '../authToken.js'
import { config } from '../config.js'
import { authorizeBoundRequestV2 } from '../routeActionBindingV2.js'
import { RpcAccessClaims, RpcScope } from '../types.js'
import {
  type UserDelegationV2Claims,
  tokenDeclaresV2,
  verifyUserDelegationV2,
} from '../userDelegationV2.js'

export type AuthedRequest = Request & {
  auth?: RpcAccessClaims
  userDelegationV2?: UserDelegationV2Claims
  authorizedActionV2?: AuthorizedActionV2
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

  if (tokenDeclaresV2(token)) {
    const delegation = verifyUserDelegationV2(token)
    if (!delegation) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.userDelegationV2 = delegation
    // Deliberately authority-empty compatibility projection. Existing handlers
    // consume only the common subject/expiry fields; v2 authorization happens
    // in authorizeBoundRequestV2 below, never through legacy RpcScope values.
    req.auth = {
      sub: delegation.sub,
      typ: 'user',
      accessScope: 'user',
      teamId: null,
      scopes: [],
      hostRefs: [delegation.resource.logicalId],
      jti: delegation.jti,
      iat: delegation.iat,
      exp: delegation.exp,
    }
    next()
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
    if (req.userDelegationV2) {
      void authorizeBoundRequestV2(req, res, next)
      return
    }
    const auth = req.auth
    if (!auth || !auth.scopes.includes(scope)) {
      res.status(403).json({ error: 'Forbidden: missing scope' })
      return
    }
    next()
  }
}

/**
 * Public rpc-proxy requests cannot supply trusted edge authorization context.
 * Strip the entire namespace before any route can inspect or forward it.
 */
export function stripInboundTrustedEdgeHeaders(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith('x-clerum-edge-')) delete req.headers[name]
  }
  next()
}

export function requireTeamAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const auth = req.auth
  if (!auth || auth.accessScope !== 'team' || !auth.teamId) {
    res.status(403).json({ error: 'Forbidden: team access required' })
    return
  }
  next()
}

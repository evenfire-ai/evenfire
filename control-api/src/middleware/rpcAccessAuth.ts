import { NextFunction, Request, Response } from 'express'
import { RpcAccessClaims, RpcScope } from '../profileTypes.js'
import { verifyRpcAccessToken } from '../utils/auth/rpcAuthToken.js'

type RpcAuthedRequest = Request & {
  rpcAuth?: RpcAccessClaims
}

function extractRpcAccessToken(req: Request): string {
  return String(req.header('x-rpc-access-token') || '').trim()
}

export function requireValidRpcAccessToken(scope: RpcScope = 'mcp:servers:list') {
  return (req: RpcAuthedRequest, res: Response, next: NextFunction): void => {
    const token = extractRpcAccessToken(req)
    if (!token || token.length > 4096) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const claims = verifyRpcAccessToken(token)
    if (!claims || claims.typ !== 'user') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!claims.scopes.includes(scope)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    req.rpcAuth = claims
    next()
  }
}

export function requireValidRpcAccessTokenAny(scopes: RpcScope[]) {
  return (req: RpcAuthedRequest, res: Response, next: NextFunction): void => {
    const token = extractRpcAccessToken(req)
    if (!token || token.length > 4096) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const claims = verifyRpcAccessToken(token)
    if (!claims || claims.typ !== 'user') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!scopes.some(scope => claims.scopes.includes(scope))) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    req.rpcAuth = claims
    next()
  }
}

export function requireRpcTokenUserMatch(paramName = 'userId') {
  return (req: RpcAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.rpcAuth
    const userId = String(req.params?.[paramName] || '').trim()
    if (!claims || !userId || claims.sub !== userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

export function requireRpcTokenTeamMatch(paramName = 'teamId') {
  return (req: RpcAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.rpcAuth
    const teamId = String(req.params?.[paramName] || '').trim()
    if (!claims || claims.accessScope !== 'team' || !teamId || claims.teamId !== teamId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

export function requireRpcTokenHostMatch(paramName = 'hostRef') {
  return (req: RpcAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.rpcAuth
    const hostRef = String(req.params?.[paramName] || '').trim()
    if (!claims || !hostRef || !claims.hostRefs.includes(hostRef)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

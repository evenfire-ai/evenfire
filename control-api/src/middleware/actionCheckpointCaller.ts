import type { NextFunction, Request, Response } from 'express'
import { requireInternalToken } from './internalServiceAuth.js'

export type ActionCheckpointCallerService = 'rpc-proxy'

export type ActionCheckpointCallerIdentity = Readonly<{
  service: ActionCheckpointCallerService
  trustPlane: 'internal_service_token'
}>

declare global {
  namespace Express {
    interface Request {
      actionCheckpointCaller?: ActionCheckpointCallerIdentity
    }
  }
}

type CallerAuthenticator = Readonly<{
  service: ActionCheckpointCallerService
  authenticate(req: Request, res: Response, next: NextFunction): void
}>

function rpcProxyAuthenticator(): CallerAuthenticator {
  return Object.freeze({
    service: 'rpc-proxy',
    authenticate: requireInternalToken,
  })
}

// Each future arm must compose that service's existing verifier. This boundary
// normalizes only the authenticated service identity; it never introduces a
// checkpoint-wide credential or treats service claims as user authority.
const callerAuthenticators: readonly CallerAuthenticator[] = Object.freeze([
  rpcProxyAuthenticator(),
])

export function requireActionCheckpointCaller(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestedService = String(req.header('x-service-token') || '').trim()
  const authenticator = callerAuthenticators.find(item => item.service === requestedService)
  if (!authenticator) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  authenticator.authenticate(req, res, () => {
    if (req.internalService?.name !== authenticator.service) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.actionCheckpointCaller = Object.freeze({
      service: authenticator.service,
      trustPlane: 'internal_service_token',
    })
    next()
  })
}

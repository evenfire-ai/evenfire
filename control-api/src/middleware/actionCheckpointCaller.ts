import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'
import { requireInternalToken } from './internalServiceAuth.js'
import { requireMcpHostJwt } from './mcpHostJwtAuth.js'

export type ActionCheckpointCallerService = 'rpc-proxy' | 'mcp-host'

export type ActionCheckpointCallerIdentity = Readonly<{
  service: ActionCheckpointCallerService
  trustPlane: 'internal_service_token' | 'mcp_host_runtime_jwt'
  permittedResource?: Readonly<{
    type: 'host' | 'workflow_recipe'
    logicalId: string
  }>
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
  matches(req: Request): boolean
  authenticate(req: Request, res: Response, next: NextFunction): void
  identity(req: Request): ActionCheckpointCallerIdentity | null
}>

function rpcProxyAuthenticator(): CallerAuthenticator {
  return Object.freeze({
    service: 'rpc-proxy',
    matches: req => String(req.header('x-service-token') || '').trim() === 'rpc-proxy',
    authenticate: requireInternalToken,
    identity: req =>
      req.internalService?.name === 'rpc-proxy'
        ? Object.freeze({ service: 'rpc-proxy', trustPlane: 'internal_service_token' })
        : null,
  })
}

function mcpHostAuthenticator(): CallerAuthenticator {
  return Object.freeze({
    service: 'mcp-host',
    matches: req => !String(req.header('x-service-token') || '').trim(),
    authenticate: requireMcpHostJwt,
    identity: req => {
      const claims = req.mcpHostJwt
      const hostRef = claims?.hostRefs[0]?.trim()
      if (!claims || claims.hostRefs.length !== 1 || !hostRef) return null
      const permittedResource =
        claims.recipeNamespace === config.hostsNamespace
          ? !hostRef.includes('/')
            ? { type: 'host' as const, logicalId: `${config.hostsNamespace}/${hostRef}` }
            : null
          : hostRef === `${claims.recipeNamespace}/${claims.recipeName}`
            ? { type: 'workflow_recipe' as const, logicalId: hostRef }
            : null
      if (!permittedResource) return null
      return Object.freeze({
        service: 'mcp-host',
        trustPlane: 'mcp_host_runtime_jwt',
        permittedResource: Object.freeze(permittedResource),
      })
    },
  })
}

// Each future arm must compose that service's existing verifier. This boundary
// normalizes only the authenticated service identity; it never introduces a
// checkpoint-wide credential or treats service claims as user authority.
const callerAuthenticators: readonly CallerAuthenticator[] = Object.freeze([
  rpcProxyAuthenticator(),
  mcpHostAuthenticator(),
])

export function requireActionCheckpointCaller(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authenticator = callerAuthenticators.find(item => item.matches(req))
  if (!authenticator) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  authenticator.authenticate(req, res, () => {
    const identity = authenticator.identity(req)
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.actionCheckpointCaller = identity
    next()
  })
}

import type { NextFunction, Request, Response } from 'express'
import { verifyInternalControlJwt } from '../utils/auth/internalControlToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'
import { requireInternalControlJwt } from './internalControlJwt.js'
import { requireInternalToken } from './internalServiceAuth.js'
import { requireMcpHostJwt } from './mcpHostJwtAuth.js'

export type Pr2RuntimeReadinessWriter =
  | 'external-rest-api'
  | 'rpc-proxy'
  | 'mcp-host'
  | 'workflow-recipes'
  | 'gfs-controller'
  | 'workspace-files-controller'

declare global {
  namespace Express {
    interface Request {
      pr2RuntimeReadinessWriter?: Pr2RuntimeReadinessWriter
    }
  }
}

const STATIC_WRITERS = new Set<Pr2RuntimeReadinessWriter>([
  'external-rest-api',
  'rpc-proxy',
  'gfs-controller',
  'workspace-files-controller',
])

export function requirePr2RuntimeReadinessWriter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const service = String(req.header('x-service-token') || '').trim()
  if (STATIC_WRITERS.has(service as Pr2RuntimeReadinessWriter)) {
    requireInternalToken(req, res, () => {
      if (req.internalService?.name !== service) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      req.pr2RuntimeReadinessWriter = service as Pr2RuntimeReadinessWriter
      next()
    })
    return
  }

  if (service) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const internalControl = verifyInternalControlJwt(extractBearerToken(req))
  if (internalControl?.iss === 'wrc' && internalControl.sub === 'wrc-provisioner') {
    requireInternalControlJwt(req, res, () => {
      req.pr2RuntimeReadinessWriter = 'workflow-recipes'
      next()
    })
    return
  }

  requireMcpHostJwt(req, res, () => {
    if (!req.mcpHostJwt) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.pr2RuntimeReadinessWriter = 'mcp-host'
    next()
  })
}

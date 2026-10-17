import type { NextFunction, Request, Response } from 'express'
import { config } from '../config'
import { type ServiceClaims, requireScope } from './authMiddleware'
import { declaresV2RuntimeAuthority, runtimeEdgeGuard } from './edgeRuntimeAuth'
import type { RuntimeCallerContext } from './types'

const authenticatedV2Search = runtimeEdgeGuard(['rpc-proxy'], ['session.read'])
const authenticatedLegacySearch = requireScope('host:session:read')

/**
 * Session search retains its signed legacy contract while accepting the
 * authenticated user-centric edge. Declared V2 authority is always handled by
 * the strict edge guard; failures cannot fall back to a legacy bearer token.
 */
export function sessionSearchAuthority(req: Request, res: Response, next: NextFunction): void {
  if (declaresV2RuntimeAuthority(req)) {
    authenticatedV2Search(req, res, next)
    return
  }

  authenticatedLegacySearch(req, res, () => {
    const claims = (req as Request & { auth?: ServiceClaims }).auth
    if (!claims?.sub) {
      res.status(401).json({ error: 'Missing authenticated session-search authority' })
      return
    }
    const runtimeCaller: RuntimeCallerContext = {
      caller: 'rpc-proxy',
      hostRef: config.hostName,
      userId: claims.sub,
    }
    ;(req as Request & { runtimeCaller?: RuntimeCallerContext }).runtimeCaller = runtimeCaller
    next()
  })
}

import type { NextFunction, Request, Response } from 'express'
import { HOST_EDGE_RPC_PROXY_ROUTE_SCOPES } from '@clerum/action-context-contracts'
import { declaresV2RuntimeAuthority, runtimeEdgeGuard } from './edgeRuntimeAuth'

const authenticatedV2Search = runtimeEdgeGuard(
  ['rpc-proxy'],
  ['session.read'],
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/sessions/search']
)

/**
 * Session search is a V2-only route, as it is in rpc-proxy: a request that
 * does not declare V2 runtime authority is refused, and a declared V2 request
 * goes through the strict edge guard.
 */
export function sessionSearchAuthority(req: Request, res: Response, next: NextFunction): void {
  if (!declaresV2RuntimeAuthority(req)) {
    res.status(401).json({ error: 'V2 runtime authority required' })
    return
  }
  authenticatedV2Search(req, res, next)
}

import { authorizeActionV2 } from './actionAuthorityV2.js'

export class RouteActionBindingError extends Error {}

function candidateForRequest(req: any): never {
  const path = req.route.path
  if (path === '/rpc/hosts/:hostRef/status') return undefined as never
  if (path === '/rpc/hosts/:hostRef/health') return undefined as never
  throw new RouteActionBindingError('unsupported_route')
}

function bindRouteActionV2(req: any): unknown {
  return candidateForRequest(req)
}

export async function authorizeBoundRequestV2(
  req: any,
  res: any,
  next: () => void
): Promise<void> {
  let bound: unknown
  try {
    bound = bindRouteActionV2(req)
  } catch (error) {
    if (error instanceof RouteActionBindingError) {
      res.status(400).json({ error: 'invalid_binding' })
      return
    }
    res.status(503).json({ error: 'authority_unavailable' })
    return
  }
  await authorizeActionV2(req.userDelegationV2, bound)
  next()
}

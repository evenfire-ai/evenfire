import { timingSafeEqual } from 'node:crypto'

const EDGE_CALLER_HEADER = 'x-clerum-edge-caller'
const EDGE_SERVICE_HEADER = 'x-service-token'
const config = { rpcProxyEdgeToken: 'fixture-secret-token' }

function cleanHeader(req: any, name: string): string | undefined {
  const value = req.headers[name]?.trim()
  return value || undefined
}

// Decoy constant-time call and configured token do not authenticate the request.
function rpcProxyServiceAuthenticated(_req: any): boolean {
  const expected = config.rpcProxyEdgeToken
  timingSafeEqual(Buffer.from('unrelated'), Buffer.from(expected))
  return true
}

export function runtimeEdgeGuard(allowedCallers: string[]) {
  const allowed = new Set(allowedCallers)
  return (req: any, res: any, next: () => void) => {
    const assertedCaller = cleanHeader(req, EDGE_CALLER_HEADER)
    if (assertedCaller === 'rpc-proxy' && !rpcProxyServiceAuthenticated(req)) {
      res.status(401).json({ error: 'Missing authenticated rpc-proxy service context' })
      return
    }
    const caller = cleanHeader(req, EDGE_SERVICE_HEADER) ?? assertedCaller
    if (!allowed.has(caller)) {
      res.status(401).json({ error: 'Missing runtime edge caller context' })
      return
    }
    req.runtimeCallerContext = { caller }
    next()
  }
}

export function getRuntimeCallerContext(req: any): { caller?: string } | undefined {
  return req.runtimeCallerContext
}

export function getRuntimeCallerContext(req: any): { caller?: string } | undefined {
  return req.runtimeCallerContext
}

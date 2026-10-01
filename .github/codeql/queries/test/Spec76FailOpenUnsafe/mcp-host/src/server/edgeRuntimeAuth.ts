import { timingSafeEqual } from 'node:crypto'

const EDGE_CALLER_HEADER = 'x-clerum-edge-caller'
const EDGE_SERVICE_HEADER = 'x-service-token'
const config = { rpcProxyEdgeToken: 'fixture-secret-token' }

function cleanHeader(req: any, name: string): string | undefined {
  const value = req.headers[name]?.trim()
  return value || undefined
}

function rpcProxyServiceAuthenticated(req: any): boolean {
  const expected = config.rpcProxyEdgeToken
  const service = cleanHeader(req, EDGE_SERVICE_HEADER)
  const authorization = cleanHeader(req, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  const token = match?.[1]?.trim() ?? ''
  if (service !== 'rpc-proxy' || token.length < 16 || token.length > 4096) return false
  const actualBytes = Buffer.from(token)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function getRuntimeCallerContext(req: any): { caller?: string } | undefined {
  return req.runtimeCallerContext
}

export function runtimeEdgeGuard(allowedCallers: string[]) {
  const allowed = new Set(allowedCallers)
  return (req: any, res: any, next: () => void) => {
    const assertedCaller = cleanHeader(req, EDGE_CALLER_HEADER)
    if (assertedCaller === 'rpc-proxy' && !rpcProxyServiceAuthenticated(req)) {
      res.status(401).json({ error: 'Missing authenticated rpc-proxy service context' })
      return
    }
    const context = getRuntimeCallerContext(req)
    if (!context || !allowed.has(context.caller)) {
      res.status(401).json({ error: 'Missing runtime edge caller context' })
      return
    }
    req.runtimeCaller = context
    next()
  }
}

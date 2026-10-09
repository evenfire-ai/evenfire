import express, { type NextFunction, type Request, type Response } from 'express'

/**
 * Frozen source-derived protocol fixture from `dacfe7acca3247b3740fb4ba5298505d1e5fa7b6`.
 * Source blobs at that commit: rpc-proxy/src/services/mcpProxyService.ts
 * (73e6a961d26b76171132fdf33aa3fb4ab4ee2b50) and
 * mcp-host/src/server/edgeRuntimeAuth.ts
 * (70cd49c4f1ad358db18bc8ca4cb1fcb2d6cbca5e).
 * Keep this fixture aligned with those actual legacy producer/consumer paths;
 * it is deliberately not the current protocol implementation.
 */
export function legacyRpcProxyHostProducer(input: {
  userId: string
  hostRef: string
  actionContextV2?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': input.hostRef,
  }
  if (input.actionContextV2) {
    headers['x-clerum-edge-action-context'] = input.actionContextV2
  } else {
    headers['x-clerum-edge-user-id'] = input.userId
    headers['x-clerum-edge-access-scope'] = 'user'
  }
  return headers
}

function legacyRuntimeEdgeGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization) {
    res
      .status(401)
      .json({ error: 'Authorization is not accepted on this direct mcp-host runtime route' })
    return
  }
  const caller = req.headers['x-clerum-edge-caller']
  const hostRef = req.headers['x-clerum-edge-host-ref']
  let userId = req.headers['x-clerum-edge-user-id']
  const actionContext = req.headers['x-clerum-edge-action-context']
  if (!userId && typeof actionContext === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(actionContext, 'base64url').toString('utf8')) as {
        version?: unknown
        userId?: unknown
      }
      if (decoded.version === 2 && typeof decoded.userId === 'string') {
        userId = decoded.userId
      }
    } catch {
      // The historical consumer rejects malformed action context below.
    }
  }
  if (caller !== 'rpc-proxy' || typeof hostRef !== 'string' || typeof userId !== 'string') {
    res.status(401).json({ error: 'Missing runtime edge caller context' })
    return
  }
  next()
}

export function legacyMcpHostConsumer() {
  const app = express()
  app.post('/v1/runtime/messages', legacyRuntimeEdgeGuard, (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })
  return app
}

import { NextFunction, Request, Response } from 'express'
import crypto from 'node:crypto'
import { config } from '../config.js'

declare global {
  namespace Express {
    interface Request {
      internalService?: {
        name: string
      }
    }
  }
}

// Reject tokens shorter than this — defense against misconfigured allowlist
// entries with trivially short values.
const MIN_INTERNAL_TOKEN_LENGTH = 16

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

function extractBearerToken(req: Request): string {
  const raw = String(req.header('authorization') || '').trim()
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, '').trim()
  }
  return ''
}

export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const service = String(req.header('x-service-token') || '').trim()
  const token = extractBearerToken(req)
  if (!token || token.length < MIN_INTERNAL_TOKEN_LENGTH || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  if (!service) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  // Cluster-wide bootstrap path for control-plane internal callers
  // such as external-rest-api and rpc-proxy. On match
  // attach `req.internalService` so downstream `requireInternalService(name)`
  // gates can authorize.
  const expected = config.internalServiceTokens[service]
  if (expected && safeEqual(token, expected)) {
    req.internalService = { name: service }
    next()
    return
  }
  res.status(401).json({ error: 'Unauthorized' })
}

export function requireInternalService(expectedServiceName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.internalService?.name !== expectedServiceName) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}

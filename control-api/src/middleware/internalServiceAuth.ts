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

/**
 * Every refusal of these gates carries this header with this value, beside the
 * unchanged `401 {"error":"Unauthorized"}`. It tells a caller that the gate
 * refused the caller's own service credential, not a token the caller relays
 * (rpc-proxy's `controlApiRestService.ts` answers such a Host resolve as an
 * unavailable authority). The value is a fixed constant and names no service,
 * token or reason.
 */
export const INTERNAL_SERVICE_AUTH_REFUSAL_HEADER = 'x-internal-service-auth-refusal'
export const INTERNAL_SERVICE_CREDENTIAL_REJECTED = 'service_credential_rejected'

/** The one writer of a service gate refusal. */
function refuseServiceCredential(res: Response): void {
  res.setHeader(INTERNAL_SERVICE_AUTH_REFUSAL_HEADER, INTERNAL_SERVICE_CREDENTIAL_REJECTED)
  res.status(401).json({ error: 'Unauthorized' })
}

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
    refuseServiceCredential(res)
    return
  }
  if (!service) {
    refuseServiceCredential(res)
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
  refuseServiceCredential(res)
}

export function requireInternalService(expectedServiceName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.internalService?.name !== expectedServiceName) {
      refuseServiceCredential(res)
      return
    }
    next()
  }
}

import type { Request } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * Resolve the client identity asserted by the authenticated external-rest
 * boundary. The service header is only meaningful after the internal-service
 * gate has run; callers that exercise a router directly fall back to
 * Express's proxy-aware address instead of trusting arbitrary text.
 */
export function externalClientIp(req: Request): string {
  const asserted = req.header('x-external-client-ip')?.trim()
  if (asserted && isIP(asserted) !== 0) return asserted
  const forwarded = req.header('x-forwarded-for')?.split(',', 1)[0]?.trim()
  if (forwarded && isIP(forwarded) !== 0) return forwarded
  const fallback = req.ip?.trim() || req.socket.remoteAddress?.trim()
  return fallback && isIP(fallback) !== 0 ? fallback : '__unknown_peer__'
}

/** Stable per-client key for express-rate-limit's pre-auth edge buckets. */
export function externalClientRateLimitKey(req: Request): string {
  const ipKey = ipKeyGenerator(externalClientIp(req))
  const sessionToken = req.header('x-user-session-token')?.trim()
  if (!sessionToken) return `external-client-ip:${ipKey}`
  const sessionKey = createHash('sha256').update(sessionToken).digest('hex').slice(0, 24)
  return `external-client-ip:${ipKey}:session:${sessionKey}`
}

import type { Request, RequestHandler } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
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

/** Stable source-IP key for express-rate-limit's pre-auth edge bucket. */
export function externalClientIpRateLimitKey(req: Request): string {
  const ipKey = ipKeyGenerator(externalClientIp(req))
  return `external-client-ip:${ipKey}`
}

/**
 * Stable per-session key for the second pre-auth edge bucket.
 *
 * The session token is deliberately only an additional dimension: it must not
 * replace the source-IP bucket because it is unverified at this boundary and
 * can be rotated by a caller. Both buckets are applied by the external route
 * families, so token rotation cannot evade the IP ceiling.
 */
export function externalClientSessionRateLimitKey(req: Request): string {
  const ipKey = ipKeyGenerator(externalClientIp(req))
  const sessionToken = req.header('x-user-session-token')?.trim()
  if (!sessionToken) return `external-client-session:${ipKey}:anonymous`
  const sessionKey = createHash('sha256').update(sessionToken).digest('hex').slice(0, 24)
  return `external-client-session:${ipKey}:${sessionKey}`
}

/** Backwards-compatible name for callers/tests of the session dimension. */
export function externalClientRateLimitKey(req: Request): string {
  return externalClientSessionRateLimitKey(req)
}

/**
 * Compose independent source-IP and IP+session pre-auth gates. Keeping both
 * dimensions explicit prevents an unverified token rotation from evading the
 * source-IP ceiling while preserving per-session fairness after the IP gate.
 */
export function createExternalClientRateLimiters(
  bucketType: string,
  ipMaxPerMinute: number,
  sessionMaxPerMinute = ipMaxPerMinute
): [RequestHandler, RequestHandler] {
  const commonOptions = {
    windowMs: 60_000,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
  }
  const sourceIp = rateLimit({
    ...commonOptions,
    limit: ipMaxPerMinute,
    keyGenerator: req => `external-edge:${bucketType}:${externalClientIpRateLimitKey(req)}`,
  })
  const session = rateLimit({
    ...commonOptions,
    limit: sessionMaxPerMinute,
    keyGenerator: req => `external-edge:${bucketType}:${externalClientSessionRateLimitKey(req)}`,
  })
  return [sourceIp, session]
}

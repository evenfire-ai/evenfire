import { rateLimit } from 'express-rate-limit'

/**
 * Protects the HTTP boundary before JWT verification and body parsing.
 *
 * The authenticated, recipe-scoped limiters remain responsible for product
 * quotas. This limiter has a deliberately higher IP ceiling: its only job is
 * to bound unauthenticated crypto/body-parser work and prevent a caller from
 * bypassing the per-principal controls by rotating invalid tokens.
 */
export function createMcpHostPreAuthRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too Many Requests', retryable: true },
  })
}

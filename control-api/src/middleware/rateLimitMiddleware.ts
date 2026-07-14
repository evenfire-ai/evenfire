import { NextFunction, Request, Response } from 'express'
import { rateLimitHitsTotal } from '../observability/metrics.js'
import { checkAndIncrement } from '../services/rateLimiterService.js'

/**
 * Factory for a per-request rate limit middleware backed by a PG token bucket.
 *
 * Usage:
 *   router.post("/foo",
 *     rateLimitMiddleware({
 *       bucketType: "recipe",
 *       maxPerMinute: 10,
 *       getBucketKey: (req) => `recipe:${req.mcpHostJwt!.recipeNamespace}/${req.mcpHostJwt!.recipeName}`,
 *     }),
 *     handler,
 *   );
 *
 * The middleware:
 *   - Returns 429 with `Retry-After` (seconds until window end) when the limit
 *     is exceeded.
 *   - Emits `rate_limit_hits_total{bucket_type, result}` on every call.
 *   - If `getBucketKey` returns `null` (e.g. unable to derive key), the
 *     request is *allowed* but not counted — fail-open. Callers that need
 *     strict enforcement should return a sentinel key instead.
 */
export function rateLimitMiddleware(opts: {
  bucketType: string
  maxPerMinute: number
  getBucketKey: (req: Request) => string | null
}) {
  return function rateLimitMw(req: Request, res: Response, next: NextFunction): void {
    void (async () => {
      try {
        const key = opts.getBucketKey(req)
        if (!key) {
          // Fail-open: no key means we cannot attribute the call (usually a
          // pre-auth path); let it through rather than 500.
          next()
          return
        }

        const result = await checkAndIncrement(key, opts.maxPerMinute)
        if (!result.allowed) {
          rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'denied' }, 1)
          const retryAfterSec = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000))
          res.setHeader('Retry-After', String(retryAfterSec))
          res.setHeader('X-RateLimit-Limit', String(opts.maxPerMinute))
          res.setHeader('X-RateLimit-Remaining', '0')
          res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
          if (req.log) {
            req.log.warn(
              {
                event: 'rate_limit_denied',
                bucketType: opts.bucketType,
                bucketKey: key,
                count: result.count,
                maxPerMinute: opts.maxPerMinute,
              },
              'rate limit exceeded'
            )
          }
          res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds: retryAfterSec })
          return
        }

        rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'allowed' }, 1)
        res.setHeader('X-RateLimit-Limit', String(opts.maxPerMinute))
        res.setHeader('X-RateLimit-Remaining', String(result.remaining))
        res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
        next()
      } catch (err) {
        next(err)
      }
    })()
  }
}

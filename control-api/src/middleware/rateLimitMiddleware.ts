import { NextFunction, Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { LogThrottle } from '../observability/logThrottle.js'
import { rateLimitHitsTotal } from '../observability/metrics.js'
import {
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS,
  checkAndIncrement,
} from '../services/rateLimiterService.js'
import { ProcessMemoryRateLimiter } from './processMemoryRateLimiter.js'

/**
 * Factory for a per-request rate limit middleware backed by a PG token bucket.
 *
 * Usage:
 *   router.post("/foo",
 *     rateLimitMiddleware({
 *       bucketType: "recipe",
 *       maxPerMinute: 10,
 *       getBucketKey: (req) => mcpHostRateLimitBucketKey('recipe', req.mcpHostJwt),
 *       onBackendUnavailable: 'process-memory',
 *     }),
 *     handler,
 *   );
 *
 * The middleware:
 *   - Returns 429 with `Retry-After` (seconds until window end) when the limit
 *     is exceeded.
 *   - Emits `rate_limit_hits_total{bucket_type, result}` on every call, with
 *     `result` one of `allowed`, `denied`, `unavailable`, `fallback_allowed`,
 *     `fallback_denied`.
 *   - If `getBucketKey` returns `null` (e.g. unable to derive key), the
 *     request is *allowed* but not counted — fail-open. Callers that need
 *     strict enforcement should return a sentinel key instead.
 *   - When the limiter backend cannot count the request
 *     (`backendAvailable: false`: the limiter pool is saturated, Postgres
 *     returned an error, or the upsert returned no row), `onBackendUnavailable`
 *     decides. The option is required so every caller states that choice.
 *       - `'closed'` answers 503 `rate_limit_unavailable` with `Retry-After`.
 *       - `'process-memory'` counts the request in this middleware instance's
 *         own in-memory counter: the same `maxPerMinute`, in a 60 s window per
 *         key. Over the limit it answers 429 like a Postgres denial, and the
 *         warn line carries `source: 'process-memory'`. The in-memory counter
 *         is used only for requests Postgres could not count; the two counts
 *         are never added together. It tracks at most 100 000 keys per 60 s;
 *         a new key beyond that answers 503 as `'closed'` does. The counter
 *         lives in one process: control-api runs one replica today, so the
 *         in-memory limit holds for the whole service only while that is
 *         true. With N replicas a caller can get N × `maxPerMinute` requests
 *         per minute while Postgres is unavailable.
 */
export function rateLimitMiddleware(opts: {
  bucketType: string
  maxPerMinute: number
  getBucketKey: (req: Request) => string | null
  onBackendUnavailable: 'process-memory' | 'closed'
}) {
  // While the backend is down every request on this bucket fails the same way,
  // so the warn line is written once per minute; the counter records each one.
  const unavailableLogThrottle = new LogThrottle(60_000)
  const processMemory =
    opts.onBackendUnavailable === 'process-memory'
      ? new ProcessMemoryRateLimiter(opts.maxPerMinute)
      : null

  function answerUnavailable(req: Request, res: Response): void {
    rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'unavailable' }, 1)
    const suppressed = unavailableLogThrottle.admit(opts.bucketType)
    if (req.log && suppressed !== undefined) {
      req.log.warn(
        { event: 'rate_limit_unavailable', bucketType: opts.bucketType, suppressed },
        'rate limit backend unavailable'
      )
    }
    res.setHeader('Retry-After', String(RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS))
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json({
      error: 'rate_limit_unavailable',
      retryAfterSeconds: RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS,
    })
  }

  function answerDenied(
    req: Request,
    res: Response,
    key: string,
    denial: { count: number; resetMs: number; source?: 'process-memory' }
  ): void {
    const retryAfterSec = Math.max(1, Math.ceil((denial.resetMs - Date.now()) / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    res.setHeader('X-RateLimit-Limit', String(opts.maxPerMinute))
    res.setHeader('X-RateLimit-Remaining', '0')
    res.setHeader('X-RateLimit-Reset', String(Math.floor(denial.resetMs / 1000)))
    if (req.log) {
      req.log.warn(
        {
          event: 'rate_limit_denied',
          bucketType: opts.bucketType,
          // Keys carry user ids (e.g. desktopUserId). The SHA-256 is a
          // correlation id, not anonymization: it is unsalted, so a
          // low-entropy key (an IP, an email) can be recovered by guessing.
          hashedKey: createHash('sha256').update(key).digest('hex'),
          count: denial.count,
          maxPerMinute: opts.maxPerMinute,
          ...(denial.source === undefined ? {} : { source: denial.source }),
        },
        'rate limit exceeded'
      )
    }
    res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds: retryAfterSec })
  }

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
        if (!result.backendAvailable) {
          if (processMemory === null) {
            answerUnavailable(req, res)
            return
          }
          const decision = await processMemory.hit(key)
          if (decision.outcome === 'key_cap_reached') {
            answerUnavailable(req, res)
            return
          }
          if (decision.outcome === 'denied') {
            rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'fallback_denied' }, 1)
            answerDenied(req, res, key, {
              count: decision.totalHits,
              resetMs: decision.resetMs,
              source: 'process-memory',
            })
            return
          }
          rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'fallback_allowed' }, 1)
          res.setHeader('X-RateLimit-Limit', String(opts.maxPerMinute))
          res.setHeader('X-RateLimit-Remaining', String(opts.maxPerMinute - decision.totalHits))
          res.setHeader('X-RateLimit-Reset', String(Math.floor(decision.resetMs / 1000)))
          next()
          return
        }
        if (!result.allowed) {
          rateLimitHitsTotal.inc({ bucket_type: opts.bucketType, result: 'denied' }, 1)
          answerDenied(req, res, key, { count: result.count, resetMs: result.resetMs })
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

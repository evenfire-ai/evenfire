import { NextFunction, Request, Response } from 'express'

type Bucket = { count: number; resetAt: number }

function getClientIp(req: Request): string {
  // Express resolves the single trusted proxy hop configured in app.ts. Do
  // not parse an attacker-supplied X-Forwarded-For chain independently here.
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function createRateLimiter(options: {
  windowMs: number
  maxRequests: number
  keyFn?: (req: Request) => string
  errorCode?: string
}) {
  const { windowMs, maxRequests, keyFn = getClientIp, errorCode } = options
  const buckets = new Map<string, Bucket>()

  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }, windowMs).unref()

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = keyFn(req)
    const now = Date.now()
    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    bucket.count++
    if (bucket.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.setHeader('X-RateLimit-Limit', String(maxRequests))
      res.setHeader('X-RateLimit-Remaining', '0')
      res.status(429).json({
        error: errorCode || 'Too many requests. Please try again later.',
        retryAfterSeconds,
      })
      return
    }

    res.setHeader('X-RateLimit-Limit', String(maxRequests))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)))
    next()
  }
}

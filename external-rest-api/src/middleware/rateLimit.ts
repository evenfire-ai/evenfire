import { NextFunction, Request, Response } from 'express'

type Bucket = { count: number; resetAt: number }

function getClientIp(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
  const first = forwarded.split(',')[0]?.trim()
  return first || req.socket.remoteAddress || 'unknown'
}

export function createRateLimiter(options: {
  windowMs: number
  maxRequests: number
  keyFn?: (req: Request) => string
}) {
  const { windowMs, maxRequests, keyFn = getClientIp } = options
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
      res.status(429).json({ error: 'Too many requests. Please try again later.' })
      return
    }

    next()
  }
}

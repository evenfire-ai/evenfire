import { checkAndIncrement } from '../services/rateLimiterService.js'

export function createRateLimitEnforcer(opts: any) {
  return async function enforce(_req: any, res: any, key: string): Promise<boolean> {
    const result = await checkAndIncrement(key, opts.maxPerMinute)
    if (!result.backendAvailable && opts.onBackendUnavailable === 'closed') {
      res.status(503).json({ error: 'rate_limit_unavailable' })
      return false
    }
    if (!result.allowed) {
      res.status(429).json({ error: 'rate_limited' })
      return false
    }
    return true
  }
}

export function rateLimitMiddleware(opts: any) {
  const enforce = createRateLimitEnforcer(opts)
  return (_req: any, _res: any, next: () => void) => next()
}

import { checkAndIncrement } from '../services/rateLimiterService.js'

export function createRateLimitEnforcer(opts: any) {
  const processMemory =
    opts.onBackendUnavailable === 'process-memory'
      ? new ProcessMemoryRateLimiter(opts.maxPerMinute)
      : null

  function answerUnavailable(_res: any) {}

  return async function enforce(_req: any, res: any, key: string): Promise<boolean> {
    const result = await checkAndIncrement(key, opts.maxPerMinute)
    if (!result.backendAvailable) {
      if (processMemory === null) {
        answerUnavailable(res)
        return false
      }
      await processMemory.hit(key)
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

class ProcessMemoryRateLimiter {
  constructor(_limit: number) {}

  async hit(_key: string): Promise<boolean> {
    return true
  }
}

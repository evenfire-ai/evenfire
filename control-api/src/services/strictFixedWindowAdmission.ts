import type { Response } from 'express'
import { type RateLimitCheck, checkAndIncrementStrict } from './rateLimiterService.js'

export type StrictFixedWindowAdmission =
  | { status: 'allowed'; check: RateLimitCheck }
  | { status: 'limited'; check: RateLimitCheck }
  | { status: 'unavailable' }

/**
 * Security-boundary wrapper for the shared fixed-window SQL primitive.
 * The generic primitive intentionally fails open; strict callers must reject
 * missing, malformed, or backend-unavailable results instead.
 */
export async function admitStrictFixedWindow(
  bucketKey: string,
  limit: number,
  checkAndIncrementImpl: typeof checkAndIncrementStrict = checkAndIncrementStrict
): Promise<StrictFixedWindowAdmission> {
  if (!bucketKey || !Number.isSafeInteger(limit) || limit < 1) {
    return { status: 'unavailable' }
  }
  let result: RateLimitCheck
  try {
    result = await checkAndIncrementImpl(bucketKey, limit)
  } catch {
    return { status: 'unavailable' }
  }
  if (
    !result ||
    result.backendAvailable !== true ||
    typeof result.allowed !== 'boolean' ||
    !Number.isSafeInteger(result.count) ||
    result.count < 1 ||
    !Number.isSafeInteger(result.resetMs) ||
    result.allowed !== result.count <= limit
  ) {
    return { status: 'unavailable' }
  }
  return { status: result.allowed ? 'allowed' : 'limited', check: result }
}

export function respondStrictFixedWindowFailure(
  res: Response,
  admission: Exclude<StrictFixedWindowAdmission, { status: 'allowed' }>,
  unavailableError: string,
  limit: number
): void {
  if (admission.status === 'unavailable') {
    res.status(503).json({ error: unavailableError })
    return
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((admission.check.resetMs - Date.now()) / 1000))
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('X-RateLimit-Limit', String(limit))
  res.setHeader('X-RateLimit-Remaining', '0')
  res.setHeader('X-RateLimit-Reset', String(Math.floor(admission.check.resetMs / 1000)))
  res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
}

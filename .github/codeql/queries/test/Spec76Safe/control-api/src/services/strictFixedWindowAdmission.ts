import { type RateLimitCheck, checkAndIncrementStrict } from './rateLimiterService.js'

export type StrictFixedWindowAdmission =
  | { status: 'allowed'; check: RateLimitCheck }
  | { status: 'limited'; check: RateLimitCheck }
  | { status: 'unavailable' }

export async function admitStrictFixedWindow(
  key: string,
  limit: number,
  checkAndIncrementImpl = checkAndIncrementStrict
) {
  let result: RateLimitCheck
  try {
    result = await checkAndIncrementImpl(key, limit)
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
  return result.allowed
    ? { status: 'allowed', check: result }
    : { status: 'limited', check: result }
}

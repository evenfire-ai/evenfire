import { checkAndIncrementStrict } from './rateLimiterService.js'

export async function admitStrictFixedWindow(key: string, limit: number) {
  const result = await checkAndIncrementStrict(key, limit)
  return result.backendAvailable && result.allowed
    ? { status: 'allowed', check: result }
    : { status: result.backendAvailable ? 'limited' : 'unavailable', check: result }
}

import { checkAndIncrementStrict } from './rateLimiterService.js'

export async function admitStrictFixedWindow(
  key: string,
  limit: number,
  checkAndIncrementImpl = checkAndIncrementStrict
) {
  const result = await checkAndIncrementImpl(key, limit)
  return result.allowed
    ? { status: 'allowed', check: result }
    : { status: 'limited', check: result }
}

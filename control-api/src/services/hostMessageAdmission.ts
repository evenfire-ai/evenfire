import type { Response } from 'express'
import { config } from '../config.js'
import { type RateLimitCheck, checkAndIncrement } from './rateLimiterService.js'

export function hostMessageAdmissionBucketKey(verifiedSubject: string): string {
  return `host-message-admission:${verifiedSubject}`
}

export type HostMessageAdmission =
  | { status: 'allowed'; check: RateLimitCheck }
  | { status: 'limited'; check: RateLimitCheck }
  | { status: 'unavailable' }

/** Shared authority for legacy messages and the later v2 chat.message.invoke checkpoint. */
export async function admitHostMessage(
  verifiedSubject: string,
  check: typeof checkAndIncrement = checkAndIncrement
): Promise<HostMessageAdmission> {
  if (!verifiedSubject) return { status: 'unavailable' }
  let result: RateLimitCheck
  try {
    result = await check(hostMessageAdmissionBucketKey(verifiedSubject), config.hostMessageRlPerMin)
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
    result.allowed !== result.count <= config.hostMessageRlPerMin
  ) {
    return { status: 'unavailable' }
  }
  return { status: result.allowed ? 'allowed' : 'limited', check: result }
}

/** The same response contract can be used by the PR2 checkpoint after cascade. */
export function respondHostMessageAdmissionFailure(
  res: Response,
  admission: Exclude<HostMessageAdmission, { status: 'allowed' }>
): void {
  if (admission.status === 'unavailable') {
    res.status(503).json({ error: 'host_message_admission_unavailable' })
    return
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((admission.check.resetMs - Date.now()) / 1000))
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('X-RateLimit-Limit', String(config.hostMessageRlPerMin))
  res.setHeader('X-RateLimit-Remaining', '0')
  res.setHeader('X-RateLimit-Reset', String(Math.floor(admission.check.resetMs / 1000)))
  res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
}

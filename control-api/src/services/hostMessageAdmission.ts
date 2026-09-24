import { config } from '../config.js'
import { type RateLimitCheck, checkAndIncrement } from './rateLimiterService.js'
import {
  type StrictFixedWindowAdmission,
  admitStrictFixedWindow,
  respondStrictFixedWindowFailure,
} from './strictFixedWindowAdmission.js'

export function hostMessageAdmissionBucketKey(verifiedSubject: string): string {
  return `host-message-admission:${verifiedSubject}`
}

export type HostMessageAdmission = StrictFixedWindowAdmission

/** Shared authority for legacy messages and the later v2 chat.message.invoke checkpoint. */
export async function admitHostMessage(
  verifiedSubject: string,
  check: typeof checkAndIncrement = checkAndIncrement
): Promise<HostMessageAdmission> {
  if (!verifiedSubject) return { status: 'unavailable' }
  return admitStrictFixedWindow(
    hostMessageAdmissionBucketKey(verifiedSubject),
    config.hostMessageRlPerMin,
    check
  )
}

/** The same response contract can be used by the PR2 checkpoint after cascade. */
export function respondHostMessageAdmissionFailure(
  res: import('express').Response,
  admission: Exclude<HostMessageAdmission, { status: 'allowed' }>
): void {
  respondStrictFixedWindowFailure(
    res,
    admission,
    'host_message_admission_unavailable',
    config.hostMessageRlPerMin
  )
}

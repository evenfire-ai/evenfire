import { parseHttpStatus } from '@lib/gfsGrantErrors'

export type SignInFailure =
  | { kind: 'invalid_credentials' }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'unavailable' }
  | { kind: 'other' }

const NO_RESPONSE_MARKER = /(?:^|\s)signInTransport=noResponse$/
const RATE_LIMIT_WAIT_MARKER = /(?:^|\s)httpStatus=429 retryAfterSeconds=(\d+)$/

/**
 * Classifies a sign-in failure from the marker AuthClient.passwordLogin writes at the
 * end of the message, because only the message crosses IPC. Every failure of the
 * credential call ends in that marker, so text from a response body can never be in
 * the anchored position. A message without it never crossed the credential call and
 * says nothing about the password.
 */
export function classifySignInFailure(message: string): SignInFailure {
  if (NO_RESPONSE_MARKER.test(message)) return { kind: 'unavailable' }
  const status = parseHttpStatus(message)
  if (status === 401) return { kind: 'invalid_credentials' }
  if (status === 429) {
    const wait = RATE_LIMIT_WAIT_MARKER.exec(message)?.[1]
    return { kind: 'rate_limited', retryAfterSeconds: wait ? Number.parseInt(wait, 10) : null }
  }
  if (status !== null && status >= 500) return { kind: 'unavailable' }
  return { kind: 'other' }
}

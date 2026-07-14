import { createHmac, timingSafeEqual } from 'node:crypto'
import 'server-only'

const CSRF_MAX_AGE_MS = 30 * 60 * 1000
const CSRF_CLOCK_SKEW_MS = 60 * 1000
const CSRF_SECRET =
  process.env.CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET || 'dev-control-ui-public-token-csrf-secret'

function signTokenCsrf(tokenKind: string, signedToken: string, timestampMs: string): string {
  return createHmac('sha256', CSRF_SECRET)
    .update(`${tokenKind}.${timestampMs}.${signedToken}`)
    .digest('base64url')
}

function createControlAdminTokenCsrfToken(tokenKind: string, signedToken: string): string {
  const timestampMs = String(Date.now())
  return `${timestampMs}.${signTokenCsrf(tokenKind, signedToken, timestampMs)}`
}

function verifyControlAdminTokenCsrfToken(
  tokenKind: string,
  signedToken: string,
  csrfToken: string
): boolean {
  const [timestampMs, signature, ...extra] = csrfToken.split('.')
  if (!timestampMs || !signature || extra.length > 0) return false

  const timestamp = Number(timestampMs)
  if (!Number.isSafeInteger(timestamp)) return false

  const now = Date.now()
  if (timestamp > now + CSRF_CLOCK_SKEW_MS) return false
  if (now - timestamp > CSRF_MAX_AGE_MS) return false

  const expected = Buffer.from(signTokenCsrf(tokenKind, signedToken, timestampMs), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createControlAdminPasswordResetCsrfToken(resetToken: string): string {
  return createControlAdminTokenCsrfToken('control-admin-password-reset', resetToken)
}

export function createControlAdminInvitationCsrfToken(invitationToken: string): string {
  return createControlAdminTokenCsrfToken('control-admin-invitation', invitationToken)
}

export function verifyControlAdminPasswordResetCsrfToken(
  resetToken: string,
  csrfToken: string
): boolean {
  return verifyControlAdminTokenCsrfToken('control-admin-password-reset', resetToken, csrfToken)
}

export function verifyControlAdminInvitationCsrfToken(
  invitationToken: string,
  csrfToken: string
): boolean {
  return verifyControlAdminTokenCsrfToken('control-admin-invitation', invitationToken, csrfToken)
}

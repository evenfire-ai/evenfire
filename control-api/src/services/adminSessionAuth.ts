import { verifyAdminToken } from '../utils/auth/adminAuthToken.js'
import type { AdminAuthClaims } from '../utils/auth/adminAuthTypes.js'
import { findAdminById, isAdminTokenRevoked } from './adminAuthService.js'

const MAX_ADMIN_SESSION_TOKEN_LENGTH = 4096

/**
 * Canonical live administrator session decision shared by Control UI middleware
 * and admin workflow route helpers. Account lock (`lockedUntil`) is intentionally
 * out of scope here — it blocks login, not already-issued sessions.
 */
export async function authenticateAdminSession(
  token: string | null | undefined
): Promise<AdminAuthClaims | null> {
  if (!token || token.length > MAX_ADMIN_SESSION_TOKEN_LENGTH) {
    return null
  }

  const claims = verifyAdminToken(token)
  if (!claims) {
    return null
  }

  if (await isAdminTokenRevoked(claims.jti)) {
    return null
  }

  const admin = await findAdminById(claims.sub)
  if (
    !admin ||
    admin.status !== 'active' ||
    Number(claims.sessionVersion ?? 0) !== admin.sessionVersion
  ) {
    return null
  }

  return claims
}

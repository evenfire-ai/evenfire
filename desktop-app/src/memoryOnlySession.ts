export const MEMORY_ONLY_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The token is received directly from the configured authentication API. Its
 * signed `exp` is the authoritative server bound; this local deadline may only
 * shorten it and can never be extended by RPC or team-token refresh.
 */
export function memoryOnlySessionDeadline(token: string, now = Date.now()): number {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) throw new Error('Session token has no valid expiry claim')

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('Session token has no valid expiry claim')
  }

  const exp = (payload as { exp?: unknown } | null)?.exp
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) {
    throw new Error('Session token has no valid expiry claim')
  }

  const serverExpiresAt = exp * 1000
  const localExpiresAt = now + MEMORY_ONLY_SESSION_MAX_AGE_MS
  const deadline = Math.min(serverExpiresAt, localExpiresAt)
  if (!Number.isSafeInteger(deadline) || deadline <= now) {
    throw new Error('Session token is expired')
  }
  return deadline
}

export function isMemoryOnlySessionExpired(deadline: number, now = Date.now()): boolean {
  return !Number.isSafeInteger(deadline) || deadline <= now
}

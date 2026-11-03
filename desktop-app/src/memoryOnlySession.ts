export const MEMORY_ONLY_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type MemoryOnlySessionDeadlines = {
  expiresAt: number
  expiresAtMonotonicMs: number
}

/**
 * The token is received directly from the configured authentication API. Its
 * signed `exp` is the authoritative server bound; this local deadline may only
 * shorten it and can never be extended by RPC or team-token refresh.
 */
export function memoryOnlySessionDeadline(token: string, now = Date.now()): number {
  return memoryOnlySessionDeadlines(token, now, performance.now()).expiresAt
}

/**
 * Capture both clock domains at authentication. The wall deadline keeps the
 * published session-state contract; the monotonic deadline prevents a later
 * wall-clock rollback from extending local authority.
 */
export function memoryOnlySessionDeadlines(
  token: string,
  wallNow = Date.now(),
  monotonicNow = performance.now()
): MemoryOnlySessionDeadlines {
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
  const localExpiresAt = wallNow + MEMORY_ONLY_SESSION_MAX_AGE_MS
  const expiresAt = Math.min(serverExpiresAt, localExpiresAt)
  const expiresAtMonotonicMs = monotonicNow + (expiresAt - wallNow)
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= wallNow ||
    !Number.isFinite(expiresAtMonotonicMs) ||
    expiresAtMonotonicMs <= monotonicNow
  ) {
    throw new Error('Session token is expired')
  }
  return { expiresAt, expiresAtMonotonicMs }
}

export function isMemoryOnlySessionExpired(
  deadline: number,
  now = Date.now(),
  monotonicDeadline?: number,
  monotonicNow = performance.now()
): boolean {
  return (
    !Number.isSafeInteger(deadline) ||
    deadline <= now ||
    (monotonicDeadline !== undefined &&
      (!Number.isFinite(monotonicDeadline) || monotonicDeadline <= monotonicNow))
  )
}

/** Token/team replacement may shorten, but never extend, the original lease. */
export function memoryOnlySessionReplacementDeadline(
  currentDeadline: number,
  token: string,
  now = Date.now()
): number {
  const deadline = Math.min(currentDeadline, memoryOnlySessionDeadline(token, now))
  if (isMemoryOnlySessionExpired(deadline, now)) {
    throw new Error('Temporary session expired. Please sign in again.')
  }
  return deadline
}

/** A replacement may shorten either clock bound but can never extend the lease. */
export function memoryOnlySessionReplacementDeadlines(
  current: MemoryOnlySessionDeadlines,
  token: string,
  wallNow = Date.now(),
  monotonicNow = performance.now()
): MemoryOnlySessionDeadlines {
  const candidate = memoryOnlySessionDeadlines(token, wallNow, monotonicNow)
  const deadlines = {
    expiresAt: Math.min(current.expiresAt, candidate.expiresAt),
    expiresAtMonotonicMs: Math.min(current.expiresAtMonotonicMs, candidate.expiresAtMonotonicMs),
  }
  if (
    isMemoryOnlySessionExpired(
      deadlines.expiresAt,
      wallNow,
      deadlines.expiresAtMonotonicMs,
      monotonicNow
    )
  ) {
    throw new Error('Temporary session expired. Please sign in again.')
  }
  return deadlines
}

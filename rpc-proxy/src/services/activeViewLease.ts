import { type AuthorizedActionV2, authorizeActionV2 } from '../actionAuthorityV2.js'

export const ACTIVE_VIEW_CHECKPOINT_INTERVAL_MS = 10_000
export const ACTIVE_VIEW_MAX_UNCHECKED_MS = 30_000

/**
 * Keeps a single already-authorized v2 view connection within the accepted
 * revocation bound. This is intentionally connection-local: reconnect always
 * arrives with a fresh exact delegation and never recovers authority from this
 * object, a cookie, or another replica.
 */
export function startActiveViewLease(
  initial: AuthorizedActionV2,
  options: {
    onDenied: () => void
    authorize?: typeof authorizeActionV2
    now?: () => number
    setIntervalFn?: typeof setInterval
    clearIntervalFn?: typeof clearInterval
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
  }
): { close: () => void } {
  const authorize = options.authorize ?? authorizeActionV2
  const now = options.now ?? Date.now
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  let current = initial
  let closed = false
  let renewing = false
  let deadline: ReturnType<typeof setTimeout> | undefined

  const close = (): void => {
    if (closed) return
    closed = true
    clearIntervalFn(interval)
    if (deadline) clearTimeoutFn(deadline)
  }

  const deny = (): void => {
    if (closed) return
    close()
    options.onDenied()
  }

  const armDeadline = (): void => {
    if (deadline) clearTimeoutFn(deadline)
    const lastAllowedAt = now()
    deadline = setTimeoutFn(() => {
      // A hung or unavailable checkpoint may never reject. The hard deadline
      // closes the protected connection rather than extending stale authority.
      if (!closed && now() - lastAllowedAt >= ACTIVE_VIEW_MAX_UNCHECKED_MS) deny()
    }, ACTIVE_VIEW_MAX_UNCHECKED_MS)
  }

  const renew = async (): Promise<void> => {
    if (closed || renewing) return
    renewing = true
    try {
      current = await authorize(current.claims, current.bound)
      if (!closed) armDeadline()
    } catch {
      deny()
    } finally {
      renewing = false
    }
  }

  const interval = setIntervalFn(() => {
    void renew()
  }, ACTIVE_VIEW_CHECKPOINT_INTERVAL_MS)
  armDeadline()
  return { close }
}

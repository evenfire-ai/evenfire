const WINDOW_MS = 60_000
const MAX_REQUESTS = 600

export type DirectServiceAdmissionResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

/**
 * Temporary pre-PR3 ceiling for accepted direct trusted service-plane traffic.
 * This is deliberately one bucket per MCP Host runtime instance: neither the
 * caller marker nor route/request data can select another bucket.
 */
export class DirectServiceAdmission {
  private windowStart = -1
  private used = 0

  admit(nowMs = Date.now()): DirectServiceAdmissionResult {
    const currentWindow = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
    if (currentWindow !== this.windowStart) {
      this.windowStart = currentWindow
      this.used = 0
    }

    if (this.used >= MAX_REQUESTS) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((currentWindow + WINDOW_MS - nowMs) / 1000)),
      }
    }

    this.used += 1
    return { allowed: true }
  }
}

export const DIRECT_SERVICE_ADMISSION_LIMIT = MAX_REQUESTS
export const DIRECT_SERVICE_ADMISSION_WINDOW_MS = WINDOW_MS

/**
 * Sliding-window circuit breaker (plan §3.4).
 *
 * Opens when the failure rate exceeds `failureRateThreshold` over the
 * trailing `windowMs` (with at least `minSamples` calls so a single early
 * failure can't trip it). While open, allow() returns false. The circuit
 * resets after `resetMs` without any recorded call.
 */
export class CircuitBreaker {
  private events: Array<{ at: number; ok: boolean }> = []
  private openedAt: number | null = null

  constructor(
    private readonly opts: {
      windowMs?: number
      failureRateThreshold?: number
      minSamples?: number
      resetMs?: number
      now?: () => number
      /** Observability hook (plan §5.3) — invoked on every open/close transition. */
      onStateChange?: (open: boolean) => void
    } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private prune(now: number): void {
    const windowMs = this.opts.windowMs ?? 30_000
    this.events = this.events.filter(e => now - e.at <= windowMs)
  }

  allow(): boolean {
    const now = this.now()
    if (this.openedAt !== null) {
      const resetMs = this.opts.resetMs ?? 60_000
      if (now - this.openedAt >= resetMs) {
        // Half-open: reset state and admit traffic again.
        this.openedAt = null
        this.events = []
        this.opts.onStateChange?.(false)
        return true
      }
      return false
    }
    return true
  }

  record(ok: boolean): void {
    const now = this.now()
    this.events.push({ at: now, ok })
    this.prune(now)
    const minSamples = this.opts.minSamples ?? 4
    if (this.events.length < minSamples) return
    const failures = this.events.filter(e => !e.ok).length
    const rate = failures / this.events.length
    if (rate > (this.opts.failureRateThreshold ?? 0.5)) {
      const wasOpen = this.openedAt !== null
      this.openedAt = now
      if (!wasOpen) this.opts.onStateChange?.(true)
    }
  }

  /**
   * Pure read: returns true when the breaker is open (timed-out failures
   * have not yet triggered the half-open reset). Callers that want to
   * perform a probe call and potentially reset state should call allow().
   */
  isOpen(): boolean {
    if (this.openedAt === null) return false
    return this.now() - this.openedAt < (this.opts.resetMs ?? 60_000)
  }
}

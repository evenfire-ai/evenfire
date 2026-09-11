/**
 * Per-hook circuit breaker (spec §8.6).
 *
 * `RemoteLlmHook` instances are rebuilt per logical request (the hooked LLM port
 * is wrapped per task), so breaker state cannot live on the instance. It lives
 * here, in a registry keyed by hook identity (endpoint+path), so a hook that is
 * down trips ONCE and every subsequent call across tasks short-circuits without
 * re-paying the timeout — "per-hook, not global" (§8.6): one hook tripping never
 * affects another (different key).
 *
 * State machine (closed → open → half-open → …):
 *   - closed:    dial normally; each unavailable result increments `failures`.
 *   - open:      `failures ≥ threshold` set `openUntil = now + cooldownMs`; while
 *                `now < openUntil` the caller short-circuits WITHOUT dialing.
 *   - half-open: once `openUntil` passes, one probe is allowed through; a success
 *                closes the breaker (reset), a failure re-opens it for another
 *                cooldown. Because open calls never dial, `failures` only advances
 *                on real probe results.
 */
export interface BreakerState {
  /** Consecutive unavailable results (probe failures). Reset to 0 on success. */
  failures: number
  /** Epoch ms until which the breaker is open (short-circuit without dialing). */
  openUntil: number
}

export class HookBreakerRegistry {
  private readonly states = new Map<string, BreakerState>()

  private state(key: string): BreakerState {
    let s = this.states.get(key)
    if (!s) {
      s = { failures: 0, openUntil: 0 }
      this.states.set(key, s)
    }
    return s
  }

  /** True while the breaker is open — the caller must short-circuit, not dial. */
  isOpen(key: string, now: number): boolean {
    return now < this.state(key).openUntil
  }

  /** A reachable response closes the breaker (the hook is healthy again). */
  recordSuccess(key: string): void {
    const s = this.state(key)
    s.failures = 0
    s.openUntil = 0
  }

  /**
   * Record an unavailable probe result. Returns true when THIS failure tripped
   * the breaker open (crossed the threshold from a closed/half-open state), so
   * the caller can emit the §8.6 "alert" exactly once per trip.
   */
  recordFailure(key: string, failureThreshold: number, cooldownMs: number, now: number): boolean {
    const s = this.state(key)
    s.failures += 1
    if (s.failures >= failureThreshold && s.openUntil <= now) {
      s.openUntil = now + cooldownMs
      return true
    }
    return false
  }

  /** Test seam: drop all breaker state. */
  reset(): void {
    this.states.clear()
  }
}

/**
 * Process-shared default registry. The hooked LLM port is rebuilt per task, so a
 * shared registry is what makes a trip survive across requests to the same hook.
 */
export const defaultBreakerRegistry = new HookBreakerRegistry()

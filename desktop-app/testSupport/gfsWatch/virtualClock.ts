import type { GfsWatchClock } from '../../src/gfs/watchClient.js'

/** Wall-clock origin of the virtual clock, so an HTTP-date Retry-After has a meaning. */
export const VIRTUAL_EPOCH_MS = Date.UTC(2026, 10, 13, 12, 0, 0)

export type VirtualTimer = { id: number; at: number; ms: number; fn: () => void; pending: boolean }

/**
 * Timers of the watch client run only when a test fires them. A handle is a
 * VirtualTimer, so a test can ask whether a stored handle is pending.
 */
export class VirtualClock implements GfsWatchClock {
  elapsed = 0
  private nextId = 0
  private timers: VirtualTimer[] = []
  /** Every delay armed, in order, for assertions on backoff and Retry-After. */
  armed: Array<{ ms: number; at: number }> = []

  now(): number {
    return VIRTUAL_EPOCH_MS + this.elapsed
  }

  /** The next `setTimeout` throws, to fail a handler in the middle of its transition. */
  failNext = false

  setTimeout(fn: () => void, ms: number): VirtualTimer {
    if (this.failNext) {
      this.failNext = false
      throw new Error('timer unavailable')
    }
    // Node's rule: a non-finite or < 1 delay is 1 ms.
    let d = Number(ms)
    if (!(d >= 1 && d <= 2 ** 31 - 1)) d = 1
    const t: VirtualTimer = { id: ++this.nextId, at: this.elapsed + d, ms: d, fn, pending: true }
    this.timers.push(t)
    this.armed.push({ ms: d, at: this.elapsed })
    return t
  }

  clearTimeout(handle: unknown): void {
    const t = handle as VirtualTimer | null
    if (!t || !t.pending) return
    t.pending = false
    this.timers = this.timers.filter(x => x !== t)
  }

  isPending(handle: unknown): boolean {
    return (
      !!handle &&
      (handle as VirtualTimer).pending === true &&
      this.timers.includes(handle as VirtualTimer)
    )
  }

  pending(): VirtualTimer[] {
    return [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id)
  }

  next(): VirtualTimer | undefined {
    return this.pending()[0]
  }

  /** Moves time to `t` and runs it. */
  fire(t: VirtualTimer): void {
    if (!t.pending) return
    this.elapsed = Math.max(this.elapsed, t.at)
    t.pending = false
    this.timers = this.timers.filter(x => x !== t)
    t.fn()
  }
}

/** Deterministic PRNG for the jitter. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

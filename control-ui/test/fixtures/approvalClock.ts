/**
 * The virtual clock and the seeded random source the approval protocols run
 * on in tests (`__setApprovalClockForTests`, lib/hostApprovalSave.ts).
 *
 * No timer fires until a test advances the clock. So no test waits for a real
 * request timeout or backoff, and a run a test leaves unfinished never wakes
 * in a later test. Shared by the protocol tests (lib/__tests__) and the
 * Approvals tab's off-switch test.
 */
import type { ApprovalClock, ApprovalRandom } from '../../lib/hostApprovalSave'

export type VirtualClock = ApprovalClock & {
  /** Runs every timer due within `ms`, in time order, then moves the time on. */
  advance(ms: number): void
  /** The delay of every timer set, in order. */
  delays: number[]
  /** Timers set and neither run nor cleared. */
  pending(): number
  /** The pending timers, earliest first: the delay each was set with and the time left. */
  timers(): Array<{ delay: number; remaining: number }>
}

export function createVirtualClock(): VirtualClock {
  let now = 0
  let handles = 0
  const timers = new Map<number, { at: number; delay: number; fn: () => void }>()
  const delays: number[] = []
  return {
    delays,
    now: () => now,
    setTimeout(fn, ms) {
      handles += 1
      timers.set(handles, { at: now + ms, delay: ms, fn })
      delays.push(ms)
      return handles
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    timers: () =>
      [...timers.values()]
        .sort((a, b) => a.at - b.at)
        .map(timer => ({ delay: timer.delay, remaining: timer.at - now })),
    advance(ms) {
      const until = now + ms
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined
        for (const timer of timers) {
          if (timer[1].at <= until && (!due || timer[1].at < due[1].at)) due = timer
        }
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
  }
}

/** A seeded linear congruential generator in [0, 1). */
export function seededRandom(seed: number): ApprovalRandom {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

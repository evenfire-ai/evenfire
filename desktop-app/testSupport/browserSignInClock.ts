/**
 * The browser sign-in test clock, apart from `browserSignInHarness.ts`, so a renderer test can
 * drive a real `BrowserSignInAttempts` without building the harness's `AppService`.
 */
import type { BrowserSignInClock, BrowserSignInTimerHandle } from '../src/browserSignIn.js'

type FakeTimer = { id: number; dueMs: number; callback: () => void }

/**
 * The browser sign-in clock for tests (R-2). The wall clock and the timers' schedule are kept
 * apart, as in the main process: the deadline is checked on the wall clock, and its Node timer
 * keeps its own schedule (D12).
 * - `advance(ms, 'wallOnly')` moves the wall clock only, as a clock change or a sleep the timer
 *   did not count would; no timer fires. `ms` may be negative (the clock set back).
 * - `advance(ms, 'timers')` moves the wall clock and the timers' schedule together and fires
 *   each timer that falls due, in due order, with the wall clock at its due time.
 */
export class FakeBrowserSignInClock implements BrowserSignInClock {
  private wallMs: number
  private scheduleMs = 0
  private lastTimerId = 0
  private readonly timers = new Map<number, FakeTimer>()

  constructor(startMs: number = Date.now()) {
    this.wallMs = startMs
  }

  now(): number {
    return this.wallMs
  }

  setTimer(callback: () => void, ms: number): BrowserSignInTimerHandle {
    this.lastTimerId += 1
    const id = this.lastTimerId
    this.timers.set(id, { id, dueMs: this.scheduleMs + Math.max(0, ms), callback })
    // The store only hands the handle back to `clearTimer`; a number stands in for Node's.
    return id as unknown as BrowserSignInTimerHandle
  }

  clearTimer(handle: BrowserSignInTimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }

  /** Timers set and neither fired nor cleared. */
  pendingTimers(): number {
    return this.timers.size
  }

  advance(ms: number, via: 'wallOnly' | 'timers'): void {
    if (!Number.isFinite(ms)) throw new Error(`advance: ${ms} is not a finite number of ms`)
    if (via === 'wallOnly') {
      this.wallMs += ms
      return
    }
    if (ms < 0) throw new Error('advance: the timers schedule cannot go back')
    const targetMs = this.scheduleMs + ms
    for (let due = this.nextDue(targetMs); due; due = this.nextDue(targetMs)) {
      this.wallMs += due.dueMs - this.scheduleMs
      this.scheduleMs = due.dueMs
      this.timers.delete(due.id)
      due.callback()
    }
    this.wallMs += targetMs - this.scheduleMs
    this.scheduleMs = targetMs
  }

  private nextDue(targetMs: number): FakeTimer | undefined {
    let next: FakeTimer | undefined
    for (const timer of this.timers.values()) {
      if (timer.dueMs <= targetMs && (!next || timer.dueMs < next.dueMs)) next = timer
    }
    return next
  }
}

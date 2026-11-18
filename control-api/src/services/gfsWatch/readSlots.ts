import { abortError } from './runtime.js'

/**
 * Reads to gfsc in flight per control-api process, shared by every watch op.
 * gfsc's CPU is the bottleneck of a reopen stampede and its pool queue has no
 * bound of its own; 64 is Little's law at the expected peak (about 2,400
 * reads/s × 25 ms) and equals the key cap of one reopen, so a lone op never
 * waits.
 */
export const READ_SLOTS_PERMITS = 64

const BUCKET_COUNT = 5
const BUCKET_MS = 1_000
const MIN_BACKLOG_MS = 1_000
const MAX_BACKLOG_MS = 30_000

type Waiter = {
  resolve: () => void
  reject: (error: Error) => void
  signal: AbortSignal
  onAbort: () => void
}

export type ReadSlots = {
  readonly free: number
  readonly waiters: number
  /**
   * Keys whose read thunk has not finished yet, by any path, including those
   * the op's parallelism has not started. The caller raises it before running
   * the thunks and lowers it in each thunk's `finally`.
   */
  demand: number
  acquire(signal: AbortSignal): Promise<void>
  release(responded: boolean): void
  backlogMs(): number
}

/**
 * FIFO semaphore of read permits. `now` must be the monotonic clock: the rate
 * buckets are keyed by monotonic second, so a wall-clock jump does not move
 * the backlog estimate.
 */
export function createReadSlots(now: () => number, permits = READ_SLOTS_PERMITS): ReadSlots {
  let free = permits
  const waiters: Waiter[] = []
  // Reads that got a gfsc response, per monotonic second. Fixed memory, and
  // aborted reads are not counted: they would inflate the rate and shrink the
  // retry floor while gfsc is still saturated.
  const buckets = Array.from({ length: BUCKET_COUNT }, () => ({ sec: -Infinity, n: 0 }))

  const slots: ReadSlots = {
    get free() {
      return free
    },
    get waiters() {
      return waiters.length
    },
    demand: 0,

    acquire(signal) {
      // Every branch returns: an aborted signal must neither take a permit nor
      // leave a waiter behind, or two aborted ops can pin `free` at 0 forever.
      if (signal.aborted) return Promise.reject(abortError())
      if (free > 0 && waiters.length === 0) {
        free -= 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const w: Waiter = { resolve, reject, signal, onAbort: () => {} }
        w.onAbort = () => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(abortError())
        }
        waiters.push(w)
        signal.addEventListener('abort', w.onAbort, { once: true })
      })
    },

    /** Only after `acquire` resolved: the permit exists. */
    release(responded) {
      if (responded) {
        const s = Math.floor(now() / BUCKET_MS)
        const b = buckets[s % BUCKET_COUNT]!
        if (b.sec !== s) {
          b.sec = s
          b.n = 0
        }
        b.n += 1
      }
      while (waiters.length > 0) {
        const w = waiters.shift()!
        w.signal.removeEventListener('abort', w.onAbort)
        if (!w.signal.aborted) {
          // The permit passes straight to the next waiter; `free` is unchanged.
          w.resolve()
          return
        }
      }
      free += 1
    },

    /**
     * Retry floor for keys deferred by load: pending demand over the recent
     * response rate, in [1 s, 30 s]. Demand rather than queue length, because
     * most of a stampede sits in thunks the per-op parallelism has not started.
     */
    backlogMs() {
      if (slots.demand === 0) return MIN_BACKLOG_MS
      const s = Math.floor(now() / BUCKET_MS)
      let responded = 0
      for (const b of buckets) if (s - BUCKET_COUNT < b.sec && b.sec <= s) responded += b.n
      const ratePerMs = responded / (BUCKET_COUNT * BUCKET_MS)
      if (ratePerMs === 0) return MAX_BACKLOG_MS
      return Math.min(MAX_BACKLOG_MS, Math.max(MIN_BACKLOG_MS, slots.demand / ratePerMs))
    },
  }
  return slots
}

/** The never-rejecting runner the thunks are awaited through (the runtime's `total`). */
export type TotalRunner = (f: () => Promise<unknown>, label: string) => Promise<unknown>

/**
 * Runs `thunks` at most `n` at a time, in order, each exactly once, and never
 * rejects even if a thunk throws.
 */
export async function runLimited(
  thunks: ReadonlyArray<() => Promise<unknown>>,
  n: number,
  total: TotalRunner
): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < thunks.length) {
      const t = thunks[i]!
      i += 1
      await total(t, 'thunk')
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, () => worker()))
}

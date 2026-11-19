import {
  type TimerHandle,
  type WatchClock,
  asTimerHandle,
} from '../../src/services/gfsWatch/runtime.js'

type Entry = { at: number; f: () => void; every?: number }

export type VirtualWatchClock = WatchClock & {
  /** Fires, in (instant, arm order), every timer due within `ms`; promise jobs are not run. */
  advance(ms: number): void
  /** Like advance, draining promise jobs after each timer fires. */
  advanceAsync(ms: number): Promise<void>
  jumpWall(ms: number): void
  pendingCount(): number
  isPending(handle: TimerHandle | null): boolean
}

/**
 * Monotonic and wall clocks that move only when the test advances them, and
 * independently of each other. A delay above 2^31-1 ms or NaN fires after
 * 1 ms, as Node's setTimeout does.
 */
export function createVirtualWatchClock({
  wall0 = 1_793_940_000_000,
  random = () => 0.5,
}: { wall0?: number; random?: () => number } = {}): VirtualWatchClock {
  let t = 0
  let wallSkew = 0
  let nextId = 1
  const queue = new Map<number, Entry>()
  const handle = (id: number): TimerHandle => asTimerHandle({ id, unref: () => undefined })
  const idOf = (h: TimerHandle | null) => (h as unknown as { id?: number } | null)?.id

  const effective = (ms: number) => (!(ms >= 0) || ms > 2 ** 31 - 1 ? 1 : ms)

  function nextDue(target: number): [number, Entry] | null {
    let best: [number, Entry] | null = null
    for (const [id, e] of queue) {
      if (e.at > target) continue
      if (!best || e.at < best[1].at || (e.at === best[1].at && id < best[0])) best = [id, e]
    }
    return best
  }

  function fireOne(target: number): boolean {
    const due = nextDue(target)
    if (!due) return false
    const [id, e] = due
    t = e.at
    if (e.every !== undefined) e.at = t + e.every
    else queue.delete(id)
    e.f()
    return true
  }

  const clock: VirtualWatchClock = {
    now: () => t,
    wallNow: () => wall0 + t + wallSkew,
    setTimeout(f, ms) {
      const id = nextId++
      queue.set(id, { at: t + effective(Number(ms)), f })
      return handle(id)
    },
    setInterval(f, ms) {
      const id = nextId++
      queue.set(id, { at: t + ms, f, every: ms })
      return handle(id)
    },
    clear(h) {
      const id = idOf(h)
      if (id !== undefined) queue.delete(id)
    },
    random,
    advance(ms) {
      const target = t + ms
      while (fireOne(target));
      t = target
    },
    async advanceAsync(ms) {
      const target = t + ms
      await flushMicrotasks()
      while (fireOne(target)) await flushMicrotasks()
      t = target
      await flushMicrotasks()
    },
    jumpWall(ms) {
      wallSkew += ms
    },
    pendingCount: () => queue.size,
    isPending: h => {
      const id = idOf(h)
      return id !== undefined && queue.has(id)
    },
  }
  return clock
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

/**
 * Real timers with every watch delay divided by `factor` and the monotonic
 * clock multiplied by it, so a 20 s echo threshold elapses in 20/factor real
 * seconds. pg's own timeouts (connect, query) keep their real duration.
 */
export function createScaledWatchClock(factor: number): WatchClock {
  const origin = performance.now()
  return {
    now: () => (performance.now() - origin) * factor,
    wallNow: () => Date.now(),
    setTimeout: (f, ms) => asTimerHandle(setTimeout(f, ms / factor)),
    setInterval: (f, ms) => asTimerHandle(setInterval(f, ms / factor)),
    clear: h => clearTimeout(h as unknown as NodeJS.Timeout),
    random: () => Math.random(),
  }
}

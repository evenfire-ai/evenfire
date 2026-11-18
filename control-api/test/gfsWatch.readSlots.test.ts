import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import {
  READ_SLOTS_PERMITS,
  type ReadSlots,
  createReadSlots,
  runLimited,
} from '../src/services/gfsWatch/readSlots.js'
import { createWatchRuntime } from '../src/services/gfsWatch/runtime.js'
import {
  type VirtualWatchClock,
  createVirtualWatchClock,
  flushMicrotasks,
} from './helpers/gfsWatchClock.js'

// The op that drives the semaphore is the registry's; here each "op" runs the
// read thunk the registry runs for one key: skip if already aborted, wait for
// a permit against the op signal, read, give the permit back in a finally,
// and lower the demand on every path.

type FakeGfsc = {
  inFlight: number
  maxInFlight: number
  reached: number
  read(signal: AbortSignal): Promise<'ok'>
  respondAll(): void
}

/** A gfsc that holds every read until the test answers it. */
function holdingGfsc(): FakeGfsc {
  const held: { resolve: (v: 'ok') => void }[] = []
  const g: FakeGfsc = {
    inFlight: 0,
    maxInFlight: 0,
    reached: 0,
    read(signal) {
      if (signal.aborted)
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      g.reached += 1
      g.inFlight += 1
      g.maxInFlight = Math.max(g.maxInFlight, g.inFlight)
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: (v: 'ok') => {
            g.inFlight -= 1
            resolve(v)
          },
        }
        held.push(entry)
        signal.addEventListener(
          'abort',
          () => {
            const i = held.indexOf(entry)
            if (i >= 0) held.splice(i, 1)
            g.inFlight -= 1
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
    },
    respondAll() {
      for (const e of held.splice(0)) e.resolve('ok')
    },
  }
  return g
}

/** A gfsc that answers one read every 1/rate s of virtual time, FIFO. */
function ratedGfsc(clock: VirtualWatchClock, perSecond: number): FakeGfsc {
  const queue: { resolve: (v: 'ok') => void; signal: AbortSignal }[] = []
  let busy = false
  const g: FakeGfsc = {
    inFlight: 0,
    maxInFlight: 0,
    reached: 0,
    read(signal) {
      if (signal.aborted)
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      g.reached += 1
      g.inFlight += 1
      g.maxInFlight = Math.max(g.maxInFlight, g.inFlight)
      return new Promise((resolve, reject) => {
        queue.push({ resolve, signal })
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        )
        pump()
      })
    },
    respondAll() {},
  }
  function pump() {
    if (busy) return
    busy = true
    clock.setTimeout(() => {
      busy = false
      const next = queue.shift()
      if (next) {
        g.inFlight -= 1
        if (!next.signal.aborted) next.resolve('ok')
      }
      if (queue.length > 0) pump()
    }, 1_000 / perSecond)
  }
  return g
}

function harness(clock: VirtualWatchClock, slots: ReadSlots, gfsc: FakeGfsc) {
  const rt = createWatchRuntime<{ connId: string }>({ clock, closeConnInternal: () => {} })
  function thunk(signal: AbortSignal, outcome: string[]) {
    return async () => {
      try {
        if (signal.aborted) {
          outcome.push('deferred')
          return
        }
        const r = await rt.total(
          async () => {
            await slots.acquire(signal)
            let responded = false
            try {
              await gfsc.read(signal)
              responded = true
              return 'read'
            } finally {
              slots.release(responded)
            }
          },
          'gfsc-read',
          'deferred' as const
        )
        outcome.push(r)
      } finally {
        slots.demand -= 1
      }
    }
  }
  function op(keys: number, { parallelism = 4, abortFirst = false } = {}) {
    const ctl = new AbortController()
    if (abortFirst) ctl.abort()
    const outcome: string[] = []
    slots.demand += keys
    const done = runLimited(
      Array.from({ length: keys }, () => thunk(ctl.signal, outcome)),
      parallelism,
      rt.total
    )
    return { ctl, outcome, done }
  }
  return { rt, op }
}

function expectAtRest(slots: ReadSlots) {
  expect({ free: slots.free, waiters: slots.waiters, demand: slots.demand }).toEqual({
    free: READ_SLOTS_PERMITS,
    waiters: 0,
    demand: 0,
  })
}

describe('T-SB83 readSlots caps reads in flight per process', () => {
  it('4 ops of 64 keys never have more than 64 reads in flight, and rest at free = 64', async () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    const gfsc = holdingGfsc()
    const { op } = harness(clock, slots, gfsc)
    const ops = Array.from({ length: 4 }, () => op(64))
    for (let round = 0; round < 200 && ops.some(o => o.outcome.length < 64); round += 1) {
      await flushMicrotasks()
      expect(64 - slots.free).toBeLessThanOrEqual(64)
      expect(gfsc.inFlight).toBeLessThanOrEqual(64)
      gfsc.respondAll()
    }
    await Promise.all(ops.map(o => o.done))
    expect(gfsc.maxInFlight).toBeLessThanOrEqual(64)
    expect(gfsc.reached).toBe(256)
    expectAtRest(slots)
  })

  it('an op aborted (T_auth or close) with reads queued takes them out of the queue without reaching gfsc', async () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    const gfsc = holdingGfsc()
    const { op } = harness(clock, slots, gfsc)
    const holders = Array.from({ length: 16 }, () => op(4))
    await flushMicrotasks()
    expect(slots.free).toBe(0)
    const late = op(64)
    await flushMicrotasks()
    expect(slots.waiters).toBe(4)
    const reachedBefore = gfsc.reached
    late.ctl.abort()
    await late.done
    expect(gfsc.reached).toBe(reachedBefore)
    expect(late.outcome).toEqual(Array(64).fill('deferred'))
    expect(slots.waiters).toBe(0)
    gfsc.respondAll()
    await Promise.all(holders.map(h => h.done))
    expectAtRest(slots)
  })
})

describe('T-SB84 backlogMs counts demand over the response rate', () => {
  it('a 256 × 64 stampede against a 700/s gfsc gives backlogMs ≥ demand / 700 s⁻¹ within [1 s, 30 s]', async () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    const gfsc = ratedGfsc(clock, 700)
    const { op } = harness(clock, slots, gfsc)
    const ops = Array.from({ length: 256 }, () => op(64))
    for (let i = 0; i < 60; i += 1) await clock.advanceAsync(100)
    const demand = slots.demand
    const backlog = slots.backlogMs()
    expect(demand).toBeGreaterThan(10_000)
    expect(backlog).toBeGreaterThanOrEqual(Math.min(30_000, (demand / 700) * 1_000) - 1)
    expect(backlog).toBeLessThanOrEqual(30_000)
    expect(backlog).toBeGreaterThan(14_000)
    for (const o of ops) o.ctl.abort()
    await clock.advanceAsync(1_000)
    await Promise.all(ops.map(o => o.done))
    expectAtRest(slots)
  })

  it('a replica without demand floors at 1 s, not 30 s', () => {
    const slots = createReadSlots(createVirtualWatchClock().now)
    expect(slots.backlogMs()).toBe(1_000)
  })

  it('demand > 0 with no responded read in the last 5 s gives 30 s', () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    slots.demand = 3
    expect(slots.backlogMs()).toBe(30_000)
    void slots.acquire(new AbortController().signal)
    slots.release(true)
    expect(slots.backlogMs()).toBe(Math.max(1_000, 3 / (1 / 5_000)))
    clock.advance(6_000)
    expect(slots.backlogMs()).toBe(30_000)
  })
})

describe('T-SB85 an aborted acquire ends its path', () => {
  it('with free > 0: rejects, takes no permit and queues nothing', async () => {
    const slots = createReadSlots(createVirtualWatchClock().now)
    const ctl = new AbortController()
    ctl.abort()
    await expect(slots.acquire(ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(slots.free).toBe(64)
    expect(slots.waiters).toBe(0)
  })

  it('with a queue: rejects and leaves free and waiters unchanged', async () => {
    const slots = createReadSlots(createVirtualWatchClock().now)
    const live = new AbortController()
    for (let i = 0; i < 64; i += 1) await slots.acquire(live.signal)
    const queued = slots.acquire(live.signal)
    expect(slots.waiters).toBe(1)
    const ctl = new AbortController()
    ctl.abort()
    await expect(slots.acquire(ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(slots.free).toBe(0)
    expect(slots.waiters).toBe(1)
    slots.release(true)
    await queued
    expect(slots.waiters).toBe(0)
  })

  it('an op of 64 keys aborted before its thunks start reads nothing', async () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    const gfsc = holdingGfsc()
    const { op } = harness(clock, slots, gfsc)
    const o = op(64, { abortFirst: true })
    await o.done
    expect(o.outcome).toEqual(Array(64).fill('deferred'))
    expect(gfsc.reached).toBe(0)
    expectAtRest(slots)
  })

  it('rests at free = 64, waiters = 0, demand = 0 after 1,000 ops with random aborts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            keys: fc.integer({ min: 1, max: 64 }),
            abortAfter: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 40 }
        ),
        async plan => {
          const clock = createVirtualWatchClock()
          const slots = createReadSlots(clock.now)
          const gfsc = holdingGfsc()
          const { op } = harness(clock, slots, gfsc)
          const ops = plan.map(p => ({ ...p, o: op(p.keys) }))
          for (let round = 0; round <= 6; round += 1) {
            await flushMicrotasks()
            for (const p of ops) if (p.abortAfter === round) p.o.ctl.abort()
            if (round % 2 === 1) gfsc.respondAll()
          }
          for (let i = 0; i < 100 && slots.demand > 0; i += 1) {
            gfsc.respondAll()
            await flushMicrotasks()
          }
          await Promise.all(ops.map(p => p.o.done))
          expectAtRest(slots)
        }
      ),
      { numRuns: 25 }
    )
  })
})

describe('T-SB86 runLimited', () => {
  it('runs 64 thunks at most 4 at a time, each exactly once, and never rejects though one throws', async () => {
    const rt = createWatchRuntime<{ connId: string }>({
      clock: createVirtualWatchClock(),
      closeConnInternal: () => {},
    })
    let running = 0
    let peak = 0
    const calls = Array(64).fill(0)
    const thunks = calls.map((_, i) => async () => {
      calls[i] += 1
      running += 1
      peak = Math.max(peak, running)
      await flushMicrotasks(3)
      running -= 1
      if (i % 7 === 0) throw new Error(`thunk ${i}`)
    })
    await expect(runLimited(thunks, 4, rt.total)).resolves.toBeUndefined()
    expect(peak).toBe(4)
    expect(calls).toEqual(Array(64).fill(1))
  })

  it('runs everything when there are fewer thunks than the parallelism, and nothing for none', async () => {
    const rt = createWatchRuntime<{ connId: string }>({
      clock: createVirtualWatchClock(),
      closeConnInternal: () => {},
    })
    const seen: number[] = []
    await runLimited([async () => seen.push(1), async () => seen.push(2)], 4, rt.total)
    await runLimited([], 4, rt.total)
    expect(seen).toEqual([1, 2])
  })
})

/**
 * A full collection, then the live heap. The semaphore keeps its state in a
 * closure (or anywhere else it likes), so the only honest check that it holds
 * nothing per read is the retained heap itself.
 */
function retainedHeapBytes(): number {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

describe('T-SB87 the rate is kept in fixed memory on the monotonic clock', () => {
  it('10 min at 2,400 reads/s keeps 5 buckets; a wall jump does not move backlogMs; aborted reads do not count', async () => {
    const clock = createVirtualWatchClock()
    const slots = createReadSlots(clock.now)
    const signal = new AbortController().signal
    const heapBefore = retainedHeapBytes()
    slots.demand = 24_000
    for (let second = 0; second < 600; second += 1) {
      for (let i = 0; i < 2_400; i += 1) {
        void slots.acquire(signal)
        slots.release(true)
      }
      clock.advance(1_000)
    }
    // Five whole buckets, of which the current second is still empty.
    const before = slots.backlogMs()
    expect(before).toBe(Math.min(30_000, 24_000 / ((4 * 2_400) / 5_000)))
    clock.jumpWall(+86_400_000)
    expect(slots.backlogMs()).toBe(before)
    clock.jumpWall(-2 * 86_400_000)
    expect(slots.backlogMs()).toBe(before)
    for (let i = 0; i < 50_000; i += 1) {
      void slots.acquire(signal)
      slots.release(false)
    }
    expect(slots.backlogMs()).toBe(before)
    expect(slots.free).toBe(64)
    expect(slots.waiters).toBe(0)
    // ~1.5 M reads: any per-read record, even one number each, retains
    // several MB; the five buckets retain nothing measurable.
    expect(retainedHeapBytes() - heapBefore).toBeLessThan(1024 * 1024)
  })
})

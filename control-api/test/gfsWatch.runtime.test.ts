import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseError } from 'pg'
import { gfsWatchTickFailedTotal, gfsWatchTotalFailedTotal } from '../src/observability/metrics.js'
import { FAILED, createWatchRuntime, raceAbort, step } from '../src/services/gfsWatch/runtime.js'
import { createVirtualWatchClock, flushMicrotasks } from './helpers/gfsWatchClock.js'

type Conn = { connId: string }

async function counterValue(
  metric: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
  labels: Record<string, string>
): Promise<number> {
  const { values } = await metric.get()
  return values
    .filter(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x))
    .reduce((a, v) => a + v.value, 0)
}

function silentLog() {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child: () => log }
  return log as unknown as import('../src/observability/logger.js').Logger & {
    error: ReturnType<typeof vi.fn>
  }
}

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)
beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})
afterEach(async () => {
  // Give a leaked rejection the macrotask turn Node needs to report it.
  await new Promise(resolve => setImmediate(resolve))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

function setup() {
  const clock = createVirtualWatchClock()
  const closed: Conn[] = []
  const log = silentLog()
  const rt = createWatchRuntime<Conn>({
    clock,
    log,
    closeConnInternal: conn => closed.push(conn),
  })
  return { clock, closed, log, rt }
}

describe('guarded, guardedTick and bestEffort cover sync throws and async rejections', () => {
  it('guarded closes the connection with internal on a sync throw and on an async rejection', async () => {
    const { rt, closed } = setup()
    const a = { connId: 'a' }
    const b = { connId: 'b' }
    expect(() =>
      rt.guarded(a, () => {
        throw new Error('sync')
      })
    ).not.toThrow()
    rt.guarded(b, async () => {
      await Promise.resolve()
      throw new Error('async')
    })
    await flushMicrotasks()
    expect(closed).toEqual([a, b])
  })

  it('guarded never throws even if the internal close throws', async () => {
    const log = silentLog()
    const rt = createWatchRuntime<Conn>({
      clock: createVirtualWatchClock(),
      log,
      closeConnInternal: () => {
        throw new Error('close broke')
      },
    })
    expect(() => rt.guarded({ connId: 'x' }, () => Promise.reject(new Error('r')))).not.toThrow()
    await flushMicrotasks()
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('guardedTick logs and counts a sync throw and an async rejection, and never propagates', async () => {
    const { rt } = setup()
    const before = await counterValue(gfsWatchTickFailedTotal, { name: 'unit-tick' })
    rt.guardedTick('unit-tick', () => {
      throw new Error('sync')
    })
    rt.guardedTick('unit-tick', async () => {
      await Promise.resolve()
      throw new Error('async')
    })
    await flushMicrotasks()
    expect(await counterValue(gfsWatchTickFailedTotal, { name: 'unit-tick' })).toBe(before + 2)
  })

  it('bestEffort swallows sync throws and async rejections', async () => {
    const { rt, log } = setup()
    rt.bestEffort(() => {
      throw new Error('sync')
    })
    rt.bestEffort(() => Promise.reject(new Error('async')))
    await flushMicrotasks()
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('a timer armed as () => guardedTick(name, f) does not run f when armed', () => {
    const { rt, clock } = setup()
    const f = vi.fn()
    rt.timer(1_000, () => rt.guardedTick('arm-form', f))
    expect(f).not.toHaveBeenCalled()
    clock.advance(1_000)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('timer, timerAt, interval and cancel', () => {
  it('timerAt takes an instant and fires at it, not at the instant read as a delay', () => {
    const { rt, clock } = setup()
    clock.advance(1_000_000)
    const f = vi.fn()
    rt.timerAt(clock.now() + 5_000, f)
    clock.advance(4_999)
    expect(f).not.toHaveBeenCalled()
    clock.advance(1)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('timerAt with an instant in the past fires at the next turn', () => {
    const { rt, clock } = setup()
    clock.advance(1_000)
    const f = vi.fn()
    rt.timerAt(10, f)
    clock.advance(0)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('cancel clears every named handle and sets it to null, in order; a null handle is a no-op', () => {
    const { rt, clock } = setup()
    const f = vi.fn()
    const holder = {
      a: rt.timer(100, f),
      b: rt.interval(100, f),
      c: null as ReturnType<typeof rt.timer> | null,
    }
    rt.cancel(holder, 'a', 'b', 'c')
    expect(holder).toEqual({ a: null, b: null, c: null })
    expect(clock.pendingCount()).toBe(0)
    clock.advance(1_000)
    expect(f).not.toHaveBeenCalled()
  })

  it.each([
    ['NaN', Number.NaN, 1],
    ['Infinity', Number.POSITIVE_INFINITY, 1],
    ['-Infinity', Number.NEGATIVE_INFINITY, 1],
    ['2^31', 2 ** 31, 0],
  ])('a %s delay fires at the largest delay Node honours, not after 1 ms', (_, ms, errors) => {
    const { rt, clock, log } = setup()
    const f = vi.fn()
    rt.timer(ms, f)
    clock.advance(2 ** 31 - 2)
    expect(f).not.toHaveBeenCalled()
    clock.advance(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledTimes(errors)
  })

  it('timerAt with an instant beyond the largest delay fires late, not after 1 ms', () => {
    const { rt, clock } = setup()
    const f = vi.fn()
    rt.timerAt(clock.now() + 30 * 24 * 3_600_000, f)
    clock.advance(1_000)
    expect(f).not.toHaveBeenCalled()
  })

  it('interval fires repeatedly', () => {
    const { rt, clock } = setup()
    const f = vi.fn()
    rt.interval(10_000, f)
    clock.advance(30_000)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('jitter is additive, within [x, 1.2x]', () => {
    const lo = createWatchRuntime<Conn>({
      clock: createVirtualWatchClock({ random: () => 0 }),
      closeConnInternal: () => {},
    })
    const hi = createWatchRuntime<Conn>({
      clock: createVirtualWatchClock({ random: () => 0.999999 }),
      closeConnInternal: () => {},
    })
    expect(lo.jitter(8_000)).toBe(8_000)
    expect(hi.jitter(8_000)).toBeLessThan(9_600)
    expect(hi.jitter(8_000)).toBeGreaterThan(9_599)
  })

  it('now is the monotonic clock and wallNow the wall clock, independently', () => {
    const { rt, clock } = setup()
    const wall = rt.wallNow()
    clock.jumpWall(-3_600_000)
    expect(rt.now()).toBe(0)
    expect(rt.wallNow()).toBe(wall - 3_600_000)
  })
})

describe('total', () => {
  it('returns the value, or FAILED (or the given typed failure) without rejecting', async () => {
    const { rt } = setup()
    expect(await rt.total(async () => 7, 'unit')).toBe(7)
    expect(await rt.total(() => Promise.reject(new Error('x')), 'unit')).toBe(FAILED)
    expect(
      await rt.total(() => {
        throw new Error('sync')
      }, 'unit')
    ).toBe(FAILED)
    const transient = { status: 'transitorio' }
    expect(await rt.total(() => Promise.reject(new Error('x')), 'unit', transient)).toBe(transient)
  })

  it('classifies a transport failure as transient and a TypeError as a defect, and logs only the defect', async () => {
    const { rt, log } = setup()
    const transientBefore = await counterValue(gfsWatchTotalFailedTotal, {
      label: 'unit-classify',
      kind: 'transient',
    })
    const defectBefore = await counterValue(gfsWatchTotalFailedTotal, {
      label: 'unit-classify',
      kind: 'defect',
    })
    const pgDown = new DatabaseError('terminating connection', 0, 'error')
    pgDown.code = '57P01'
    await rt.total(() => Promise.reject(pgDown), 'unit-classify')
    await rt.total(() => Promise.reject(new Error('Query read timeout')), 'unit-classify')
    expect(log.error).not.toHaveBeenCalled()
    await rt.total(() => Promise.reject(new TypeError('x is not a function')), 'unit-classify')
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(
      await counterValue(gfsWatchTotalFailedTotal, { label: 'unit-classify', kind: 'transient' })
    ).toBe(transientBefore + 2)
    expect(
      await counterValue(gfsWatchTotalFailedTotal, { label: 'unit-classify', kind: 'defect' })
    ).toBe(defectBefore + 1)
  })

  it('samples defect logs to one every 10 s per label, carrying the suppressed count', async () => {
    const { rt, log, clock } = setup()
    for (let i = 0; i < 5; i += 1)
      await rt.total(() => Promise.reject(new TypeError('d')), 'sampled')
    expect(log.error).toHaveBeenCalledTimes(1)
    await rt.total(() => Promise.reject(new TypeError('d')), 'other-label')
    expect(log.error).toHaveBeenCalledTimes(2)
    clock.advance(10_000)
    await rt.total(() => Promise.reject(new TypeError('d')), 'sampled')
    expect(log.error).toHaveBeenCalledTimes(3)
    expect(log.error.mock.calls[2]![0]).toMatchObject({ label: 'sampled', suppressed: 4 })
  })
})

describe('raceAbort and step', () => {
  it('rejects with AbortError when the signal is already aborted, and the loser stays handled', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const loser = Promise.reject(new Error('late loser'))
    await expect(raceAbort(loser, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects with AbortError on a later abort; the pending promise rejecting afterwards is handled', async () => {
    const ctl = new AbortController()
    let rejectLater!: (e: Error) => void
    const p = new Promise((_, reject) => (rejectLater = reject))
    const raced = raceAbort(p, ctl.signal)
    ctl.abort()
    await expect(raced).rejects.toMatchObject({ name: 'AbortError' })
    rejectLater(new Error('after abort'))
  })

  it('settles like the promise and removes its abort listener', async () => {
    const ctl = new AbortController()
    const add = vi.spyOn(ctl.signal, 'addEventListener')
    const remove = vi.spyOn(ctl.signal, 'removeEventListener')
    expect(await raceAbort(Promise.resolve(3), ctl.signal)).toBe(3)
    await expect(raceAbort(Promise.reject(new Error('e')), ctl.signal)).rejects.toThrow('e')
    expect(add).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('step never rejects: ok, aborted or error', async () => {
    const ctl = new AbortController()
    expect(await step(Promise.resolve(1), ctl.signal)).toEqual({ ok: true, value: 1 })
    const err = new Error('boom')
    expect(await step(Promise.reject(err), ctl.signal)).toEqual({ error: err })
    const pending = step(new Promise(() => {}), ctl.signal)
    ctl.abort()
    expect(await pending).toEqual({ aborted: true })
  })
})

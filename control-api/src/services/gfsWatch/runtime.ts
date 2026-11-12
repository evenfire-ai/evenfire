import { type Logger, rootLogger } from '../../observability/logger.js'
import { gfsWatchTickFailedTotal, gfsWatchTotalFailedTotal } from '../../observability/metrics.js'
import { isTransientInfraError } from './transientInfraError.js'

declare const timerHandleBrand: unique symbol

/**
 * Opaque handle of an armed timer or interval. The brand keeps `cancel` from
 * accepting a field that merely holds some object (a client, an op).
 */
export type TimerHandle = { readonly [timerHandleBrand]: true; unref?: () => unknown }

/** Marks a clock's native handle as a TimerHandle; only clock implementations call it. */
export function asTimerHandle(native: object): TimerHandle {
  return native as TimerHandle
}

/**
 * Time source of the watch. `now` is monotonic and drives every delay and
 * deadline of the registry; `wallNow` is only for values another layer
 * expresses in wall-clock time (a JWT `exp`, a limiter's reset instant), so a
 * wall-clock jump never moves a watch deadline.
 */
export interface WatchClock {
  now(): number
  wallNow(): number
  setTimeout(f: () => void, ms: number): TimerHandle
  setInterval(f: () => void, ms: number): TimerHandle
  clear(handle: TimerHandle): void
  random(): number
}

export const systemWatchClock: WatchClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (f, ms) => asTimerHandle(setTimeout(f, ms)),
  setInterval: (f, ms) => asTimerHandle(setInterval(f, ms)),
  // Node's clearTimeout also clears intervals.
  clear: handle => clearTimeout(handle as unknown as NodeJS.Timeout),
  random: () => Math.random(),
}

/** Returned by `total` when the awaited step failed. */
export const FAILED: unique symbol = Symbol('gfs-watch-failed')
export type Failed = typeof FAILED

export type StepResult<T> =
  | { ok: true; value: T }
  | { ok?: undefined; aborted: true }
  | { ok?: undefined; aborted?: undefined; error: unknown }

export function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
}

const noop = (): void => {}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Rejects as soon as `signal` aborts, otherwise settles like `p`. The loser
 * never becomes an unhandled rejection, and the abort listener is removed
 * when `p` settles first: a connection's signal outlives many awaits.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(noop)
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** Awaits `p` against `signal` and never rejects. */
export async function step<T>(p: Promise<T>, signal: AbortSignal): Promise<StepResult<T>> {
  try {
    return { ok: true, value: await raceAbort(p, signal) }
  } catch (error) {
    return signal.aborted ? { aborted: true } : { error }
  }
}

const SAMPLED_LOG_INTERVAL_MS = 10_000

type HandleKey<H> = {
  [K in keyof H]-?: H[K] extends TimerHandle | null ? K : never
}[keyof H]

export type GuardedConn = { readonly connId: string }

export type WatchRuntimeDeps<C extends GuardedConn> = {
  /**
   * Closes a connection with `internal` after one of its entry points threw.
   * Called from `guarded`; it must not throw.
   */
  closeConnInternal: (conn: C) => void
  clock?: WatchClock
  log?: Logger
}

export type WatchRuntime<C extends GuardedConn> = ReturnType<typeof createWatchRuntime<C>>

/**
 * Process primitives of the GFS watch. Every entry point that runs outside an
 * already protected await chain (NOTIFY dispatch, timer callbacks, library
 * events) goes through `guarded` or `guardedTick`, and every awaited step that
 * may reject goes through `total` or `step`: there is no process-level
 * `unhandledRejection`/`uncaughtException` handler, so one escaped error would
 * take the replica down with every stream it holds.
 */
export function createWatchRuntime<C extends GuardedConn>(deps: WatchRuntimeDeps<C>) {
  const clock = deps.clock ?? systemWatchClock
  const log = deps.log ?? rootLogger.child({ module: 'gfs-watch' })
  const sampled = new Map<string, { lastAt: number; suppressed: number }>()

  const now = (): number => clock.now()
  const wallNow = (): number => clock.wallNow()

  /** `ms` is always a delay. An instant goes through `timerAt`. */
  function timer(ms: number, f: () => void): TimerHandle {
    return clock.setTimeout(f, ms)
  }

  /**
   * Node clamps a delay above 2^31-1 ms to 1 ms, so passing a monotonic
   * instant to `timer` would fire almost immediately.
   */
  function timerAt(at: number, f: () => void): TimerHandle {
    return timer(Math.max(0, at - now()), f)
  }

  function interval(ms: number, f: () => void): TimerHandle {
    return clock.setInterval(f, ms)
  }

  /**
   * Clears each named handle field and sets it to null, in order. It takes the
   * holder and the field rather than the value, so a cancelled handle can never
   * be left non-null and make "arm unless armed" false forever.
   */
  function cancel<H extends object>(holder: H, ...keys: HandleKey<H>[]): void {
    const fields = holder as Record<HandleKey<H>, TimerHandle | null>
    for (const key of keys) {
      const handle = fields[key]
      if (handle !== null && handle !== undefined) clock.clear(handle)
      fields[key] = null
    }
  }

  /** Additive 0-20 %: never fires before the delay it was given. */
  function jitter(ms: number): number {
    return ms + clock.random() * 0.2 * ms
  }

  /** One log line per key every ten seconds, carrying how many were suppressed. */
  function logSampledError(key: string, obj: Record<string, unknown>, msg: string): void {
    const t = now()
    const entry = sampled.get(key)
    if (entry && t - entry.lastAt < SAMPLED_LOG_INTERVAL_MS) {
      entry.suppressed += 1
      return
    }
    log.error({ ...obj, suppressed: entry?.suppressed ?? 0 }, msg)
    sampled.set(key, { lastAt: t, suppressed: 0 })
  }

  /**
   * Runs an entry point that mutates `conn`. A synchronous throw or a rejection
   * of the returned promise closes that connection with `internal`; nothing
   * propagates. There is no synchronous-only variant to pick by mistake.
   */
  function guarded(conn: C, f: () => unknown): void {
    const onErr = (err: unknown) => {
      log.error({ err, connId: conn.connId }, 'gfs watch connection entry point failed')
      try {
        deps.closeConnInternal(conn)
      } catch (closeErr) {
        log.error({ err: closeErr, connId: conn.connId }, 'gfs watch internal close failed')
      }
    }
    try {
      const r = f()
      if (isThenable(r)) r.then(noop, onErr)
    } catch (err) {
      onErr(err)
    }
  }

  /** Runs a process-level entry point: a failure is logged and counted, never propagated. */
  function guardedTick(name: string, f: () => unknown): void {
    const onErr = (err: unknown) => {
      log.error({ err, tick: name }, 'gfs watch tick failed')
      gfsWatchTickFailedTotal.inc({ name })
    }
    try {
      const r = f()
      if (isThenable(r)) r.then(noop, onErr)
    } catch (err) {
      onErr(err)
    }
  }

  /** Runs a side effect whose failure must not stop the caller (close paths). */
  function bestEffort(f: () => unknown): void {
    const onErr = (err: unknown) => log.error({ err }, 'gfs watch close effect failed')
    try {
      const r = f()
      if (isThenable(r)) r.then(noop, onErr)
    } catch (err) {
      onErr(err)
    }
  }

  function recordFailure(err: unknown, label: string): void {
    const kind = isTransientInfraError(err) ? 'transient' : 'defect'
    gfsWatchTotalFailedTotal.inc({ label, kind })
    if (kind === 'defect') {
      logSampledError(`total:${label}`, { err, label }, 'gfs watch total caught a defect')
    }
  }

  /**
   * Awaits `f` and never rejects: a failure is classified (transient
   * infrastructure vs defect), counted and returned as `failed` (FAILED unless
   * the caller has a typed transient value, as a gfsc read does).
   */
  async function total<T, F = Failed>(
    f: () => T | Promise<T>,
    label: string,
    failed: F = FAILED as F
  ): Promise<T | F> {
    try {
      return await f()
    } catch (err) {
      recordFailure(err, label)
      return failed
    }
  }

  return {
    clock,
    log,
    now,
    wallNow,
    timer,
    timerAt,
    interval,
    cancel,
    jitter,
    guarded,
    guardedTick,
    bestEffort,
    total,
    logSampledError,
    raceAbort,
    step,
  }
}

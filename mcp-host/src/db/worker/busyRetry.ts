/**
 * Custom retry loop for `SQLITE_BUSY`. `busy_timeout=0` (see pragmas.ts) keeps
 * SQLite from queuing the convoy itself, so we add jitter at the application
 * layer.
 *
 * B4 fix — was previously synchronous with a `while (Date.now() < target)`
 * busy-spin between attempts, pinning the worker thread CPU for up to
 * ~290ms total. Now async with `await setTimeout`: the worker yields
 * during the wait so other queued messages (and the heartbeat timer) make
 * progress. Concurrency stays correct because `better-sqlite3` is sync —
 * the actual `tx.immediate()` cannot interleave with another op; only the
 * inter-retry wait yields.
 */

const BASE_DELAYS_MS = [20, 40, 80, 150]

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export interface BusyRetryResult<T> {
  result: T
  attempts: number
}

export async function withBusyRetry<T>(fn: () => T): Promise<T> {
  return (await withBusyRetryDetailed(fn)).result
}

export async function withBusyRetryDetailed<T>(fn: () => T): Promise<BusyRetryResult<T>> {
  for (let attempt = 0; attempt <= BASE_DELAYS_MS.length; attempt++) {
    try {
      return { result: fn(), attempts: attempt + 1 }
    } catch (err) {
      const code = (err as { code?: string }).code
      const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT'
      if (!busy || attempt === BASE_DELAYS_MS.length) {
        throw err
      }
      const base = BASE_DELAYS_MS[attempt]
      const jitter = Math.random() * base * 0.5
      await sleep(base + jitter)
    }
  }
  throw new Error('withBusyRetry: unreachable')
}

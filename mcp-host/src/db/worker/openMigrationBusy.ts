/**
 * Boot retry for opening the conversation database and applying migrations.
 *
 * `busy_timeout` is 0 and `withBusyRetry` covers only later session writes
 * (about 290ms). A second pod can hold the write lock for the termination
 * grace, so open and migration share one budget: 30000 ms from the first
 * `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT`. Any other error fails immediately.
 * The wait blocks this worker, which has not accepted messages yet. Session
 * writes stay on the async retry and the 2s sync timeout.
 */

export const OPEN_MIGRATION_BUSY_BUDGET_MS = 30_000

const OPEN_MIGRATION_BUSY_BACKOFF_MS = 1_000

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'])

function sleepBlocking(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function isOpenMigrationBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && BUSY_CODES.has(code)
}

export interface OpenMigrationBusyOptions {
  budgetMs?: number
  backoffMs?: number
  now?: () => number
  sleep?: (ms: number) => void
}

export function createOpenMigrationBusyRetry(
  options: OpenMigrationBusyOptions = {}
): <T>(fn: () => T) => T {
  const budgetMs = options.budgetMs ?? OPEN_MIGRATION_BUSY_BUDGET_MS
  const backoffMs = options.backoffMs ?? OPEN_MIGRATION_BUSY_BACKOFF_MS
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error('open migration busy budget must be a non-negative finite number')
  }
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) {
    throw new Error('open migration busy backoff must be a positive finite number')
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? sleepBlocking
  let firstFailureAt: number | undefined
  let lastError: unknown

  return function retry<T>(fn: () => T): T {
    for (;;) {
      if (firstFailureAt !== undefined && now() - firstFailureAt >= budgetMs) {
        throw lastError
      }
      try {
        return fn()
      } catch (error) {
        if (!isOpenMigrationBusy(error)) throw error
        const failedAt = now()
        if (firstFailureAt === undefined) firstFailureAt = failedAt
        const elapsed = failedAt - firstFailureAt
        if (elapsed >= budgetMs) throw error
        const delay = Math.min(backoffMs, budgetMs - elapsed)
        if (delay <= 0) throw error
        lastError = error
        sleep(delay)
      }
    }
  }
}

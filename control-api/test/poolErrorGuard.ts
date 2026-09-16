/**
 * Guard for real-Postgres suite pools: absorbs ONLY the expected teardown
 * `57P01 terminating connection due to administrator command` FATAL while
 * keeping every other pool error observable.
 *
 * Background: `afterAll` teardown runs `pg_terminate_backend` before
 * `DROP DATABASE`, and a pooled client that is still mid-shutdown surfaces a
 * 57P01 FATAL on the pool object. With no pool `error` listener Node rethrows
 * it as an uncaught exception and the lane fails even though every test
 * passed. A blanket `pool.on('error', () => {})` fixes that but creates a
 * false-green risk: an unexpected connection failure during the test phase
 * would be swallowed while assertions continue. This guard suppresses 57P01
 * only after `beginTeardown()` and records everything else so the suite can
 * fail loudly (`assertNoUnexpectedErrors()` throws the first recorded error,
 * which in an `afterAll` hook fails the whole file).
 */
export type PostgresPoolErrorGuard = {
  /** Attach as the pool's `error` listener. */
  onPoolError: (error: unknown) => void
  /** Marks the point after which 57P01 terminations are expected. */
  beginTeardown: () => void
  /**
   * Throws the first unexpected pool error, if any. Call at the start of
   * `afterAll` (covers the test phase) and again after teardown (covers
   * non-57P01 errors during shutdown).
   */
  assertNoUnexpectedErrors: () => void
}

const TERMINATED_CONNECTION_CODE = '57P01'

function isExpectedTeardownError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === TERMINATED_CONNECTION_CODE
  )
}

export function createPostgresPoolErrorGuard(): PostgresPoolErrorGuard {
  let teardownStarted = false
  let firstUnexpectedError: unknown
  let sawUnexpectedError = false
  return {
    onPoolError(error) {
      if (teardownStarted && isExpectedTeardownError(error)) return
      if (!sawUnexpectedError) {
        sawUnexpectedError = true
        firstUnexpectedError = error
      }
    },
    beginTeardown() {
      teardownStarted = true
    },
    assertNoUnexpectedErrors() {
      if (sawUnexpectedError) throw firstUnexpectedError
    },
  }
}

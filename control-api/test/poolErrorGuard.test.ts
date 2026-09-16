import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPostgresPoolErrorGuard } from './poolErrorGuard.js'

/**
 * R4-M1 coverage: the real-Postgres suites must absorb ONLY the expected
 * teardown 57P01 termination and stay loud about everything else. These tests
 * prove both sides of `createPostgresPoolErrorGuard`'s contract — the exact
 * mechanism `services.pluginWorkloadSdkFinalization` wires into its pool:
 *
 *   dbPool.on('error', error => poolErrorGuard.onPoolError(error))
 *
 * and fails the lane with in `afterAll` via `assertNoUnexpectedErrors()`.
 */
function pgError(code: string, message = 'synthetic pg error'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('createPostgresPoolErrorGuard', () => {
  it('absorbs the expected teardown 57P01 so the lane stays clean', () => {
    const guard = createPostgresPoolErrorGuard()
    guard.beginTeardown()
    expect(() =>
      guard.onPoolError(pgError('57P01', 'terminating connection due to administrator command'))
    ).not.toThrow()
    // The whole point: the afterAll assertion still passes.
    expect(() => guard.assertNoUnexpectedErrors()).not.toThrow()
  })

  it('records a non-57P01 pool error during the test phase and fails the lane', () => {
    const guard = createPostgresPoolErrorGuard()
    const econnreset = pgError('ECONNRESET', 'read ECONNRESET')
    guard.onPoolError(econnreset)
    // afterAll runs assertNoUnexpectedErrors() BEFORE teardown: the recorded
    // error is rethrown there, failing the file (and the lane) instead of
    // being swallowed by a blanket `pool.on('error', () => {})`.
    expect(() => guard.assertNoUnexpectedErrors()).toThrow(econnreset)
  })

  it('records 57P01 that arrives OUTSIDE the teardown window', () => {
    // A termination before beginTeardown() is not the expected race; it must
    // not be silently absorbed either.
    const guard = createPostgresPoolErrorGuard()
    guard.onPoolError(pgError('57P01', 'terminating connection due to administrator command'))
    expect(() => guard.assertNoUnexpectedErrors()).toThrow('administrator command')
  })

  it('records non-57P01 errors that arrive DURING teardown', () => {
    const guard = createPostgresPoolErrorGuard()
    guard.beginTeardown()
    guard.onPoolError(pgError('57P01', 'terminating connection due to administrator command'))
    guard.onPoolError(pgError('ECONNRESET', 'read ECONNRESET during teardown'))
    expect(() => guard.assertNoUnexpectedErrors()).toThrow('ECONNRESET during teardown')
  })

  it('keeps the first unexpected error for diagnosis', () => {
    const guard = createPostgresPoolErrorGuard()
    const first = pgError('ECONNREFUSED', 'connect ECONNREFUSED')
    guard.onPoolError(first)
    guard.onPoolError(pgError('ETIMEDOUT'))
    expect(() => guard.assertNoUnexpectedErrors()).toThrow(first)
  })

  it('is wired correctly as a real pg Pool error listener', () => {
    // Same wiring as the finalization suite: errors emitted by the pool
    // object (pg re-emits idle-client errors there) must reach the guard.
    const guard = createPostgresPoolErrorGuard()
    const pool = new Pool({ connectionString: 'postgresql://postgres@127.0.0.1:1/nope' })
    pool.on('error', error => guard.onPoolError(error))
    try {
      pool.emit('error', pgError('ECONNRESET', 'read ECONNRESET'))
      expect(() => guard.assertNoUnexpectedErrors()).toThrow('read ECONNRESET')
    } finally {
      void pool.end().catch(() => undefined)
    }
  })
})

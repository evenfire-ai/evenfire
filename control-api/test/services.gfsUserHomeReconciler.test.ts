import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { GfsUserHomeReconciler } from '../src/services/gfsUserHomeReconciler.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  error: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}))

vi.mock('pg', () => ({
  Client: class {
    on() {}
    connect = mocks.connect
    query = mocks.query
    end = mocks.end
  },
}))
vi.mock('../src/config.js', () => ({ config: { gfsHomeDrive: 'main' } }))
vi.mock('../src/db.js', () => ({ pool: { options: {} } }))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ error: mocks.error }) },
}))
vi.mock('../src/gfs/userHomeProvisioner.js', () => ({
  provisionUserHome: vi.fn(),
  recordFailedUserHomeAttempt: vi.fn(),
  repairUserHomeOwnerGrant: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.end.mockResolvedValue(undefined)
})

describe('user-home startup repair', () => {
  it.each([1, 2])('retries %i failed startup passes and stops after success', async failures => {
    let failuresRemaining = failures
    let startupQueries = 0
    let completedTicks = 0
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('pg_advisory_unlock')) return { rows: [] }
      if (sql.includes('LEFT JOIN LATERAL')) {
        startupQueries += 1
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new Error('injected startup query failure')
        }
        return { rows: [] }
      }
      if (sql.includes('WITH candidates AS MATERIALIZED')) {
        completedTicks += 1
        return { rows: [] }
      }
      if (sql.includes('FROM gfs_user_homes') && sql.includes("state = 'pending'")) {
        return { rows: [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const worker = new GfsUserHomeReconciler('main', { options: {} } as Pool)

    for (let attempt = 1; attempt <= failures; attempt += 1) {
      await worker.tick()
      expect(startupQueries).toBe(attempt)
      expect(mocks.error).toHaveBeenCalledTimes(attempt)
      expect(mocks.error).toHaveBeenLastCalledWith(
        { event: 'user_home_reconcile_tick_failed' },
        'User-home reconciliation tick failed'
      )
    }
    await worker.tick()
    expect(startupQueries).toBe(failures + 2)
    expect(completedTicks).toBe(1)
    await worker.tick()
    expect(startupQueries).toBe(failures + 2)
    expect(completedTicks).toBe(2)
    expect(mocks.end).toHaveBeenCalledTimes(failures + 2)
  })
})

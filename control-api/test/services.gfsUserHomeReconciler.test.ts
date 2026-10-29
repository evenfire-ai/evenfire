import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { repairUserHomeOwnerGrant } from '../src/gfs/userHomeProvisioner.js'
import {
  GfsUserHomeReconciler,
  STARTUP_OWNER_SQL,
  STARTUP_RETIRED_SQL,
} from '../src/services/gfsUserHomeReconciler.js'

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
  it('retries a failed row on the next tick and stops scanning after success', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    let startupQueries = 0
    vi.mocked(repairUserHomeOwnerGrant)
      .mockRejectedValueOnce(new Error('injected repair failure'))
      .mockResolvedValueOnce(undefined)
    mocks.query.mockImplementation(async (sql: string, values?: string[]) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('pg_advisory_unlock')) return { rows: [] }
      if (sql.includes('LEFT JOIN LATERAL')) {
        startupQueries += 1
        if (sql.includes('FROM gfs_grants') && values?.[0] !== userId) {
          return { rows: [{ user_id: userId, needs_repair: true }] }
        }
        return { rows: [] }
      }
      if (sql.includes('WITH candidates AS MATERIALIZED')) return { rows: [] }
      if (sql.includes("state = 'pending'")) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const worker = new GfsUserHomeReconciler('main', { options: {} } as Pool)

    await worker.tick()
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user_home_startup_repair_failed', userId }),
      'User-home startup repair failed'
    )
    await worker.tick()
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(2)
    const completedQueries = startupQueries
    await worker.tick()
    expect(startupQueries).toBe(completedQueries)
    // The repaired row left the retry set: a third tick repairs nothing.
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(2)
  })

  it('retries only the failed startup row without rescanning', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const startupQueries: string[] = []
    vi.mocked(repairUserHomeOwnerGrant).mockRejectedValue(new Error('injected repair failure'))
    mocks.query.mockImplementation(async (sql: string, values?: string[]) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('pg_advisory_unlock')) return { rows: [] }
      if (sql === STARTUP_RETIRED_SQL) {
        startupQueries.push('retired')
        return { rows: [] }
      }
      if (sql === STARTUP_OWNER_SQL) {
        startupQueries.push('owner')
        return { rows: values?.[0] === userId ? [] : [{ user_id: userId, needs_repair: true }] }
      }
      if (sql.includes('WITH candidates AS MATERIALIZED')) return { rows: [] }
      if (sql.includes("state = 'pending'")) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const worker = new GfsUserHomeReconciler('main', { options: {} } as Pool)

    await worker.tick()
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(1)
    // One full pass: both phases, plus the second page that ends the owner scan.
    const completedScan = [...startupQueries]
    expect(completedScan).toEqual(['retired', 'owner', 'owner'])

    await worker.tick()
    // Witness: the failing row is repaired again, so the skipped scan is not a
    // tick that silently does nothing.
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(2)
    expect(startupQueries).toEqual(completedScan)

    await worker.tick()
    expect(repairUserHomeOwnerGrant).toHaveBeenCalledTimes(3)
    expect(startupQueries).toEqual(completedScan)
  })

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

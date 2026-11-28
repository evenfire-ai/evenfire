import { describe, expect, it } from 'vitest'
import { OPEN_MIGRATION_BUSY_BUDGET_MS, createOpenMigrationBusyRetry } from '../openMigrationBusy'

function busy(code: 'SQLITE_BUSY' | 'SQLITE_BUSY_SNAPSHOT'): Error & { code: string } {
  const error = new Error('database is locked') as Error & { code: string }
  error.code = code
  return error
}

function clockedRetry(budgetMs = OPEN_MIGRATION_BUSY_BUDGET_MS) {
  let clock = 0
  const sleeps: number[] = []
  const retry = createOpenMigrationBusyRetry({
    budgetMs,
    backoffMs: 1_000,
    now: () => clock,
    sleep: ms => {
      sleeps.push(ms)
      clock += ms
    },
  })
  return {
    retry,
    sleeps,
    now: () => clock,
  }
}

describe('open and migration SQLITE_BUSY budget', () => {
  it('returns the first result without sleeping', () => {
    const { retry, sleeps } = clockedRetry()
    expect(retry(() => 'open')).toBe('open')
    expect(sleeps).toEqual([])
  })

  it('retries SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT before 30000 ms with a positive delay', () => {
    const { retry, sleeps, now } = clockedRetry()
    let attempts = 0
    const result = retry(() => {
      attempts += 1
      if (attempts === 1) throw busy('SQLITE_BUSY')
      if (attempts === 2) throw busy('SQLITE_BUSY_SNAPSHOT')
      return 'migrated'
    })
    expect(result).toBe('migrated')
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([1_000, 1_000])
    expect(now()).toBeGreaterThan(0)
    expect(now()).toBeLessThan(OPEN_MIGRATION_BUSY_BUDGET_MS)
  })

  it('throws once 30000 ms have elapsed since the first failure and does not retry at delay 0', () => {
    const { retry, sleeps, now } = clockedRetry()
    let attempts = 0
    expect(() =>
      retry(() => {
        attempts += 1
        throw busy('SQLITE_BUSY')
      })
    ).toThrow(/database is locked/)
    expect(now()).toBe(OPEN_MIGRATION_BUSY_BUDGET_MS)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps.every(ms => ms > 0)).toBe(true)
    expect(attempts).toBe(30)
  })

  it('shares one 30000 ms budget across open and migration', () => {
    const { retry, sleeps, now } = clockedRetry()
    let opened = 0
    const db = retry(() => {
      opened += 1
      if (opened === 1) throw busy('SQLITE_BUSY')
      return 'db'
    })
    expect(db).toBe('db')
    expect(now()).toBe(1_000)

    let migrated = 0
    expect(() =>
      retry(() => {
        migrated += 1
        throw busy('SQLITE_BUSY_SNAPSHOT')
      })
    ).toThrow(/database is locked/)
    expect(now()).toBe(OPEN_MIGRATION_BUSY_BUDGET_MS)
    expect(migrated).toBe(29)
    expect(sleeps.every(ms => ms > 0)).toBe(true)
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(OPEN_MIGRATION_BUSY_BUDGET_MS)
  })

  it('uses the remaining budget as the last positive delay', () => {
    const { retry, sleeps } = clockedRetry(2_500)
    expect(() =>
      retry(() => {
        throw busy('SQLITE_BUSY')
      })
    ).toThrow(/database is locked/)
    expect(sleeps).toEqual([1_000, 1_000, 500])
  })

  it('does not retry a confirmed error other than SQLITE_BUSY or SQLITE_BUSY_SNAPSHOT', () => {
    const { retry, sleeps } = clockedRetry()
    let attempts = 0
    expect(() =>
      retry(() => {
        attempts += 1
        if (attempts === 1) throw busy('SQLITE_BUSY')
        const error = new Error('SQLITE_FULL: database or disk is full') as Error & { code: string }
        error.code = 'SQLITE_CONSTRAINT'
        throw error
      })
    ).toThrow(/SQLITE_FULL/)
    expect(attempts).toBe(2)
    expect(sleeps).toEqual([1_000])
  })
})

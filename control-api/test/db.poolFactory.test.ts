import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakePools = vi.hoisted((): Array<{ config: Record<string, unknown> }> => [])

vi.mock('pg', () => ({
  Pool: class FakePool {
    config: Record<string, unknown>

    constructor(config: Record<string, unknown>) {
      this.config = config
      fakePools.push(this)
    }
  },
}))

describe('core Postgres pool budget', () => {
  beforeEach(() => {
    vi.resetModules()
    fakePools.length = 0
    delete process.env.CORE_POOL_MAX
    delete process.env.CORE_POOL_IDLE_TIMEOUT_MS
    delete process.env.CORE_POOL_CONNECTION_TIMEOUT_MS
    delete process.env.CORE_POOL_STATEMENT_TIMEOUT_MS
    delete process.env.RATE_LIMIT_POOL_MAX
    delete process.env.RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS
    delete process.env.RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS
  })

  it('creates the core pool with explicit bounded connection and statement budgets', async () => {
    process.env.CORE_POOL_MAX = '12'
    process.env.CORE_POOL_IDLE_TIMEOUT_MS = '45000'
    process.env.CORE_POOL_CONNECTION_TIMEOUT_MS = '2500'
    process.env.CORE_POOL_STATEMENT_TIMEOUT_MS = '12000'

    const { createCorePool } = await import('../src/db.js')
    const PoolClass = (await import('pg')).Pool
    createCorePool(PoolClass)

    expect(fakePools.at(-1)?.config).toMatchObject({
      max: 12,
      idleTimeoutMillis: 45_000,
      connectionTimeoutMillis: 2_500,
      statement_timeout: 12_000,
    })
  })

  it('rejects an unbounded pool budget before creating a connection pool', async () => {
    const { createBoundedPgPool } = await import('../src/db.js')
    const PoolClass = (await import('pg')).Pool

    expect(() =>
      createBoundedPgPool(
        {
          max: 65,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 2_000,
          statementTimeoutMillis: 15_000,
        },
        PoolClass
      )
    ).toThrow('Invalid bounded Postgres pool budget: max')
  })
})

describe('rate limiter Postgres pool', () => {
  beforeEach(() => {
    vi.resetModules()
    fakePools.length = 0
    delete process.env.CORE_POOL_MAX
    delete process.env.RATE_LIMIT_POOL_MAX
    delete process.env.RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS
    delete process.env.RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS
  })

  it('builds the limiter pool with 6/5000/3000 and synchronous_commit off, and leaves the core pool untouched', async () => {
    const db = await import('../src/db.js')

    // Module load builds exactly the core pool, then the limiter pool.
    expect(fakePools).toHaveLength(2)
    const [core, limiter] = fakePools.map(p => p.config)
    expect(limiter).toMatchObject({
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 3_000,
      options: '-c synchronous_commit=off',
    })
    expect(db.RATE_LIMIT_POOL_SESSION_OPTIONS).toBe('-c synchronous_commit=off')
    expect(core).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 15_000,
    })
    expect(core).not.toHaveProperty('options')
  })

  it('reads the limiter pool bounds from the environment', async () => {
    process.env.RATE_LIMIT_POOL_MAX = '16'
    process.env.RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS = '100'
    process.env.RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS = '30000'

    const { rateLimitPoolBudget } = await import('../src/db.js')

    expect(rateLimitPoolBudget()).toEqual({
      max: 16,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 100,
      statementTimeoutMillis: 30_000,
    })
  })

  it.each([
    // [env, value, range, pools built before the refusal (core is built first)]
    ['RATE_LIMIT_POOL_MAX', '17', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', '0', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS', '99', '[100, 30000]', 1],
    ['RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS', '30001', '[100, 30000]', 1],
    ['RATE_LIMIT_POOL_MAX', '6.5', '[1, 16]', 1],
    // Number() reads each of these as 6; only canonical decimal is accepted.
    ['RATE_LIMIT_POOL_MAX', '6.0', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', '0x6', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', '6e0', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', ' 6', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', '+6', '[1, 16]', 1],
    ['RATE_LIMIT_POOL_MAX', '06', '[1, 16]', 1],
    ['CORE_POOL_MAX', 'twelve', '[1, 64]', 0],
    ['CORE_POOL_MAX', '65', '[1, 64]', 0],
  ] as const)(
    'refuses %s=%s at startup instead of falling back to the default',
    async (name, value, range, built) => {
      process.env[name] = value

      await expect(import('../src/db.js')).rejects.toThrow(
        `${name} must be an integer in ${range}, got "${value}"`
      )
      // The refusal stops construction at the pool that reads the bad value.
      expect(fakePools).toHaveLength(built)
      delete process.env[name]
    }
  )
})

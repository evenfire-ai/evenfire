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

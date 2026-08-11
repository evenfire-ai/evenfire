import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { withAccessDatabaseTransaction } from '../src/services/access/accessDatabaseQuery.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'
import { catalogQuery } from '../src/services/access/catalogProducerSupport.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('access database cancellation on real PostgreSQL', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: adminUrl })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('cancels an active statement when its request budget is cancelled', async () => {
    const client = (await pool.connect()) as PoolClient
    const budget = AccessExecutionBudget.create('catalog')
    const startedAt = performance.now()
    try {
      const query = catalogQuery(client, budget, 'SELECT pg_sleep(2)', [])
      setTimeout(() => budget.cancel(), 50)
      await expect(query).rejects.toBeInstanceOf(AccessExecutionCancelledError)
      expect(performance.now() - startedAt).toBeLessThan(1_000)
    } finally {
      budget.close()
      client.release()
    }
  })

  it('maps a real statement timeout to authoritative budget exhaustion', async () => {
    const client = (await pool.connect()) as PoolClient
    const budget = AccessExecutionBudget.create('catalog')
    const startedAt = performance.now()
    try {
      await client.query(`SET statement_timeout = '50ms'`)
      await expect(catalogQuery(client, budget, 'SELECT pg_sleep(2)', [])).rejects.toMatchObject({
        name: 'AccessBudgetExceededError',
        limit: 'deadline',
        authorityRequired: true,
      })
      expect(performance.now() - startedAt).toBeLessThan(1_000)
    } finally {
      await client.query(`SET statement_timeout = 0`)
      budget.close()
      client.release()
    }
  })

  it('requires rollback and preserves no transactional writes after timeout', async () => {
    const client = (await pool.connect()) as PoolClient
    const budget = AccessExecutionBudget.create('catalog')
    try {
      await client.query(`CREATE TEMP TABLE access_timeout_rollback(value integer)`)
      await client.query('BEGIN')
      await client.query(`SET LOCAL statement_timeout = '50ms'`)
      await client.query(`INSERT INTO access_timeout_rollback(value) VALUES (1)`)
      await expect(catalogQuery(client, budget, 'SELECT pg_sleep(2)', [])).rejects.toBeInstanceOf(
        AccessBudgetExceededError
      )
      await client.query('ROLLBACK')
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM access_timeout_rollback`
      )
      expect(result.rows).toEqual([{ count: '0' }])
    } finally {
      if (client) await client.query('ROLLBACK').catch(() => undefined)
      budget.close()
      client.release()
    }
  })

  it('owns commit and cancellation rollback under one request budget', async () => {
    const table = `access_budget_transaction_${Date.now()}`
    await pool.query(`CREATE TABLE ${table}(value integer NOT NULL)`)
    const committed = AccessExecutionBudget.create('catalog', { limits: { producerCalls: 1 } })
    try {
      await withAccessDatabaseTransaction(
        committed,
        async db => {
          await db.query(`INSERT INTO ${table}(value) VALUES(1)`)
        },
        { mode: 'read_write', connectionPool: pool }
      )
    } finally {
      committed.close()
    }

    const cancelled = AccessExecutionBudget.create('catalog', { limits: { producerCalls: 2 } })
    try {
      const work = withAccessDatabaseTransaction(
        cancelled,
        async db => {
          await db.query(`INSERT INTO ${table}(value) VALUES(2)`)
          await db.query('SELECT pg_sleep(2)')
        },
        { mode: 'read_write', connectionPool: pool }
      )
      setTimeout(() => cancelled.cancel(), 50)
      await expect(work).rejects.toBeInstanceOf(AccessExecutionCancelledError)
      const values = await pool.query<{ value: number }>(
        `SELECT value FROM ${table} ORDER BY value`
      )
      expect(values.rows).toEqual([{ value: 1 }])
    } finally {
      cancelled.close()
      await pool.query(`DROP TABLE IF EXISTS ${table}`)
    }
  })

  it('cancels a queued pool acquisition without leaking the later client', async () => {
    const constrainedPool = new Pool({ connectionString: adminUrl, max: 1 })
    const heldClient = await constrainedPool.connect()
    let heldReleased = false
    const budget = AccessExecutionBudget.create('action')
    try {
      const startedAt = performance.now()
      const work = withAccessDatabaseTransaction(budget, async db => db.query('SELECT 1'), {
        mode: 'read_only',
        connectionPool: constrainedPool,
      })
      setTimeout(() => budget.cancel(), 50)
      await expect(work).rejects.toBeInstanceOf(AccessExecutionCancelledError)
      expect(performance.now() - startedAt).toBeLessThan(1_000)

      heldClient.release()
      heldReleased = true
      const replacement = await constrainedPool.connect()
      replacement.release()
    } finally {
      if (!heldReleased) heldClient.release()
      budget.close()
      await constrainedPool.end()
    }
  })

  it('bounds the operational index default transaction acquisition', async () => {
    const constrainedPool = new Pool({ connectionString: adminUrl, max: 1 })
    const heldClient = await constrainedPool.connect()
    let heldReleased = false
    const budget = AccessExecutionBudget.create('action')
    const index = new OperationalAccessIndex(constrainedPool)
    try {
      const startedAt = performance.now()
      const work = index.loadSourceStates({
        environmentId: 'test:cluster',
        sourceFamilies: ['host'],
        budget,
      })
      setTimeout(() => budget.cancel(), 50)
      await expect(work).rejects.toBeInstanceOf(AccessExecutionCancelledError)
      expect(performance.now() - startedAt).toBeLessThan(1_000)

      heldClient.release()
      heldReleased = true
      const replacement = await constrainedPool.connect()
      replacement.release()
    } finally {
      if (!heldReleased) heldClient.release()
      budget.close()
      await constrainedPool.end()
    }
  })
})

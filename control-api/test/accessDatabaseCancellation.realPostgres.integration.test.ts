import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import {
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'
import { catalogQuery } from '../src/services/access/catalogProducerSupport.js'

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
})

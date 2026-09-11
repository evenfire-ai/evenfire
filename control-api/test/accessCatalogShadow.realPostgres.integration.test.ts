import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { compareAccessCatalogShadow } from '../src/services/access/accessCatalogShadow.js'
import { runAccessDatabaseQuery } from '../src/services/access/accessDatabaseQuery.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('aggregate shadow physical statement budget on real PostgreSQL', () => {
  const database = `control_api_shadow_budget_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
    await adminPool.end()
  })

  it('executes and charges a real shadow SQL statement only when capacity is reserved', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 8 },
    })
    let statements = 0
    try {
      await expect(
        compareAccessCatalogShadow(
          {
            session: {
              contract: 'v1',
              userId: '10000000-0000-4000-8000-000000000001',
              tokenHash: 'shadow-test',
              issuedAt: 1,
              authGeneration: 1,
            },
            family: 'team',
            legacyLogicalIds: [],
            legacyComplete: true,
          },
          {
            enabled: true,
            budget,
            buildCatalog: async (_input, options) => {
              await runAccessDatabaseQuery(
                {
                  query: async (text, values) => {
                    statements += 1
                    return databasePool.query(text, values)
                  },
                },
                options.budget!,
                'SELECT 1 WHERE $1::int = 1',
                [1],
                { chargeRows: false }
              )
              return {
                contractVersion: '2',
                authorizationRevision: 'shadow',
                sourceStateRevision: 'shadow',
                complete: true,
                partialErrors: [],
                items: [],
                nextCursor: null,
              }
            },
          }
        )
      ).resolves.toBe('match')
      expect(statements).toBe(1)
      expect(budget.remaining('databaseStatements')).toBe(7)
    } finally {
      budget.close()
    }
  })
})

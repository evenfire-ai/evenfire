import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogOperationalSourceState,
  type CatalogRequestContext,
  catalogKey,
} from '../src/services/access/catalogContracts.js'
import { requireCatalogProducer } from '../src/services/access/catalogProducers.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  canonicalEnvironmentId,
} from '../src/services/access/operationalAccessProjection.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('catalog producer SQL on real PostgreSQL', () => {
  const database = `control_api_catalog_producer_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('parses and executes every bounded key and selected-ID hydration query', async () => {
    const budget = AccessExecutionBudget.create('catalog')
    const sourceStates: CatalogOperationalSourceState[] = OPERATIONAL_SOURCE_FAMILIES.map(
      family => ({
        family,
        generation: '1',
        resourceVersion: '1',
        status: 'current',
      })
    )
    const context: CatalogRequestContext = {
      db: databasePool,
      budget,
      principal: {
        userId,
        sessionContract: 'v2',
        sessionRevision: '1',
        userRevision: '1',
        catalogRevision: '1',
        authorizationRevision: 'catalog-authorization-1',
        memberships: [],
      },
      environmentId,
      sourceStates: new Map(sourceStates.map(state => [state.family, state])),
    }
    const logicalId: Record<CatalogFamily, string> = {
      user: userId,
      team: randomUUID(),
      host: `${config.hostsNamespace}/host-a`,
      context: `${config.contextsNamespace}/context-a`,
      mcp_server: `${config.mcpServersNamespace}/server-a`,
      workflow_recipe: `${config.sandboxNamespace}/recipe-a`,
      workflow_run: randomUUID(),
      workflow_approval: randomUUID(),
      notification: randomUUID(),
      gfs_resource: randomUUID(),
      shared_filesystem: `${config.sharedFilesystemsNamespace}/filesystem-a`,
      sandbox_app: `${config.sandboxNamespace}/recipe-a`,
    }

    try {
      for (const family of CATALOG_FAMILIES) {
        const producer = requireCatalogProducer(family)
        try {
          const page = await producer.listCanonicalKeys(
            context,
            { afterKey: null, exhausted: false },
            2
          )
          expect(page.candidates).toEqual([])
          await expect(
            producer.hydrateCanonicalKeys(context, [
              catalogKey(environmentId, family, logicalId[family]),
            ])
          ).resolves.toEqual([])
        } catch (error) {
          throw new Error(`Producer ${family} failed`, { cause: error })
        }
      }
    } finally {
      budget.close()
    }
  })
})

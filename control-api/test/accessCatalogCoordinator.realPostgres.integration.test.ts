import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import {
  AccessCatalogRequestError,
  buildAccessCatalog,
} from '../src/services/access/accessCatalogCoordinator.js'
import {
  AccessCatalogCursorError,
  decodeAccessCatalogCursor,
} from '../src/services/access/accessCatalogCursor.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
} from '../src/services/access/accessExecutionBudget.js'
import {
  type CatalogOperationalSourceState,
  type CatalogRequestContext,
  catalogKey,
} from '../src/services/access/catalogContracts.js'
import { requireCatalogProducer } from '../src/services/access/catalogProducers.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  type OperationalSourceFamily,
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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

function transaction(pool: Pool) {
  return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await pool.connect()) as PoolClient
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

describeRealPostgres('aggregate catalog coordinator on real PostgreSQL', () => {
  const database = `control_api_catalog_coordinator_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const teamIds = [randomUUID(), randomUUID()].sort()
  const session: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
    authGeneration: 1,
  }
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog User')`, [
      userId,
      `${userId}@example.test`,
    ])
    for (const [index, teamId] of teamIds.entries()) {
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `Team ${index + 1}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')`,
        [teamId, userId, index === 0 ? 'admin' : 'member']
      )
    }
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('composes keyset pages and emits access paths that re-resolve live', async () => {
    const first = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 2 },
      { transaction: transaction(databasePool) }
    )

    expect(first.complete).toBe(true)
    expect(first.items.map(item => item.resource.logicalId)).toEqual(teamIds)
    expect(first.nextCursor).toEqual(expect.stringMatching(/^c3\./))
    const firstPath = first.items[0].accessPaths[0]
    const resolved = await resolveLiveAuthorization(
      {
        session,
        requiredCapability: 'team.read',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'team',
          logicalId: teamIds[0],
        }),
        requestedAccessPathId: firstPath.accessPathId,
      },
      { transaction: transaction(databasePool) }
    )
    expect(resolved).toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: firstPath.accessPathId }),
      })
    )

    const second = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 2, cursor: first.nextCursor },
      { transaction: transaction(databasePool) }
    )
    expect(second.items.map(item => item.resource.logicalId)).toEqual([userId])
    expect(second.nextCursor).toBeNull()
  })

  it('rejects a cursor after a live membership revision changes', async () => {
    const page = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 1 },
      { transaction: transaction(databasePool) }
    )
    expect(page.nextCursor).not.toBeNull()
    await databasePool.query(
      `UPDATE team_members SET role = 'inviter', updated_at = NOW()
        WHERE team_id = $1 AND user_id = $2`,
      [teamIds[0], userId]
    )

    await expect(
      buildAccessCatalog(
        { session, families: ['user', 'team'], limit: 1, cursor: page.nextCursor },
        { transaction: transaction(databasePool) }
      )
    ).rejects.toBeInstanceOf(AccessCatalogCursorError)
  })

  it('signs a complete per-producer continuation vector', async () => {
    const page = await buildAccessCatalog(
      { session, families: ['team'], limit: 1 },
      { transaction: transaction(databasePool) }
    )
    const budget = AccessExecutionBudget.create('catalog')
    try {
      const cursor = decodeAccessCatalogCursor(page.nextCursor!, budget)
      expect(Object.keys(cursor.producers)).toHaveLength(12)
      expect(cursor.producers.team.afterKey?.[1]).toBe('team')
      expect(cursor.producers.host).toEqual({ afterKey: null, exhausted: true })
    } finally {
      budget.close()
    }
  })

  it('keeps missing and ambiguous configured Context references root-local and advances cursors', async () => {
    const suffix = randomBytes(5).toString('hex')
    const names = {
      missing: `a-missing-${suffix}`,
      ambiguous: `b-ambiguous-${suffix}`,
      canonical: `c-canonical-${suffix}`,
      alias: `d-alias-${suffix}`,
      contextFree: `e-context-free-${suffix}`,
    }
    const hostNamespace = config.hostsNamespace
    const contextNamespace = config.contextsNamespace
    const aliasName = `wire-${suffix}`
    const ambiguousAlias = `collision-${suffix}`
    const projection = (
      kind: 'hosts' | 'contexts',
      name: string,
      spec: Record<string, unknown>
    ) => {
      const namespace = kind === 'hosts' ? hostNamespace : contextNamespace
      return projectOperationalObject({
        environmentId,
        plural: kind,
        namespace,
        behaviorFingerprintKey: 'catalog-integrity-test-key',
        relationshipNamespaces: {
          context: contextNamespace,
          mcpServer: config.mcpServersNamespace,
          sharedFilesystem: config.sharedFilesystemsNamespace,
        },
        object: {
          apiVersion: 'clerum.io/v1alpha1',
          kind: kind === 'hosts' ? 'Host' : 'Context',
          metadata: {
            name,
            namespace,
            uid: randomUUID(),
            resourceVersion: '1',
            generation: 1,
          },
          spec: { enabled: true, ...spec },
        },
      })
    }
    const contextProjections = [
      projection('contexts', `canonical-${suffix}`, { mcpServers: [], sharedFileSystems: [] }),
      projection('contexts', `alias-source-${suffix}`, {
        contextId: aliasName,
        mcpServers: [],
        sharedFileSystems: [],
      }),
      projection('contexts', `ambiguous-one-${suffix}`, {
        contextId: ambiguousAlias,
        mcpServers: [],
        sharedFileSystems: [],
      }),
      projection('contexts', `ambiguous-two-${suffix}`, {
        contextId: ambiguousAlias,
        mcpServers: [],
        sharedFileSystems: [],
      }),
    ]
    const hostProjections = [
      projection('hosts', names.missing, { contextRef: `missing-${suffix}` }),
      projection('hosts', names.ambiguous, { contextRef: ambiguousAlias }),
      projection('hosts', names.canonical, { contextRef: `canonical-${suffix}` }),
      projection('hosts', names.alias, { contextRef: aliasName }),
      projection('hosts', names.contextFree, {}),
    ]
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name)
       SELECT $1, agent_name FROM UNNEST($2::text[]) AS requested(agent_name)`,
      [userId, Object.values(names)]
    )

    const index = new OperationalAccessIndex(databasePool, transaction(databasePool))
    for (const [sourceFamily, projections] of [
      ['context', contextProjections],
      ['host', hostProjections],
      ['mcp_server', []],
      ['shared_filesystem', []],
    ] as const) {
      const indexBudget = AccessExecutionBudget.create('indexer')
      try {
        const stagingGeneration = await index.beginRelist({
          environmentId,
          sourceFamily,
          budget: indexBudget,
        })
        await index.stageRelistPage({
          environmentId,
          sourceFamily,
          stagingGeneration,
          projections,
          budget: indexBudget,
        })
        await index.promoteRelist({
          environmentId,
          sourceFamily,
          stagingGeneration,
          resourceVersion: '1',
          budget: indexBudget,
        })
      } finally {
        indexBudget.close()
      }
    }

    let queryCount = 0
    const measuredTransaction = <T>(work: (db: DbClient) => Promise<T>) =>
      transaction(databasePool)(db =>
        work({
          query: (text, values) => {
            queryCount += 1
            return db.query(text, values)
          },
        })
      )
    const completePage = await buildAccessCatalog(
      { session, families: ['user', 'host'], limit: 100 },
      { transaction: measuredTransaction }
    )

    expect(completePage.complete).toBe(false)
    expect(completePage.partialErrors).toEqual([
      { producer: 'host', code: 'operational_source_unavailable', retryable: true },
    ])
    const itemIds = completePage.items.map(item => item.resource.logicalId)
    expect(itemIds).toContain(userId)
    expect(itemIds).toContain(`${hostNamespace}/${names.canonical}`)
    expect(itemIds).toContain(`${hostNamespace}/${names.alias}`)
    expect(itemIds).toContain(`${hostNamespace}/${names.contextFree}`)
    expect(itemIds).not.toContain(`${hostNamespace}/${names.missing}`)
    expect(itemIds).not.toContain(`${hostNamespace}/${names.ambiguous}`)
    expect(JSON.stringify(completePage)).not.toMatch(/configured_context_(missing|ambiguous)/u)

    const producerBudget = AccessExecutionBudget.create('catalog')
    try {
      const sourceStateResult = await databasePool.query(
        `SELECT source_family, generation, resource_version, status
           FROM operational_catalog_source_state
          WHERE environment_id = $1`,
        [environmentId]
      )
      const sourceStates: CatalogRequestContext['sourceStates'] = new Map(
        (sourceStateResult.rows as Record<string, unknown>[]).map(row => {
          const family = String(row.source_family) as OperationalSourceFamily
          return [
            family,
            Object.freeze({
              family,
              generation: String(row.generation),
              resourceVersion:
                row.resource_version === null || row.resource_version === undefined
                  ? null
                  : String(row.resource_version),
              status: String(row.status) as CatalogOperationalSourceState['status'],
            }),
          ] as const
        })
      )
      const producerContext: CatalogRequestContext = {
        db: databasePool,
        budget: producerBudget,
        principal: {
          userId,
          sessionContract: 'v1',
          sessionRevision: '1',
          userRevision: '1',
          authorizationRevision: 'producer-context-integrity',
          memberships: [],
        },
        environmentId,
        sourceStates,
      }
      const producerResult = await requireCatalogProducer('host').hydrateCanonicalKeys(
        producerContext,
        [
          catalogKey(environmentId, 'host', `${hostNamespace}/${names.missing}`),
          catalogKey(environmentId, 'host', `${hostNamespace}/${names.ambiguous}`),
        ]
      )
      expect(Array.isArray(producerResult)).toBe(false)
      const integrity = producerResult as unknown as {
        resources: readonly unknown[]
        incompleteRoots: readonly Readonly<{ key: readonly string[]; reason: string }>[]
      }
      expect(integrity.resources).toEqual([])
      expect(integrity.incompleteRoots).toEqual([
        {
          key: catalogKey(environmentId, 'host', `${hostNamespace}/${names.missing}`),
          reason: 'configured_context_missing',
        },
        {
          key: catalogKey(environmentId, 'host', `${hostNamespace}/${names.ambiguous}`),
          reason: 'configured_context_ambiguous',
        },
      ])
    } finally {
      producerBudget.close()
    }

    queryCount = 0
    await buildAccessCatalog(
      { session, families: ['host'], limit: 100 },
      { transaction: measuredTransaction }
    )
    const multiRootQueryCount = queryCount

    queryCount = 0
    const firstHostPage = await buildAccessCatalog(
      { session, families: ['host'], limit: 1 },
      { transaction: measuredTransaction }
    )
    expect(firstHostPage.items).toEqual([])
    expect(firstHostPage.complete).toBe(false)
    expect(firstHostPage.nextCursor).not.toBeNull()
    const cursorBudget = AccessExecutionBudget.create('catalog')
    try {
      const cursor = decodeAccessCatalogCursor(firstHostPage.nextCursor!, cursorBudget)
      expect(cursor.lastCanonicalKey).toEqual([
        environmentId,
        'host',
        `${hostNamespace}/${names.missing}`,
      ])
    } finally {
      cursorBudget.close()
    }
    const firstPageQueryCount = queryCount

    queryCount = 0
    const oneHostPage = await buildAccessCatalog(
      { session, families: ['host'], limit: 1, cursor: firstHostPage.nextCursor },
      { transaction: measuredTransaction }
    )
    expect(oneHostPage.items).toEqual([])
    expect(oneHostPage.nextCursor).not.toBe(firstHostPage.nextCursor)
    expect(queryCount).toBe(firstPageQueryCount)
    // Context-bearing roots add one shared policy snapshot query, not one query per root.
    expect(multiRootQueryCount).toBe(firstPageQueryCount + 1)

    await expect(
      buildAccessCatalog(
        { session, families: ['host'], limit: 100 },
        {
          transaction: transaction(databasePool),
          limits: { decodedBytes: 1 },
        }
      )
    ).rejects.toBeInstanceOf(AccessBudgetExceededError)

    await expect(
      buildAccessCatalog(
        { session: { ...session, userId: randomUUID() }, families: ['user', 'host'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<AccessCatalogRequestError>>({
        code: 'authority_unavailable',
      })
    )
  })
})

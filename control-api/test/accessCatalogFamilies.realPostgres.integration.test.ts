import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import type { AccessCapability } from '../src/services/access/capabilityRegistry.js'
import { CATALOG_FAMILIES, type CatalogFamily } from '../src/services/access/catalogContracts.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'

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

type OperationalFixture = Readonly<{
  plural: 'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
  namespace: string
  object: Readonly<Record<string, unknown>>
}>

function fixture(input: {
  plural: OperationalFixture['plural']
  namespace: string
  name: string
  uid: string
  spec?: Readonly<Record<string, unknown>>
}): OperationalFixture {
  return Object.freeze({
    plural: input.plural,
    namespace: input.namespace,
    object: Object.freeze({
      metadata: Object.freeze({
        name: input.name,
        namespace: input.namespace,
        uid: input.uid,
        resourceVersion: '1',
        generation: 1,
      }),
      spec: Object.freeze({ enabled: true, ...(input.spec ?? {}) }),
    }),
  })
}

describeRealPostgres('all aggregate catalog families on real producers', () => {
  const database = `control_api_catalog_families_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const teamId = randomUUID()
  const directRunId = randomUUID()
  const teamRunId = randomUUID()
  const directApprovalId = randomUUID()
  const teamApprovalId = randomUUID()
  const directNotificationId = randomUUID()
  const teamNotificationId = randomUUID()
  const gfsResourceId = randomUUID()
  const session: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
  }
  const operationalFixtures: readonly OperationalFixture[] = [
    fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'catalog-host',
      uid: 'catalog-host-uid',
      spec: {
        contextRef: 'catalog-context',
        model: { provider: 'openai', name: 'test-model' },
      },
    }),
    fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: 'catalog-context',
      uid: 'catalog-context-uid',
      spec: {
        mcpServers: ['catalog-mcp'],
        sharedFileSystems: [
          { name: 'catalog-files', mountPath: '/workspace/a' },
          { name: 'catalog-files', mountPath: '/workspace/b' },
        ],
      },
    }),
    fixture({
      plural: 'mcpservers',
      namespace: config.mcpServersNamespace,
      name: 'catalog-mcp',
      uid: 'catalog-mcp-uid',
    }),
    fixture({
      plural: 'workflowrecipes',
      namespace: config.sandboxNamespace,
      name: 'catalog-recipe',
      uid: 'catalog-recipe-uid',
      spec: {
        contextRef: 'catalog-context',
        runtimeEgress: ['example.test'],
        ui: {
          workloadRef: 'catalog-app',
          port: 8080,
          title: 'Catalog App',
          defaultPath: '/',
        },
      },
    }),
    fixture({
      plural: 'sharedfilesystems',
      namespace: config.sharedFilesystemsNamespace,
      name: 'catalog-files',
      uid: 'catalog-files-uid',
    }),
  ]
  const exactObjects = new Map(
    operationalFixtures.map(value => {
      const metadata = value.object.metadata as { name: string }
      return [`${value.plural}:${value.namespace}/${metadata.name}`, value.object]
    })
  )
  const gateway = {
    getResourceExact: async (plural: string, name: string, namespace: string) => {
      const value = exactObjects.get(`${plural}:${namespace}/${name}`)
      if (!value) throw Object.assign(new Error('not found'), { httpStatus: 404 })
      return value
    },
  } as unknown as Pick<K8sGateway, 'getResourceExact'>
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })

    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog Harness User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Catalog Harness Team')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'catalog-host')`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, 'catalog-host')`,
      [teamId]
    )
    await databasePool.query(
      `INSERT INTO user_contexts(user_id, context_id) VALUES ($1, 'catalog-context')`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, 'catalog-context')`,
      [teamId]
    )
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, 'catalog-recipe')`,
      [userId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, 'catalog-recipe')`,
      [teamId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO workflow_runs(
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
         team_id, trigger_source
       ) VALUES
         ($1, $5, 'catalog-recipe', 'Succeeded', 'user', $3, NULL, 'onDemand'),
         ($2, $5, 'catalog-recipe', 'Succeeded', 'user', $3, $4, 'onDemand')`,
      [directRunId, teamRunId, userId, teamId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_user_id,
         target_team_id, payload, idempotency_key, payload_hash
       ) VALUES
         ($1, $5, 'catalog-recipe', NOW() + INTERVAL '1 hour', 'pending', $3, NULL,
          '{}'::jsonb, $6, 'hash'),
         ($2, $5, 'catalog-recipe', NOW() + INTERVAL '1 hour', 'pending', NULL, $4,
          '{}'::jsonb, $7, 'hash')`,
      [
        directApprovalId,
        teamApprovalId,
        userId,
        teamId,
        config.sandboxNamespace,
        `direct-${directApprovalId}`,
        `team-${teamApprovalId}`,
      ]
    )
    await databasePool.query(
      `INSERT INTO notification_deliveries(
         id, event_type, dedupe_key, audience, payload, status, expires_at
       ) VALUES
         ($1, 'catalog.direct', $3, jsonb_build_object('userId', $5::text),
          '{}'::jsonb, 'queued', NOW() + INTERVAL '1 hour'),
         ($2, 'catalog.team', $4, jsonb_build_object('teamId', $6::text),
          '{}'::jsonb, 'queued', NOW() + INTERVAL '1 hour')`,
      [
        directNotificationId,
        teamNotificationId,
        `direct-${directNotificationId}`,
        `team-${teamNotificationId}`,
        userId,
        teamId,
      ]
    )
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, 'catalog-drive', '/', 'directory')`,
      [gfsResourceId]
    )
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES
         ('catalog-drive', $1, 'user', $2::text, ARRAY['read']::text[]),
         ('catalog-drive', $1, 'team', $3::text, ARRAY['read']::text[])`,
      [gfsResourceId, userId, teamId]
    )

    const index = new OperationalAccessIndex(databasePool, transaction(databasePool))
    for (const sourceFamily of OPERATIONAL_SOURCE_FAMILIES) {
      const fixtureForFamily = operationalFixtures.find(value => {
        const expected = {
          host: 'hosts',
          context: 'contexts',
          mcp_server: 'mcpservers',
          workflow_recipe: 'workflowrecipes',
          shared_filesystem: 'sharedfilesystems',
        } as const
        return value.plural === expected[sourceFamily]
      })!
      const projection = projectOperationalObject({
        environmentId,
        plural: fixtureForFamily.plural,
        namespace: fixtureForFamily.namespace,
        object: fixtureForFamily.object,
        behaviorFingerprintKey: config.sessionJwtPrivateKey,
        relationshipNamespaces: {
          context: config.contextsNamespace,
          mcpServer: config.mcpServersNamespace,
          sharedFilesystem: config.sharedFilesystemsNamespace,
        },
      })
      const budget = AccessExecutionBudget.create('catalog')
      try {
        const generation = await index.beginRelist({ environmentId, sourceFamily, budget })
        await index.stageRelistPage({
          environmentId,
          sourceFamily,
          stagingGeneration: generation,
          projections: [projection],
          budget,
        })
        await index.promoteRelist({
          environmentId,
          sourceFamily,
          stagingGeneration: generation,
          resourceVersion: '1',
          budget,
        })
      } finally {
        budget.close()
      }
    }
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

  const expectedItemCounts: Readonly<Record<CatalogFamily, number>> = Object.freeze({
    user: 1,
    team: 1,
    host: 1,
    context: 1,
    mcp_server: 1,
    workflow_recipe: 1,
    workflow_run: 2,
    workflow_approval: 2,
    notification: 2,
    gfs_resource: 1,
    shared_filesystem: 1,
    sandbox_app: 1,
  })
  const capability: Readonly<Record<CatalogFamily, AccessCapability>> = Object.freeze({
    user: 'user.profile.read',
    team: 'team.read',
    host: 'host.read',
    context: 'context.read',
    mcp_server: 'mcp_server.read',
    workflow_recipe: 'workflow.read',
    workflow_run: 'workflow.read',
    workflow_approval: 'workflow.approval.decide',
    notification: 'notification.read',
    gfs_resource: 'gfs.read',
    shared_filesystem: 'shared_filesystem.read',
    sandbox_app: 'sandbox_app.read',
  })
  const expectedKinds: Readonly<Record<CatalogFamily, readonly ('direct' | 'team')[]>> =
    Object.freeze({
      user: ['direct'],
      team: ['team'],
      host: ['direct', 'team'],
      context: ['direct', 'team'],
      mcp_server: ['direct', 'team'],
      workflow_recipe: ['direct', 'team'],
      workflow_run: ['direct', 'team'],
      workflow_approval: ['direct', 'team'],
      notification: ['direct', 'team'],
      gfs_resource: ['direct', 'team'],
      shared_filesystem: ['direct', 'team'],
      sandbox_app: ['direct', 'team'],
    })

  for (const family of CATALOG_FAMILIES) {
    it(`${family} producer paths round-trip through catalog and live resolution`, async () => {
      const catalog = await buildAccessCatalog(
        { session, families: [family], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(catalog.complete).toBe(true)
      expect(catalog.partialErrors).toEqual([])
      expect(catalog.nextCursor).toBeNull()
      expect(catalog.items).toHaveLength(expectedItemCounts[family])
      expect(
        [...new Set(catalog.items.flatMap(item => item.accessPaths.map(path => path.kind)))].sort()
      ).toEqual([...expectedKinds[family]].sort())

      for (const item of catalog.items) {
        expect(item.resource.type).toBe(family)
        expect(item.accessPaths.length).toBeGreaterThan(0)
        for (const path of item.accessPaths) {
          const resolved = await resolveLiveAuthorization(
            {
              session,
              requiredCapability: capability[family],
              resource: canonicalResourceIdentity(item.resource),
              requestedAccessPathId: path.accessPathId,
              ...(family === 'workflow_approval'
                ? {
                    operationTarget: {
                      approvalId: item.resource.logicalId,
                      decision: 'approve',
                    },
                  }
                : {}),
            },
            {
              transaction: transaction(databasePool),
              gateway,
            }
          )
          expect(resolved).toEqual(
            expect.objectContaining({
              status: 'allowed',
              selectedPath: expect.objectContaining({ id: path.accessPathId }),
            })
          )
        }
      }
    })
  }

  it('preserves both direct/team provenance across duplicate filesystem mounts', async () => {
    const catalog = await buildAccessCatalog(
      { session, families: ['shared_filesystem'], limit: 100 },
      { transaction: transaction(databasePool) }
    )
    const item = catalog.items[0]
    expect(
      item.relationships.filter(value => value.type === 'mounts_shared_filesystem')
    ).toHaveLength(2)
    expect(item.accessPaths).toHaveLength(4)
    expect(new Set(item.accessPaths.map(path => path.accessPathId)).size).toBe(4)
    expect(
      new Set(
        item.accessPaths.map(path => JSON.stringify(path.behaviorDescriptors.filesystemScope))
      ).size
    ).toBe(2)
  })
})
